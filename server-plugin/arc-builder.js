// Path 1 arc builder — structural arc discovery via Louvain community
// detection on a weighted event graph. See RESEARCH_ARCS.md §5 Path 1.
//
// Entry point: rebuildArcsForChat(settings, chatId, opts?)
//
// This runs post-ingest (after /ingest-chat finishes its batch loop) and is
// intentionally *not* wired into /extract — per-batch re-clustering defeats
// the point of building arcs over the full chat's events. Phase 2 incremental
// updates (RESEARCH_ARCS.md §6) are explicitly out of scope for Path 1.

const Graph = require("graphology");
const louvain = require("graphology-communities-louvain");
const db = require("./db");

// Starting weights from the research doc. Exposed as a named module-level
// constant so Path 2's eval harness can import and sweep them.
//   WC — causal chain edge (strongest signal, 1.0)
//   WE — cosine similarity of event embeddings
//   WP — Jaccard similarity of participant sets
//   WL — same location bonus
//   WT — temporal distance penalty (subtracted)
//   PRUNE — minimum edge weight to keep in the graph
//
// These are Path 2's grid-sweep winner (scripts/eval-arcs.js, config hash
// 2c7620ef) on the Protagonist 2025-11-18 eval chat: 10 arcs, avgEv=44.4, Q=0.779
// vs the 3 arcs / Q=0.076 produced by the Path 1 informed-guess starter.
// Low WC + low WP + jaccFloor=0.4 recenters the participant signal past its
// 2-3-character baseline; high WT=1.0 + resolution=0.5 prevent the bell-curve
// cosine signal from dominating into topic clusters.
const DEFAULT_WEIGHTS = { WC: 0.5, WE: 0.6, WP: 0.2, WL: 0.4, WT: 1.0, PRUNE: 0.5 };

// Tiny-community floor. Communities with fewer than MIN_ARC_SIZE events are
// pruned rather than emitted as arcs. 3 events is the research doc's default.
const MIN_ARC_SIZE = 3;

// Deterministic RNG seed for Louvain so rebuilds are reproducible.
const DEFAULT_SEED = 42;

// Louvain resolution γ. γ > 1 favors more, smaller communities; γ < 1 favors
// fewer, larger ones. Path 2's winner (hash 2c7620ef) uses γ=0.5, which
// produces ~10 clean narrative arcs on the Protagonist eval chat vs the 3
// mega-clusters Louvain finds at γ=1.0 with the same weight kernel.
const DEFAULT_RESOLUTION = 0.5;

// "Recentered signal" floors. The diagnostic on the Protagonist eval chat showed
// that raw cosine lives on a bell curve centered ~0.69 (p10=0.59, p90=0.77)
// and raw Jaccard bottoms at 0.4 for half the pairs in a 2-3 character chat.
// Path 2's sweep confirmed cosFloor=0 (raw cosine is fine) but jaccFloor=0.4
// is critical — it subtracts out the character-baseline so only exceptional
// participant overlap contributes edge weight.
const DEFAULT_COS_FLOOR = 0;
const DEFAULT_JACC_FLOOR = 0.4;

// Path 4 density-proxy gate for LLM arc naming. We use cluster density rather
// than per-community modularity contribution because graphology-communities-
// louvain exposes only the aggregate Q, not per-community terms, and folding
// the Σ(a_ii − e_ii²) summation ourselves is more code than the whole naming
// helper. Density ≥ 1.5 means "this cluster has ≥1.5× the intra-community
// edges you'd expect from a random partition of the same size" — a cheap,
// well-behaved proxy that correlates strongly with per-community modularity
// contribution on sparse graphs. See RESEARCH_ARCS.md §5 Path 4 "Caveats".
const DEFAULT_ARC_NAMING_DENSITY_GATE = 1.5;

module.exports = {
  rebuildArcsForChat,
  DEFAULT_WEIGHTS,
  MIN_ARC_SIZE,
  DEFAULT_RESOLUTION,
  DEFAULT_COS_FLOOR,
  DEFAULT_JACC_FLOOR,
  DEFAULT_ARC_NAMING_DENSITY_GATE,
};

// ── Embedding helpers ─────────────────────────────────────────────
//
// pgvector returns vector columns via pg's default text coercion as strings
// like "[0.1,0.2,...]". Parse to Float32Array and cache norms for the cosine
// inner loop.

function parseEmbedding(raw) {
  if (raw == null) return null;
  if (raw instanceof Float32Array) return raw;
  if (Array.isArray(raw)) return Float32Array.from(raw);
  if (typeof raw !== "string") return null;
  // pgvector text form: "[x,y,z]"
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const inner = trimmed.startsWith("[") ? trimmed.slice(1, -1) : trimmed;
  if (!inner) return null;
  const parts = inner.split(",");
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const v = parseFloat(parts[i]);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

function vectorNorm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  return Math.sqrt(s);
}

function cosineSim(a, b, normA, normB) {
  if (!a || !b || a.length !== b.length) return 0;
  const denom = normA * normB;
  if (denom === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / denom;
}

function jaccard(aSet, bSet) {
  if (!aSet || !bSet || aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const uni = aSet.size + bSet.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Rebuild the story_arcs + arc_events rows for a chat by clustering its
 * events with Louvain on a weighted graph (cosine + Jaccard + location +
 * temporal gap + causal chains). Drops and rebuilds in a single transaction.
 *
 * @param {object} settings - plugin settings, used by db.getPool
 * @param {string} chatId - chat id to rebuild
 * @param {object} [opts]
 * @param {object} [opts.weights] - override DEFAULT_WEIGHTS
 * @param {number} [opts.minArcSize] - override MIN_ARC_SIZE
 * @param {boolean} [opts.dryRun] - if true, skip all writes and return the
 *                                  computed partition summary instead
 * @param {number}  [opts.seed] - RNG seed for Louvain determinism
 * @param {number}  [opts.resolution] - Louvain γ resolution (default 1.0).
 *                                      Higher γ → more, smaller communities.
 * @param {number}  [opts.cosFloor] - subtract this from raw cosine before
 *                                    multiplying by WE; clamped at 0. Default 0.
 * @param {number}  [opts.jaccFloor] - subtract this from raw Jaccard before
 *                                     multiplying by WP; clamped at 0. Default 0.
 * @param {boolean} [opts.nameArcs] - Path 4: opt into LLM-generated titles +
 *                                    descriptions, gated on cluster density.
 *                                    Default false so eval harnesses don't
 *                                    blow LLM budget on every grid iteration.
 *                                    /ingest-chat wires this to true.
 * @param {number}  [opts.densityGate] - override DEFAULT_ARC_NAMING_DENSITY_GATE.
 *                                       Ignored unless nameArcs is true.
 * @returns {Promise<{builtArcs:number, prunedArcs:number, totalEvents:number, modularityQ:number, namedArcs?:number, templatedArcs?:number, communities?:Array}>}
 */
async function rebuildArcsForChat(settings, chatId, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const minArcSize = opts.minArcSize ?? MIN_ARC_SIZE;
  const seed = opts.seed ?? DEFAULT_SEED;
  const resolution = Number.isFinite(opts.resolution) ? opts.resolution : DEFAULT_RESOLUTION;
  const cosFloor = Number.isFinite(opts.cosFloor) ? opts.cosFloor : DEFAULT_COS_FLOOR;
  const jaccFloor = Number.isFinite(opts.jaccFloor) ? opts.jaccFloor : DEFAULT_JACC_FLOOR;
  const dryRun = Boolean(opts.dryRun);
  const nameArcs = Boolean(opts.nameArcs);
  const densityGate = Number.isFinite(opts.densityGate)
    ? opts.densityGate
    : DEFAULT_ARC_NAMING_DENSITY_GATE;

  const p = db.getPool(settings);

  // 1. Load events with embeddings, ordered by message_index.
  const { rows: events } = await p.query(
    `SELECT id, summary, message_index, location_id, significance, embedding
     FROM events
     WHERE chat_id = $1
     ORDER BY message_index ASC NULLS LAST, id ASC`,
    [chatId],
  );

  // Bail early on degenerate cases. 3-event clustering is noise.
  if (events.length < 4) {
    return { builtArcs: 0, prunedArcs: 0, totalEvents: events.length, modularityQ: 0 };
  }

  // Parse embeddings once, cache norms.
  const parsedEmbeddings = new Array(events.length);
  const norms = new Array(events.length);
  for (let i = 0; i < events.length; i++) {
    const vec = parseEmbedding(events[i].embedding);
    parsedEmbeddings[i] = vec;
    norms[i] = vec ? vectorNorm(vec) : 0;
  }

  const eventIds = events.map((e) => e.id);

  // 2. Load participation bipartite edges (character_id per event).
  const { rows: partRows } = await p.query(
    `SELECT event_id, character_id FROM participated_in
     WHERE event_id = ANY($1::text[])`,
    [eventIds],
  );
  const participants = new Map();
  for (const pr of partRows) {
    let set = participants.get(pr.event_id);
    if (!set) {
      set = new Set();
      participants.set(pr.event_id, set);
    }
    set.add(pr.character_id);
  }

  // 3. Load event_chains, collapse to an undirected edge key-set.
  const { rows: chainRows } = await p.query(
    `SELECT from_event_id, to_event_id FROM event_chains
     WHERE from_event_id = ANY($1::text[]) OR to_event_id = ANY($1::text[])`,
    [eventIds],
  );
  const chainSet = new Set();
  for (const cr of chainRows) {
    const a = cr.from_event_id;
    const b = cr.to_event_id;
    if (!a || !b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    chainSet.add(`${lo}|${hi}`);
  }

  // Temporal normalization: divide (message_index delta) by the chat's span
  // so the penalty is ∈ [0, 1]. Guard against zero-span chats.
  const msgIndices = events.map((e) => e.message_index ?? 0);
  const minIdx = Math.min(...msgIndices);
  const maxIdx = Math.max(...msgIndices);
  const maxGap = Math.max(1, maxIdx - minIdx);

  // 4. Build the weighted undirected graph.
  const g = new Graph({ type: "undirected", allowSelfLoops: false });
  for (const e of events) {
    g.addNode(e.id, {
      msgIdx: e.message_index,
      locId: e.location_id,
      sig: e.significance,
    });
  }

  const { WC, WE, WP, WL, WT, PRUNE } = weights;

  // O(N²) is fine — 449 events → ~100K cells, milliseconds in Node.
  //
  // Note on floors: `cosFloor` and `jaccFloor` implement the "recentered
  // signal" variant. Subtracting a baseline ≈ signal median before weighting
  // turns a bell-curve-centered signal (raw cosine lives ~[0.5, 0.85]) into
  // a discriminative one. Clamped at 0 so negative contributions don't leak
  // through and flip the edge sign.
  for (let i = 0; i < events.length; i++) {
    const a = events[i];
    const aEmb = parsedEmbeddings[i];
    const aNorm = norms[i];
    const aParts = participants.get(a.id) || null;
    const aIdx = a.message_index ?? 0;
    const aLoc = a.location_id;
    for (let j = i + 1; j < events.length; j++) {
      const b = events[j];
      const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      const causal = chainSet.has(`${lo}|${hi}`) ? 1 : 0;

      const bEmb = parsedEmbeddings[j];
      const bNorm = norms[j];
      const cosRaw = (aEmb && bEmb) ? Math.max(0, cosineSim(aEmb, bEmb, aNorm, bNorm)) : 0;
      const cos = cosFloor > 0 ? Math.max(0, cosRaw - cosFloor) : cosRaw;

      const bParts = participants.get(b.id) || null;
      const jacRaw = jaccard(aParts, bParts);
      const jac = jaccFloor > 0 ? Math.max(0, jacRaw - jaccFloor) : jacRaw;

      const loc = (aLoc && aLoc === b.location_id) ? 1 : 0;
      const bIdx = b.message_index ?? 0;
      const tempPen = Math.abs(aIdx - bIdx) / maxGap;

      const w = WC * causal + WE * cos + WP * jac + WL * loc - WT * tempPen;
      if (w >= PRUNE) {
        g.addEdge(a.id, b.id, { weight: w });
      }
    }
  }

  // 5. Run Louvain. Use .detailed() to get modularity Q alongside the
  //    partition in one pass — graphology-communities-louvain exposes
  //    { communities, modularity, count, ... } from the detailed variant.
  const rng = mulberry32(seed);
  const detailed = louvain.detailed(g, {
    getEdgeWeight: "weight",
    resolution,
    rng,
  });
  const partition = detailed.communities || {};
  const modularityQ = Number.isFinite(detailed.modularity) ? detailed.modularity : 0;

  // 6. Group nodes by community.
  const communities = new Map();
  for (const [nodeId, c] of Object.entries(partition)) {
    let bucket = communities.get(c);
    if (!bucket) {
      bucket = [];
      communities.set(c, bucket);
    }
    bucket.push(nodeId);
  }

  const eventById = new Map(events.map((e) => [e.id, e]));

  // 7. Prune tiny communities, sort survivors by their first event's msg_idx
  //    so arc IDs increment in chat order. Ties broken by the raw community
  //    index for stability.
  const arcsToBuild = [...communities.entries()]
    .filter(([, ids]) => ids.length >= minArcSize)
    .map(([cIdx, ids]) => {
      const members = ids
        .map((id) => eventById.get(id))
        .filter(Boolean);
      members.sort((a, b) => (a.message_index ?? 0) - (b.message_index ?? 0));
      return { cIdx, members };
    })
    .sort((a, b) => {
      const aFirst = a.members[0]?.message_index ?? 0;
      const bFirst = b.members[0]?.message_index ?? 0;
      if (aFirst !== bFirst) return aFirst - bFirst;
      return a.cIdx - b.cIdx;
    });

  const totalCommunities = communities.size;
  const builtArcs = arcsToBuild.length;
  const prunedArcs = totalCommunities - builtArcs;

  // Graph-level stats needed for the density proxy: total edge count and
  // node count. density = intraEdges / expectedEdges, where expectedEdges
  // assumes random placement of the graph's edges across all node pairs:
  //   expectedEdges = edgeCount * (k*(k-1)) / (N*(N-1))
  // for a cluster of size k. density ≥ 1 means "above random"; we gate at
  // 1.5 so only clearly-structured clusters get LLM-named.
  const totalEdges = g.size;
  const totalNodes = g.order;
  const totalPairs = Math.max(1, (totalNodes * (totalNodes - 1)) / 2);

  // 7b. Enrich each surviving community with its spine event, templated
  //     title, importance, and intra-community density. Computed once here
  //     so both the dry-run return payload and the real DB-write branch
  //     reuse the same shape (and Path 2's eval harness can show --detail
  //     output identical to what would land in the DB).
  const enrichedArcs = arcsToBuild.map(({ cIdx, members }) => {
    const spine = members
      .slice()
      .sort((a, b) => {
        const sigDiff = (b.significance ?? 0) - (a.significance ?? 0);
        if (sigDiff !== 0) return sigDiff;
        return (a.message_index ?? 0) - (b.message_index ?? 0);
      })[0];

    // Templated title. Replaced below with LLM-generated name if density
    // gate passes and opts.nameArcs is true; otherwise this is the final
    // title that lands in the DB.
    const summary = (spine?.summary || "(no summary)").trim();
    const title = `Arc: ${summary.slice(0, 80)}`;

    const importance = Math.min(
      5,
      Math.max(1, Math.round(spine?.significance ?? 3)),
    );

    const startMsgIdx = members[0].message_index ?? null;
    const endMsgIdx = members[members.length - 1].message_index ?? null;

    // Count intra-community edges by iterating the member list. This is
    // O(k²) per cluster which sums to O(N²) total in the worst case but
    // in practice is ~2-3% of the outer N² kernel on sparse graphs.
    let intraEdges = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (g.hasEdge(members[i].id, members[j].id)) intraEdges++;
      }
    }
    const k = members.length;
    const expectedEdges = totalPairs > 0
      ? (totalEdges * (k * (k - 1)) / 2) / totalPairs
      : 0;
    const density = expectedEdges > 0 ? intraEdges / expectedEdges : 0;

    return {
      cIdx,
      members,
      spine,
      title,
      description: "",
      importance,
      startMsgIdx,
      endMsgIdx,
      intraEdges,
      expectedEdges,
      density,
    };
  });

  if (dryRun) {
    // Edge/degree stats are only computed for dry-run because the eval
    // harness wants them per run and the prod rebuild path has no consumer.
    const edgeCount = g.size;
    const avgDegree = events.length > 0 ? (2 * edgeCount) / events.length : 0;

    return {
      builtArcs,
      prunedArcs,
      totalEvents: events.length,
      modularityQ,
      edgeCount,
      avgDegree,
      communities: enrichedArcs.map((a) => ({
        spineEventId: a.spine?.id || null,
        eventIds: a.members.map((m) => m.id),
        summaries: a.members.map((m) => (m.summary || "").trim()),
        title: a.title,
        description: a.description,
        importance: a.importance,
        startMsgIdx: a.startMsgIdx,
        endMsgIdx: a.endMsgIdx,
        density: a.density,
        intraEdges: a.intraEdges,
        expectedEdges: a.expectedEdges,
      })),
    };
  }

  // 7c. Path 4: LLM arc naming. Opt-in via opts.nameArcs. Gated on cluster
  //     density so incoherent communities fall back to the template. We
  //     resolve the chat's protagonist once here (character with the most
  //     participated_in edges across this chat's events) and share it for
  //     all naming calls. `"the protagonist"` is the fallback when the chat
  //     has no participated_in rows.
  let namedArcs = 0;
  let templatedArcs = 0;
  if (nameArcs && enrichedArcs.length > 0) {
    let protagonistName = "the protagonist";
    try {
      const { rows: protoRows } = await p.query(
        `SELECT c.name, COUNT(*)::int AS cnt
         FROM participated_in pi
         JOIN events e ON e.id = pi.event_id
         JOIN characters c ON c.id = pi.character_id
         WHERE e.chat_id = $1
         GROUP BY c.name
         ORDER BY cnt DESC, c.name ASC
         LIMIT 1`,
        [chatId],
      );
      if (protoRows.length > 0 && protoRows[0].name) {
        protagonistName = protoRows[0].name;
      }
    } catch (err) {
      console.warn(`[ChronicleDB] Arc naming: protagonist lookup failed: ${err.message}`);
    }

    // Lazy-require so that pure structural rebuilds (nameArcs=false) never
    // touch the extractor module — keeps the dry-run grid-sweep path free
    // of LLM helper state and settings.apiKey dependencies.
    const extractor = require("./extractor");

    for (const arc of enrichedArcs) {
      if (!(arc.density >= densityGate)) {
        templatedArcs++;
        continue;
      }
      try {
        const memberEvents = arc.members.slice(0, 12).map((m) => ({
          messageIndex: m.message_index,
          summary: m.summary || "",
        }));
        const named = await extractor.nameStoryArc(settings, {
          characterName: protagonistName,
          spineEventSummary: arc.spine?.summary || "",
          memberEvents,
          importance: arc.importance,
        });
        arc.title = named.title;
        arc.description = named.description;
        namedArcs++;
      } catch (err) {
        console.warn(
          `[ChronicleDB] Arc naming failed for cluster ${arc.cIdx}: ${err.message}`,
        );
        templatedArcs++;
      }
    }
  } else {
    // Every arc uses the templated title + empty description.
    templatedArcs = enrichedArcs.length;
  }

  // 8. Drop and rebuild inside a single transaction. The DELETE on arc_events
  //    is technically redundant given ON DELETE CASCADE on story_arcs, but
  //    explicit is safer and survives any future CASCADE change.
  await p.query("BEGIN");
  try {
    await p.query(
      `DELETE FROM arc_events WHERE arc_id IN (SELECT id FROM story_arcs WHERE chat_id = $1)`,
      [chatId],
    );
    await p.query(`DELETE FROM story_arcs WHERE chat_id = $1`, [chatId]);

    for (const arc of enrichedArcs) {
      const arcId = await db.upsertStoryArc(settings, {
        chatId,
        title: arc.title,
        description: arc.description || "",
        arcType: "main",
        // Ingested chats are by definition complete at rebuild time.
        status: "resolved",
        importance: arc.importance,
        startMsgIdx: arc.startMsgIdx,
        endMsgIdx: arc.endMsgIdx,
        spineEventId: arc.spine?.id || null,
        source: "structural",
      });

      let pos = 0;
      for (const m of arc.members) {
        await db.linkEventToArc(settings, {
          arcId,
          eventId: m.id,
          position: pos++,
          isAnchor: m.id === arc.spine?.id,
        });
      }
    }

    await p.query("COMMIT");
  } catch (err) {
    await p.query("ROLLBACK");
    throw err;
  }

  return {
    builtArcs,
    prunedArcs,
    totalEvents: events.length,
    modularityQ,
    namedArcs,
    templatedArcs,
  };
}

// ── Deterministic RNG ─────────────────────────────────────────────
// mulberry32 is a fast, simple PRNG with good statistical properties for
// clustering seed purposes. Used so the Louvain partition is reproducible
// across rebuilds against the same inputs — important for Path 2's eval
// harness which will diff partitions.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
