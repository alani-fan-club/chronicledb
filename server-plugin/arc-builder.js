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
const DEFAULT_WEIGHTS = { WC: 1.0, WE: 0.6, WP: 0.4, WL: 0.2, WT: 0.3, PRUNE: 0.2 };

// Tiny-community floor. Communities with fewer than MIN_ARC_SIZE events are
// pruned rather than emitted as arcs. 3 events is the research doc's default.
const MIN_ARC_SIZE = 3;

// Deterministic RNG seed for Louvain so rebuilds are reproducible.
const DEFAULT_SEED = 42;

module.exports = {
  rebuildArcsForChat,
  DEFAULT_WEIGHTS,
  MIN_ARC_SIZE,
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
 * @returns {Promise<{builtArcs:number, prunedArcs:number, totalEvents:number, modularityQ:number}>}
 */
async function rebuildArcsForChat(settings, chatId, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const minArcSize = opts.minArcSize ?? MIN_ARC_SIZE;
  const seed = opts.seed ?? DEFAULT_SEED;
  const dryRun = Boolean(opts.dryRun);

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
      const cos = (aEmb && bEmb) ? Math.max(0, cosineSim(aEmb, bEmb, aNorm, bNorm)) : 0;

      const bParts = participants.get(b.id) || null;
      const jac = jaccard(aParts, bParts);

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

  if (dryRun) {
    return {
      builtArcs,
      prunedArcs,
      totalEvents: events.length,
      modularityQ,
      communities: arcsToBuild.map(({ members }) => ({
        eventIds: members.map((m) => m.id),
        startMsgIdx: members[0]?.message_index ?? null,
        endMsgIdx: members[members.length - 1]?.message_index ?? null,
      })),
    };
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

    for (const { members } of arcsToBuild) {
      // Spine: highest significance, tie broken by earliest message_index.
      const spine = members
        .slice()
        .sort((a, b) => {
          const sigDiff = (b.significance ?? 0) - (a.significance ?? 0);
          if (sigDiff !== 0) return sigDiff;
          return (a.message_index ?? 0) - (b.message_index ?? 0);
        })[0];

      // Templated title. Path 4 replaces this with an LLM-generated name.
      const summary = (spine?.summary || "(no summary)").trim();
      const title = `Arc: ${summary.slice(0, 80)}`;

      const importance = Math.min(
        5,
        Math.max(1, Math.round(spine?.significance ?? 3)),
      );

      const startMsgIdx = members[0].message_index ?? null;
      const endMsgIdx = members[members.length - 1].message_index ?? null;

      const arcId = await db.upsertStoryArc(settings, {
        chatId,
        title,
        description: "",
        arcType: "main",
        // Ingested chats are by definition complete at rebuild time.
        status: "resolved",
        importance,
        startMsgIdx,
        endMsgIdx,
        spineEventId: spine?.id || null,
        source: "structural",
      });

      let pos = 0;
      for (const m of members) {
        await db.linkEventToArc(settings, {
          arcId,
          eventId: m.id,
          position: pos++,
          isAnchor: m.id === spine?.id,
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
