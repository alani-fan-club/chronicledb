// Path 1 arc builder — structural arc discovery via Louvain community
// detection on a weighted event graph. See RESEARCH_ARCS.md §5 Path 1.
//
// Path 5 extends this with a hierarchical three-level output (super-arcs →
// arcs → episodes) produced by sweeping the Louvain resolution parameter γ
// over the same weighted graph. The middle level (γ=0.5) is bit-for-bit
// identical to the flat Path 1 partition; levels 0 and 2 are new, gated on
// events.length >= 100, and link to the middle level via parent_arc_id.
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

// Path 5 hierarchy (RESEARCH_ARCS.md §5 Path 5): three-level Louvain sweep.
//   γ=0.25 → super-arcs (hierarchy_level=0, ~3-6 per 449-event chat)
//   γ=0.5  → arcs (hierarchy_level=1, unchanged Path 2 winner)
//   γ=1.0  → episodes (hierarchy_level=2, ~20-40 per 449-event chat)
// The research doc originally suggested γ ∈ {0.5, 1.0, 2.0}, but Path 2's
// tuning moved the "arcs" resolution down to 0.5 (from Louvain's 1.0 default)
// because the participant-signal floor and the temporal penalty need the
// lower γ to let the 10-arc partition emerge. Shifting the hierarchy window
// down by the same amount: super-arcs at γ=0.25 (half of 0.5, mirroring the
// research doc's "half the arc resolution" pattern), episodes at γ=1.0
// (Louvain's modularity-default, which Path 2's grid confirmed produces the
// ~40-50 very granular clusters the research doc calls "episodes").
const HIERARCHY_RESOLUTION_SUPER = 0.25;
const HIERARCHY_RESOLUTION_EPISODE = 1.0;

// Gate: hierarchy only applies to chats with >= HIERARCHY_MIN_EVENTS events.
// Shorter chats get flat Path 1 output as before — the research doc's
// "Don't ship hierarchy before ship flat" caveat plus the explicit
// "Gate path 5 on events.length >= 100" guidance.
const HIERARCHY_MIN_EVENTS = 100;

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
  HIERARCHY_RESOLUTION_SUPER,
  HIERARCHY_RESOLUTION_EPISODE,
  HIERARCHY_MIN_EVENTS,
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
 * @param {boolean} [opts.nameHierarchy] - Path 5: opt into LLM naming for the
 *                                         super-arc (level 0) and episode
 *                                         (level 2) tiers too. Default false
 *                                         (templated titles only for those
 *                                         levels); wired in but intentionally
 *                                         unused this tick — requires a
 *                                         different prompt than nameStoryArc
 *                                         to handle the cross-cluster spanning
 *                                         super-arcs produce.
 * @returns {Promise<{builtArcs:number, prunedArcs:number, totalEvents:number, modularityQ:number, namedArcs?:number, templatedArcs?:number, superArcs:number, episodes:number, modularityQSuper:number, modularityQEpisodes:number, communities?:Array}>}
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
  // Path 5: `nameHierarchy` is wired but default-off. Super-arc and episode
  // titles are templated in this tick; flipping this flag is a follow-up.
  const nameHierarchy = Boolean(opts.nameHierarchy);

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
    return {
      builtArcs: 0,
      prunedArcs: 0,
      totalEvents: events.length,
      modularityQ: 0,
      superArcs: 0,
      episodes: 0,
      modularityQSuper: 0,
      modularityQEpisodes: 0,
    };
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

  // Graph-level stats needed for the density proxy: total edge count and
  // node count. density = intraEdges / expectedEdges, where expectedEdges
  // assumes random placement of the graph's edges across all node pairs:
  //   expectedEdges = edgeCount * (k*(k-1)) / (N*(N-1))
  // for a cluster of size k. density ≥ 1 means "above random"; we gate at
  // 1.5 so only clearly-structured clusters get LLM-named.
  const totalEdges = g.size;
  const totalNodes = g.order;
  const totalPairs = Math.max(1, (totalNodes * (totalNodes - 1)) / 2);

  const eventById = new Map(events.map((e) => [e.id, e]));

  // Path 5: helper that runs one Louvain pass at a specific γ and produces a
  // sorted list of enriched, pruned community descriptors. The γ=0.5 call
  // must be invoked with the exact same (seed, resolution, graph) as Path 1
  // used pre-hierarchy so the level-1 partition is bit-for-bit identical to
  // the old flat output; the other two passes share the graph but use their
  // own mulberry32(seed) streams so each level is independently reproducible
  // and the level-1 result isn't perturbed by level-0 / level-2 RNG advances.
  //
  // Returns:
  //   { enrichedArcs, modularityQ, communitiesSize }
  // where `enrichedArcs` is ordered by first-member msg_idx and already
  // pruned to >= minArcSize.
  function runPartition(gamma, levelPrefix) {
    const rng = mulberry32(seed);
    const detailed = louvain.detailed(g, {
      getEdgeWeight: "weight",
      resolution: gamma,
      rng,
    });
    const partition = detailed.communities || {};
    const modularity = Number.isFinite(detailed.modularity) ? detailed.modularity : 0;

    const communities = new Map();
    for (const [nodeId, c] of Object.entries(partition)) {
      let bucket = communities.get(c);
      if (!bucket) {
        bucket = [];
        communities.set(c, bucket);
      }
      bucket.push(nodeId);
    }

    // Prune tiny communities, sort survivors by their first event's msg_idx
    // so arc IDs increment in chat order. Ties broken by the raw community
    // index for stability.
    const arcsToBuildLocal = [...communities.entries()]
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

    // Enrich each surviving community with its spine event, templated title,
    // importance, and intra-community density. Computed once here so both
    // the dry-run return payload and the real DB-write branch reuse the
    // same shape.
    const enriched = arcsToBuildLocal.map(({ cIdx, members }) => {
      const spine = members
        .slice()
        .sort((a, b) => {
          const sigDiff = (b.significance ?? 0) - (a.significance ?? 0);
          if (sigDiff !== 0) return sigDiff;
          return (a.message_index ?? 0) - (b.message_index ?? 0);
        })[0];

      const summary = (spine?.summary || "(no summary)").trim();
      const title = `${levelPrefix}${summary.slice(0, 80)}`;

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

    return {
      enrichedArcs: enriched,
      modularityQ: modularity,
      communitiesSize: communities.size,
    };
  }

  // 5. Run Louvain at the arc-level γ (Path 1 / Path 2 winner). This is the
  //    level retrieval reads by default and the one whose partition MUST be
  //    bit-for-bit identical to pre-Path-5 output.
  const arcPass = runPartition(resolution, "Arc: ");
  const enrichedArcs = arcPass.enrichedArcs;
  const modularityQ = arcPass.modularityQ;
  const totalCommunities = arcPass.communitiesSize;
  const builtArcs = enrichedArcs.length;
  const prunedArcs = totalCommunities - builtArcs;

  // 5b. Path 5: run the super-arc and episode passes iff the chat is large
  //     enough for hierarchy to mean anything (>= 100 events per the research
  //     doc's caveat). Shorter chats get only the flat level-1 output.
  const hierarchyEnabled = events.length >= HIERARCHY_MIN_EVENTS;
  const superPass = hierarchyEnabled
    ? runPartition(HIERARCHY_RESOLUTION_SUPER, "Super Arc: ")
    : { enrichedArcs: [], modularityQ: 0, communitiesSize: 0 };
  const episodePass = hierarchyEnabled
    ? runPartition(HIERARCHY_RESOLUTION_EPISODE, "Episode: ")
    : { enrichedArcs: [], modularityQ: 0, communitiesSize: 0 };
  const enrichedSuperArcs = superPass.enrichedArcs;
  const enrichedEpisodes = episodePass.enrichedArcs;
  const modularityQSuper = superPass.modularityQ;
  const modularityQEpisodes = episodePass.modularityQ;

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
      superArcs: enrichedSuperArcs.length,
      episodes: enrichedEpisodes.length,
      modularityQSuper,
      modularityQEpisodes,
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

  // 6. Path 4 + 5: LLM naming for arcs (level 1) and, when nameHierarchy
  //    is set, also for super-arcs (level 0) and episodes (level 2). One
  //    pass per level, density-gated so incoherent communities fall back
  //    to the template at every level. Protagonist lookup runs once and
  //    is shared across all passes. The extractor.nameStoryArc helper
  //    takes a `kind` arg so the prompt is level-appropriate ("super arc"
  //    titles end up broader, "episode" titles scene-focused, "arc"
  //    unchanged).
  let namedArcs = 0;
  let templatedArcs = 0;
  let namedSuperArcs = 0;
  let templatedSuperArcs = 0;
  let namedEpisodes = 0;
  let templatedEpisodes = 0;

  // Resolve protagonist name once if any naming pass will run.
  let protagonistName = "the protagonist";
  const willName = (nameArcs && enrichedArcs.length > 0) ||
    (nameHierarchy && (enrichedSuperArcs.length > 0 || enrichedEpisodes.length > 0));
  if (willName) {
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
  }

  // Lazy-require so that pure structural rebuilds (nameArcs=false,
  // nameHierarchy=false) never touch the extractor module — keeps the
  // dry-run grid-sweep path free of LLM helper state and apiKey deps.
  let extractor = null;
  if (willName) extractor = require("./extractor");

  // Snapshot existing arc titles by (hierarchy_level, spine_event_id) so
  // incremental rebuilds can recycle LLM-generated names whose centerpiece
  // event survived the new clustering. Only rows whose title is NOT a
  // templated "Arc: ... " / "Super Arc: ... " / "Episode: ..." are worth
  // recycling — templated titles are free to regenerate. This is the
  // critical optimization that makes /extract-fired incremental rebuilds
  // cost ~0 LLM calls instead of ~35 per fire: most spines survive a
  // 30-message extension, so most clusters reuse their existing title.
  const recycledTitleMap = new Map(); // key: `${level}::${spine_event_id}` -> {title, description}
  if (willName) {
    try {
      const { rows: existingArcs } = await p.query(
        `SELECT spine_event_id, title, description, hierarchy_level
         FROM story_arcs
         WHERE chat_id = $1
           AND spine_event_id IS NOT NULL
           AND title NOT LIKE 'Arc: %'
           AND title NOT LIKE 'Super Arc: %'
           AND title NOT LIKE 'Episode: %'`,
        [chatId],
      );
      for (const row of existingArcs) {
        const level = Number.isFinite(row.hierarchy_level) ? row.hierarchy_level : 1;
        recycledTitleMap.set(`${level}::${row.spine_event_id}`, {
          title: row.title,
          description: row.description || "",
        });
      }
    } catch (err) {
      console.warn(`[ChronicleDB] Title-recycle snapshot failed (will regenerate everything): ${err.message}`);
    }
  }
  const KIND_TO_LEVEL = { "super arc": 0, "arc": 1, "episode": 2 };

  // Inner helper: name one cluster pass. Returns {named, recycled, templated}.
  // Closure captures: extractor, densityGate, protagonistName, settings,
  // recycledTitleMap.
  async function nameClusterPass(clusters, kind) {
    const level = KIND_TO_LEVEL[kind] ?? 1;
    let n = 0, t = 0, r = 0;
    for (const arc of clusters) {
      if (!(arc.density >= densityGate)) {
        t++;
        continue;
      }
      // Title recycling: if the spine event of this cluster was the spine
      // of an existing LLM-named cluster at the same level, reuse its
      // title and description rather than firing a fresh LLM call. This
      // is the entire point of the snapshot above — incremental rebuilds
      // converge to ~0 incremental LLM calls because spine events are
      // stable across small chat extensions.
      const spineId = arc.spine?.id;
      if (spineId) {
        const recycled = recycledTitleMap.get(`${level}::${spineId}`);
        if (recycled) {
          arc.title = recycled.title;
          arc.description = recycled.description;
          r++;
          continue;
        }
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
          kind,
        });
        arc.title = named.title;
        arc.description = named.description;
        n++;
      } catch (err) {
        console.warn(
          `[ChronicleDB] ${kind} naming failed for cluster ${arc.cIdx}: ${err.message}`,
        );
        t++;
      }
    }
    return { named: n, recycled: r, templated: t };
  }

  let recycledArcs = 0, recycledSuperArcs = 0, recycledEpisodes = 0;
  if (nameArcs && enrichedArcs.length > 0) {
    const r = await nameClusterPass(enrichedArcs, "arc");
    namedArcs = r.named;
    recycledArcs = r.recycled;
    templatedArcs = r.templated;
  } else {
    templatedArcs = enrichedArcs.length;
  }

  if (nameHierarchy && enrichedSuperArcs.length > 0) {
    const r = await nameClusterPass(enrichedSuperArcs, "super arc");
    namedSuperArcs = r.named;
    recycledSuperArcs = r.recycled;
    templatedSuperArcs = r.templated;
  } else {
    templatedSuperArcs = enrichedSuperArcs.length;
  }

  if (nameHierarchy && enrichedEpisodes.length > 0) {
    const r = await nameClusterPass(enrichedEpisodes, "episode");
    namedEpisodes = r.named;
    recycledEpisodes = r.recycled;
    templatedEpisodes = r.templated;
  } else {
    templatedEpisodes = enrichedEpisodes.length;
  }

  // 7. Parent-linking: match each level-1 arc to the level-0 super-arc
  //    whose event set contains a majority of the level-1 arc's members,
  //    and each level-2 episode to the level-1 arc whose event set contains
  //    a majority of the episode's members. "Majority" here is implemented
  //    as "greatest overlap" — tie-break implicit in the sort order of the
  //    parent list (earliest-starting parent wins on ties, which is stable
  //    because the parent list is already sorted by first-member msg_idx).
  //
  //    The build routine runs before the DB writes so each enriched arc
  //    gets a `parentIdx` field populated (or undefined if no overlap). We
  //    resolve parentIdx → parent arc id during the insert loop, where the
  //    parent row's actual DB id is known.
  function assignParents(children, parents) {
    if (parents.length === 0) {
      for (const child of children) child.parentIdx = undefined;
      return;
    }
    // Build a nodeId → parent index map once, then count overlaps per child.
    const nodeToParentIdx = new Map();
    for (let pi = 0; pi < parents.length; pi++) {
      for (const m of parents[pi].members) {
        nodeToParentIdx.set(m.id, pi);
      }
    }
    for (const child of children) {
      const tally = new Map();
      for (const m of child.members) {
        const pi = nodeToParentIdx.get(m.id);
        if (pi === undefined) continue;
        tally.set(pi, (tally.get(pi) || 0) + 1);
      }
      let bestIdx = undefined;
      let bestCount = 0;
      for (const [pi, cnt] of tally.entries()) {
        if (cnt > bestCount || (cnt === bestCount && (bestIdx === undefined || pi < bestIdx))) {
          bestCount = cnt;
          bestIdx = pi;
        }
      }
      child.parentIdx = bestIdx;
    }
  }

  if (hierarchyEnabled) {
    // Level-1 arcs point at their containing level-0 super-arc.
    assignParents(enrichedArcs, enrichedSuperArcs);
    // Level-2 episodes point at their containing level-1 arc.
    assignParents(enrichedEpisodes, enrichedArcs);
  } else {
    // Flat mode: level-1 arcs are the only rows, parent is always null.
    for (const arc of enrichedArcs) arc.parentIdx = undefined;
  }

  // 8. Drop and rebuild inside a single transaction. The DELETE on arc_events
  //    is technically redundant given ON DELETE CASCADE on story_arcs, but
  //    explicit is safer and survives any future CASCADE change.
  //
  //    Insert order matters because of the parent_arc_id foreign key:
  //    super-arcs first (parent_arc_id=NULL), then arcs (may reference
  //    super-arc ids), then episodes (reference arc ids).
  const superArcIdByIdx = new Map();
  const arcIdByIdx = new Map();

  // C1: pool.query acquires-and-releases per call, so a multi-statement
  // rebuild run on `p.query("BEGIN")` is NOT atomic — BEGIN/DELETE/INSERT/
  // COMMIT may each land on different connections. Check out one client for
  // the whole transaction so the rebuild is actually all-or-nothing.
  //
  // The INSERTs below used to delegate to db.upsertStoryArc / db.linkEventToArc,
  // which take `settings` and call `db.getPool(settings).query(...)` — same
  // pool-level acquire-and-release, so they'd escape this transaction. We
  // inline their INSERT shapes against `client` here instead. Column lists
  // mirror upsertStoryArc's INSERT branch and linkEventToArc verbatim
  // (db.js:768-772 / db.js:779-783) so the schema stays authoritative there;
  // we can drop the upsertStoryArc UPDATE-on-title-collision branch because
  // the level-scoped DELETE below runs first and there's nothing to collide
  // with.
  //
  // M4: per-arc linkEventToArc round-trips (1000+ on a real chat) collapse
  // to one UNNEST INSERT per hierarchy level. We build the (arcId, eventId,
  // position, isAnchor) tuple list while looping the arc inserts, then fire
  // one arc_events INSERT per level after the arcs for that level finish.
  function newArcId() {
    return `arc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // Returns the new arcId and pushes the per-member arc_events tuples into
  // `tupleBuffer`. No INSERT to arc_events happens yet — that's the batched
  // follow-up call.
  async function insertArcRow(client, { arc, hierarchyLevel, parentArcId }, tupleBuffer) {
    const arcId = newArcId();
    await client.query(
      `INSERT INTO story_arcs (id, chat_id, title, description, arc_type, status, importance, start_msg_idx, end_msg_idx, spine_event_id, source, parent_arc_id, hierarchy_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        arcId,
        chatId,
        arc.title,
        arc.description || "",
        "main",
        // Ingested chats are by definition complete at rebuild time.
        "resolved",
        arc.importance || 3,
        arc.startMsgIdx,
        arc.endMsgIdx,
        arc.spine?.id || null,
        "structural",
        parentArcId ?? null,
        hierarchyLevel,
      ],
    );
    const spineId = arc.spine?.id || null;
    let pos = 0;
    for (const m of arc.members) {
      tupleBuffer.push([arcId, m.id, pos++, m.id === spineId]);
    }
    return arcId;
  }

  // One UNNEST INSERT per level. pg's per-statement parameter cap is 65535,
  // and UNNEST uses only 4 parameters regardless of row count, so a single
  // call handles arbitrarily many arc_events rows (Path 5's three levels on
  // a real chat top out at a couple thousand, well inside this budget).
  async function flushArcEventTuples(client, tuples) {
    if (tuples.length === 0) return;
    const arcIds = new Array(tuples.length);
    const eventIds = new Array(tuples.length);
    const positions = new Array(tuples.length);
    const anchors = new Array(tuples.length);
    for (let i = 0; i < tuples.length; i++) {
      arcIds[i] = tuples[i][0];
      eventIds[i] = tuples[i][1];
      positions[i] = tuples[i][2];
      anchors[i] = tuples[i][3];
    }
    await client.query(
      `INSERT INTO arc_events (arc_id, event_id, position, is_anchor)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[], $4::bool[])
       ON CONFLICT DO NOTHING`,
      [arcIds, eventIds, positions, anchors],
    );
  }

  const pool = db.getPool(settings);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM arc_events WHERE arc_id IN (SELECT id FROM story_arcs WHERE chat_id = $1)`,
      [chatId],
    );
    await client.query(`DELETE FROM story_arcs WHERE chat_id = $1`, [chatId]);

    // Level 0 — super-arcs (parent_arc_id = NULL). Templated titles only;
    // LLM naming for this level would need a different prompt.
    const superTuples = [];
    for (let i = 0; i < enrichedSuperArcs.length; i++) {
      const arc = enrichedSuperArcs[i];
      const arcId = await insertArcRow(
        client,
        { arc, hierarchyLevel: 0, parentArcId: null },
        superTuples,
      );
      superArcIdByIdx.set(i, arcId);
    }
    await flushArcEventTuples(client, superTuples);

    // Level 1 — arcs (may be LLM-named per opts.nameArcs, templated otherwise).
    // parent_arc_id is resolved from parentIdx → superArcIdByIdx.
    const arcTuples = [];
    for (let i = 0; i < enrichedArcs.length; i++) {
      const arc = enrichedArcs[i];
      const parentArcId =
        arc.parentIdx !== undefined ? superArcIdByIdx.get(arc.parentIdx) : null;
      const arcId = await insertArcRow(
        client,
        { arc, hierarchyLevel: 1, parentArcId: parentArcId ?? null },
        arcTuples,
      );
      arcIdByIdx.set(i, arcId);
    }
    await flushArcEventTuples(client, arcTuples);

    // Level 2 — episodes (templated titles only). parent_arc_id resolves to
    // the level-1 arc, not a level-0 super-arc.
    const episodeTuples = [];
    for (let i = 0; i < enrichedEpisodes.length; i++) {
      const arc = enrichedEpisodes[i];
      const parentArcId =
        arc.parentIdx !== undefined ? arcIdByIdx.get(arc.parentIdx) : null;
      await insertArcRow(
        client,
        { arc, hierarchyLevel: 2, parentArcId: parentArcId ?? null },
        episodeTuples,
      );
    }
    await flushArcEventTuples(client, episodeTuples);

    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  return {
    builtArcs,
    prunedArcs,
    totalEvents: events.length,
    modularityQ,
    namedArcs,
    recycledArcs,
    templatedArcs,
    superArcs: enrichedSuperArcs.length,
    episodes: enrichedEpisodes.length,
    modularityQSuper,
    modularityQEpisodes,
    namedSuperArcs,
    recycledSuperArcs,
    templatedSuperArcs,
    namedEpisodes,
    recycledEpisodes,
    templatedEpisodes,
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
