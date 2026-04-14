/**
 * ChronicleDB retrieval core — single source of truth for hybrid
 * graph+vector retrieval. Both the ST plugin (retriever.js) and the eval
 * harness (cdb-client.ts) import from here.
 *
 * Pool ownership: parameterized. Every query function takes a `pool`
 * argument (a node-postgres Pool) rather than walking a `settings` object.
 * Callers construct their own pool — retriever.js wraps `db.getPool(settings)`
 * for credential hot-swap, cdb-client.ts uses a module singleton. Both
 * converge here.
 *
 * See REVIEW.md §7a for the target shape and §2a for the drift this fixes.
 * Highlights of what used to diverge and is now unified:
 *   - lexicalSearch uses OR tsquery (was AND on the plugin side — that
 *     caused ~30% recall loss in ST relative to eval)
 *   - RRF constant, recency alpha, per-kind caps, RRF fusion: single copy
 *   - event vector, snapshot vector, graph-expansion boost, neighbor
 *     padding: previously eval-only, now available to both callers
 *   - formatMemoryBlock is data-driven via SECTION_REGISTRY (§3b / §7c)
 *
 * HyDE query rewriting and Gemini cross-encoder rerank stay in cdb-client.ts
 * (they add latency and need the Gemini API). They're one flag away from
 * being enabled in ST — see `retriever.js::retrieve` and the { hyde, rerank }
 * options below.
 */

const { buildOrTsquery } = require("./ts-query");

// ── Tunables ────────────────────────────────────────────────────

// RRF constant. Standard choice; comments in cdb-client.ts note this was
// tuned against haiku eval and works across both dense and lexical sources.
const RRF_K = 60;

// Recency boost blends a normalized message_index (0..1, newer = 1) into
// RRF score. RRF top scores are ~1/61 ≈ 0.0164; alpha=0.003 keeps recency
// as a gentle tiebreaker. Earlier 0.008 was biasing too hard toward recent
// events and losing early-corpus questions.
const RECENCY_ALPHA = 0.003;

// Per-kind caps: hybrid fusion returns top-N per bucket rather than top-N
// overall so the much-larger memory pool doesn't starve events/dialogue/
// snapshots out of the final candidate list. 2x the render caps gives the
// optional rerank room to reorder within kind.
const PER_KIND_CAPS = { memory: 24, event: 10, dialogue: 10, snapshot: 8 };

// Per-section slice limits in formatMemoryBlock. Single auditable spot so
// A/B'ing budgets is one edit, not ten scattered magic numbers (see §3b).
const SECTION_LIMITS = {
  memoryBody: 1800,
  memoryNeighbor: 700,
  eventBody: 2000,
  eventArcDesc: 200,
  eventArcNeighbor: 300,
  dialogueQuote: 600,
  snapshotBody: 1200,
  sceneContextQuote: 200,
  knowsTake: 5,
  doesNotKnowTake: 3,
  relationshipTake: 10,
  relationshipDesc: 150,
};

// Render caps per fused-hit kind in the "Matched *" sections.
const RENDER_CAPS = { memory: 3, event: 4, dialogue: 4, snapshot: 3 };

// ── Chat scope helper ───────────────────────────────────────────

/**
 * Normalize a chatIds argument. Accepts `string`, `string[]`, or `null`.
 * Returns `null` when there's nothing to scope to (callers fall back to
 * global behavior where applicable, usually an empty result set).
 */
function normalizeChatIds(chatIds) {
  if (Array.isArray(chatIds)) return chatIds.length > 0 ? chatIds : null;
  if (typeof chatIds === "string" && chatIds) return [chatIds];
  return null;
}

// ── Source-specific search queries ──────────────────────────────

/**
 * Max message_index across memory_embeddings + events for the given chats.
 * Used for recency normalization. Changes only on ingest — see REVIEW §5c
 * for a caching opportunity on long chats.
 */
async function getMaxMessageIndex(pool, chatIds) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return 0;
  const { rows } = await pool.query(
    `SELECT GREATEST(
       COALESCE((SELECT max(message_index) FROM memory_embeddings WHERE chat_id = ANY($1::text[])), 0),
       COALESCE((SELECT max(message_index) FROM events WHERE chat_id = ANY($1::text[])), 0)
     ) AS m`,
    [ids],
  );
  return Number(rows[0]?.m || 0);
}

/**
 * Vector similarity search on memory_embeddings, scoped to chatIds.
 * Returns the top-K most-similar content snippets. Uses pgvector <=> op
 * on the HNSW index. COALESCE on raw_text falls back to content for
 * rows predating the raw_text column.
 */
async function vectorSearch(pool, chatIds, queryEmbedding, limit = 5) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const { rows } = await pool.query(
    `SELECT id, content, COALESCE(raw_text, content) as raw_text,
            context_prefix, message_index,
            1 - (embedding <=> $1::vector) as similarity
     FROM memory_embeddings
     WHERE chat_id = ANY($2::text[])
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [JSON.stringify(queryEmbedding), ids, limit],
  );
  return rows;
}

/**
 * Full-text lexical search via the tsv GIN index on memory_embeddings.
 * OR semantics (not plainto_tsquery's AND) — this is the drift-fixing
 * change from REVIEW §2a. ts_headline extracts a fragment centered on
 * matching terms, which is materially better than slicing the first N
 * chars of raw_text.
 */
async function lexicalSearch(pool, chatIds, query, limit = 5) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const tsquery = buildOrTsquery(query);
  if (!tsquery) return [];
  const { rows } = await pool.query(
    `SELECT id, content, context_prefix, message_index,
            ts_headline('english',
                        COALESCE(raw_text, content),
                        to_tsquery('english', $1),
                        'MaxWords=150, MinWords=30, MaxFragments=5, FragmentDelimiter=" ... "') as raw_text,
            ts_rank(tsv, to_tsquery('english', $1)) as rank
     FROM memory_embeddings
     WHERE chat_id = ANY($2::text[])
       AND tsv @@ to_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT $3`,
    [tsquery, ids, limit],
  );
  return rows;
}

/**
 * HNSW vector search over events.embedding (populated by the multi-
 * granularity backfill). Previously eval-only; now shared.
 */
async function eventVectorSearch(pool, chatIds, queryEmbedding, limit = 5) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const { rows } = await pool.query(
    `SELECT e.id, e.source_text, e.message_index, e.timestamp, e.summary,
            1 - (e.embedding <=> $1::vector) as similarity
     FROM events e
     WHERE e.chat_id = ANY($2::text[])
       AND e.embedding IS NOT NULL
     ORDER BY e.embedding <=> $1::vector
     LIMIT $3`,
    [JSON.stringify(queryEmbedding), ids, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    source_text: r.source_text ?? r.summary ?? "",
    message_index: r.message_index ?? null,
    timestamp: r.timestamp ?? null,
    session_id: null,
    rank: r.similarity,
  }));
}

/**
 * Full-text lexical search over events.source_text. Used in hybrid
 * fusion alongside the event vector search. OR tsquery.
 */
async function eventLexicalSearch(pool, chatIds, query, limit = 5) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const tsquery = buildOrTsquery(query);
  if (!tsquery) return [];
  const { rows } = await pool.query(
    `SELECT e.id, e.source_text, e.message_index, e.timestamp,
            ts_rank(to_tsvector('english', e.source_text), to_tsquery('english', $1)) as rank
     FROM events e
     WHERE e.chat_id = ANY($2::text[])
       AND e.source_text IS NOT NULL
       AND to_tsvector('english', e.source_text) @@ to_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT $3`,
    [tsquery, ids, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    source_text: r.source_text ?? "",
    message_index: r.message_index ?? null,
    timestamp: r.timestamp ?? null,
    session_id: null,
    rank: r.rank,
  }));
}

/**
 * HNSW vector search over context_snapshots.embedding (populated by the
 * multi-granularity backfill). Previously eval-only; now shared.
 */
async function snapshotVectorSearch(pool, chatIds, queryEmbedding, limit = 5) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const { rows } = await pool.query(
    `SELECT cs.id, cs.summary, cs.message_index, cs.emotional_tone, cs.present_chars,
            l.name AS location_name,
            1 - (cs.embedding <=> $1::vector) as similarity
     FROM context_snapshots cs
     LEFT JOIN locations l ON l.id = cs.location_id
     WHERE cs.chat_id = ANY($2::text[])
       AND cs.embedding IS NOT NULL
     ORDER BY cs.embedding <=> $1::vector
     LIMIT $3`,
    [JSON.stringify(queryEmbedding), ids, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    summary: r.summary ?? "",
    message_index: r.message_index ?? null,
    emotional_tone: r.emotional_tone ?? null,
    location_name: r.location_name ?? null,
    present_chars: r.present_chars ?? null,
    similarity: r.similarity,
  }));
}

/**
 * Dialogue-quote fusion: tsvector + trigram similarity, fused via RRF.
 * Trigram catches fuzzy paraphrase (typos, loose word order); tsvector
 * catches exact keywords. Both pull at `limit*2` (REVIEW §5d: cut from
 * `limit*3` — trgm already does fuzzy expansion so the extra 50% was
 * measurable latency with near-zero recall impact).
 */
async function dialogueQuoteSearch(pool, chatIds, query, limit = 5) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const tsquery = buildOrTsquery(query);
  if (!tsquery) return [];
  const fetchSize = limit * 2;
  const [tsRows, trgmRows] = await Promise.all([
    pool.query(
      `SELECT id, speaker, quote, message_index,
              ts_rank(to_tsvector('english', quote), to_tsquery('english', $1)) as rank
       FROM dialogue_quotes
       WHERE chat_id = ANY($2::text[])
         AND to_tsvector('english', quote) @@ to_tsquery('english', $1)
       ORDER BY rank DESC
       LIMIT $3`,
      [tsquery, ids, fetchSize],
    ),
    pool.query(
      `SELECT id, speaker, quote, message_index,
              similarity(quote, $1) as rank
       FROM dialogue_quotes
       WHERE chat_id = ANY($2::text[])
         AND quote % $1
       ORDER BY rank DESC
       LIMIT $3`,
      [query, ids, fetchSize],
    ),
  ]);
  const scores = new Map();
  tsRows.rows.forEach((r, i) => {
    scores.set(r.id, { score: 1 / (RRF_K + i + 1), item: r });
  });
  trgmRows.rows.forEach((r, i) => {
    const s = 1 / (RRF_K + i + 1);
    const existing = scores.get(r.id);
    if (existing) existing.score += s;
    else scores.set(r.id, { score: s, item: r });
  });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}

// ── Graph helpers ───────────────────────────────────────────────

/**
 * Arc expansion: for each event hit, fetch its story-arc membership and
 * the position ±1 neighbors in that arc. Single query with a self-join;
 * returns a Map<eventId, ArcExpansion>.
 *
 * One event may belong to multiple arcs — picks the highest-importance
 * arc per event (first row per event after the ORDER BY).
 *
 * Path 5 hierarchy walk: restricts the primary arc-join to
 * hierarchy_level=1 rows (the "arc"-tier; legacy pre-Path-5 rows default
 * to 1 too), then LEFT-joins the parent super-arc (level 0) via
 * `sa.parent_arc_id` so retrieval can render a super-arc breadcrumb
 * above the arc context. Episodes (level 2) are still excluded from
 * the default expansion — the renderer surfaces event → arc →
 * super-arc, not event → episode. Rows with NULL hierarchy_level
 * (shouldn't exist after the ALTER but matched here for forward-compat)
 * are treated as level 1.
 */
async function fetchArcExpansion(pool, eventIds) {
  const result = new Map();
  if (!eventIds || eventIds.length === 0) return result;
  const { rows } = await pool.query(
    `SELECT
       ae_hit.event_id,
       sa.title AS arc_title,
       sa.description AS arc_description,
       sa.status AS arc_status,
       sa.importance AS arc_importance,
       super_sa.title AS super_arc_title,
       super_sa.description AS super_arc_description,
       ae_hit.position AS hit_position,
       ae_neighbor.position AS neighbor_position,
       e_neighbor.summary AS neighbor_summary,
       e_neighbor.source_text AS neighbor_source_text
     FROM arc_events ae_hit
     JOIN story_arcs sa ON sa.id = ae_hit.arc_id
       AND COALESCE(sa.hierarchy_level, 1) = 1
     LEFT JOIN story_arcs super_sa
       ON super_sa.id = sa.parent_arc_id
       AND super_sa.hierarchy_level = 0
     LEFT JOIN arc_events ae_neighbor
       ON ae_neighbor.arc_id = ae_hit.arc_id
       AND ae_neighbor.position IN (ae_hit.position - 1, ae_hit.position + 1)
     LEFT JOIN events e_neighbor ON e_neighbor.id = ae_neighbor.event_id
     WHERE ae_hit.event_id = ANY($1::text[])
     ORDER BY ae_hit.event_id, sa.importance DESC NULLS LAST, ae_neighbor.position`,
    [eventIds],
  );
  for (const r of rows) {
    let exp = result.get(r.event_id);
    if (!exp) {
      exp = {
        arcTitle: r.arc_title,
        arcDescription: r.arc_description || "",
        arcStatus: r.arc_status || "active",
        superArcTitle: r.super_arc_title || null,
        superArcDescription: r.super_arc_description || "",
        hitPosition: r.hit_position,
      };
      result.set(r.event_id, exp);
    }
    if (exp.arcTitle !== r.arc_title) continue;
    if (r.neighbor_position === r.hit_position - 1 && r.neighbor_summary) {
      exp.prev = {
        summary: r.neighbor_summary,
        sourceText: r.neighbor_source_text || "",
        position: r.neighbor_position,
      };
    } else if (r.neighbor_position === r.hit_position + 1 && r.neighbor_summary) {
      exp.next = {
        summary: r.neighbor_summary,
        sourceText: r.neighbor_source_text || "",
        position: r.neighbor_position,
      };
    }
  }
  return result;
}

/**
 * ±1 neighbor padding: for each memory hit with a known message_index,
 * pull the immediately preceding and following messages from the same
 * chat. Renders as prev/next context bullets — helps boundary questions
 * where the answer spans adjacent messages.
 *
 * Input: list of FusedHits. Only memory hits contribute (dialogue/event
 * hits' message_index refer to their own rows, not message_embeddings).
 */
async function fetchNeighborPadding(pool, chatIds, hits) {
  const result = new Map();
  const ids = normalizeChatIds(chatIds);
  if (!ids || !hits || hits.length === 0) return result;

  const hitIndices = new Set();
  const targetIndices = new Set();
  for (const h of hits) {
    const idx = hitMessageIndex(h);
    if (typeof idx === "number" && idx >= 0) {
      hitIndices.add(idx);
      targetIndices.add(idx - 1);
      targetIndices.add(idx + 1);
    }
  }
  for (const i of hitIndices) targetIndices.delete(i);
  const targets = [...targetIndices].filter((i) => i >= 0);
  if (targets.length === 0) return result;

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (message_index) message_index, content, COALESCE(raw_text, content) as raw_text
     FROM memory_embeddings
     WHERE chat_id = ANY($1::text[])
       AND message_index = ANY($2::int[])
       AND node_type IN ('message', 'message_chunk')
     ORDER BY message_index, node_type, id`,
    [ids, targets],
  );
  for (const r of rows) {
    result.set(r.message_index, {
      message_index: r.message_index,
      content: r.content,
      raw_text: r.raw_text,
    });
  }
  return result;
}

/**
 * Scan characters.name + aliases against the query to find mentioned
 * entities. No LLM call — pure string containment. Used to boost events
 * those characters participated in.
 *
 * Cache is externally-provided so the caller controls TTL / scope:
 *   - eval uses a module singleton (one chat per process)
 *   - ST will use a Map with chatId-keyed entries and 5-minute TTL
 *     once graph expansion is wired into retriever.js
 *
 * Cache shape: `{ chatId: string, entries: Array<{ id, needle }>, expiresAt?: number }`
 * or null. When the cache is stale or missing, this function rebuilds
 * the entries array and overwrites `cache.entries` / `cache.chatId` /
 * `cache.expiresAt`. Returns the list of matched character IDs.
 */
async function detectMentionedCharacters(pool, chatIds, query, cache) {
  if (!query || !query.trim()) return [];
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const primaryChat = ids[0];

  const now = Date.now();
  const cacheStale = !cache
    || cache.chatId !== primaryChat
    || !Array.isArray(cache.entries)
    || (typeof cache.expiresAt === "number" && cache.expiresAt < now);

  let entries;
  if (cacheStale) {
    const { rows } = await pool.query(
      `SELECT DISTINCT c.id, c.name, c.aliases
       FROM characters c
       JOIN participated_in pi ON pi.character_id = c.id
       JOIN events e ON e.id = pi.event_id
       WHERE e.chat_id = ANY($1::text[])`,
      [ids],
    );
    entries = [];
    for (const r of rows) {
      const names = [r.name, ...(r.aliases || [])].filter(
        (n) => typeof n === "string" && n.length >= 3,
      );
      for (const n of names) {
        entries.push({ id: r.id, needle: n.toLowerCase() });
      }
    }
    if (cache) {
      cache.chatId = primaryChat;
      cache.entries = entries;
      // Default 5-minute TTL if the caller didn't preset one. Eval's
      // singleton caller leaves expiresAt unset and relies on process
      // lifetime; ST sets its own.
      if (typeof cache.expiresAt !== "number") {
        cache.expiresAt = now + 5 * 60 * 1000;
      } else {
        cache.expiresAt = now + 5 * 60 * 1000;
      }
    }
  } else {
    entries = cache.entries;
  }

  const haystack = query.toLowerCase();
  const matched = new Set();
  for (const { id, needle } of entries) {
    if (haystack.includes(needle)) matched.add(id);
  }
  return [...matched];
}

// ── Hybrid fusion ───────────────────────────────────────────────

/**
 * Return the message_index of a fused hit, or null if unknown.
 * Memory/event/dialogue/snapshot all carry an optional message_index
 * that the recency boost consults.
 */
function hitMessageIndex(item) {
  if (item.kind === "memory") return item.memory?.message_index ?? null;
  if (item.kind === "event") return item.event?.message_index ?? null;
  if (item.kind === "dialogue") return item.dialogue?.message_index ?? null;
  if (item.kind === "snapshot") return item.snapshot?.message_index ?? null;
  return null;
}

/**
 * Apply per-kind caps to a sorted list of FusedHits. Factored out of
 * hybridSearch per REVIEW §3c so hybridSearch reads as a linear story.
 */
function capPerKind(sorted, caps, limit) {
  const perKind = { memory: 0, event: 0, dialogue: 0, snapshot: 0 };
  const out = [];
  for (const entry of sorted) {
    const k = entry.item.kind;
    if ((perKind[k] ?? 0) < (caps[k] ?? 0)) {
      out.push(entry.item);
      perKind[k] = (perKind[k] ?? 0) + 1;
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Six-source hybrid fusion: memory vector + memory lexical + event
 * vector + event lexical + dialogue ts/trgm + snapshot vector → RRF merge
 * → optional graph expansion boost → recency boost → per-kind cap → top-N.
 *
 * Params:
 *   pool          — node-postgres Pool
 *   chatIds       — string | string[] | null (scope filter)
 *   embedding     — query embedding vector (required for vector sources)
 *   query         — raw query string (required for lexical sources)
 *   limit         — top-N after per-kind caps (default 20)
 *   boostCharIds  — character IDs for graph expansion boost (optional)
 *
 * Per-source overfetch sizes are tuned per REVIEW §5d:
 *   - memory/event/snapshot vector: limit*3 (cheap pgvector ops)
 *   - memory lexical: limit*3 (cheap GIN ops)
 *   - dialogue quote: limit*2 (trigram is the expensive one)
 *   - event lexical: min(30, limit*2) (capped; only ~10 ever rendered)
 */
async function hybridSearch(pool, { chatIds, embedding, query, limit = 20, boostCharIds = [] }) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];

  const fetchSize = Math.max(limit, 8) * 3;
  const eventLexFetch = Math.min(30, limit * 2);

  const [
    vectorResults,
    lexicalResults,
    eventLexResults,
    eventVecResults,
    dialogueResults,
    snapshotVecResults,
    maxMsgIdx,
  ] = await Promise.all([
    vectorSearch(pool, ids, embedding, fetchSize),
    lexicalSearch(pool, ids, query, fetchSize),
    eventLexicalSearch(pool, ids, query, eventLexFetch),
    eventVectorSearch(pool, ids, embedding, fetchSize),
    dialogueQuoteSearch(pool, ids, query, limit),
    snapshotVectorSearch(pool, ids, embedding, fetchSize),
    getMaxMessageIndex(pool, ids),
  ]);

  const scores = new Map();
  const bump = (key, item, rank) => {
    const s = 1 / (RRF_K + rank + 1);
    const existing = scores.get(key);
    if (existing) existing.score += s;
    else scores.set(key, { score: s, item });
  };

  vectorResults.forEach((r, i) =>
    bump(`m:${r.id}`, { kind: "memory", key: `m:${r.id}`, memory: r }, i),
  );
  lexicalResults.forEach((r, i) =>
    bump(`m:${r.id}`, { kind: "memory", key: `m:${r.id}`, memory: r }, i),
  );
  eventLexResults.forEach((r, i) =>
    bump(`e:${r.id}`, { kind: "event", key: `e:${r.id}`, event: r }, i),
  );
  eventVecResults.forEach((r, i) =>
    bump(`e:${r.id}`, { kind: "event", key: `e:${r.id}`, event: r }, i),
  );
  dialogueResults.forEach((r, i) =>
    bump(`d:${r.id}`, { kind: "dialogue", key: `d:${r.id}`, dialogue: r }, i),
  );
  snapshotVecResults.forEach((r, i) =>
    bump(`s:${r.id}`, { kind: "snapshot", key: `s:${r.id}`, snapshot: r }, i),
  );

  // Graph expansion: if the question named characters, pull event IDs
  // where those characters participated (any event in the chat — not
  // just current candidates) and award them a small RRF-tier boost.
  // Rows not already in candidates get synthesized so the boost can
  // lift them in.
  if (boostCharIds && boostCharIds.length > 0) {
    const { rows: boostedEventRows } = await pool.query(
      `SELECT DISTINCT e.id, e.source_text, e.message_index, e.timestamp, e.summary
       FROM events e
       JOIN participated_in pi ON pi.event_id = e.id
       WHERE e.chat_id = ANY($1::text[])
         AND pi.character_id = ANY($2::text[])
       ORDER BY e.message_index DESC NULLS LAST
       LIMIT 30`,
      [ids, boostCharIds],
    );
    const GRAPH_BONUS = 1 / (RRF_K + 3);
    for (const r of boostedEventRows) {
      const key = `e:${r.id}`;
      const item = {
        kind: "event",
        key,
        event: {
          id: r.id,
          source_text: r.source_text ?? r.summary ?? "",
          message_index: r.message_index ?? null,
          timestamp: r.timestamp ?? null,
          session_id: null,
        },
      };
      const existing = scores.get(key);
      if (existing) existing.score += GRAPH_BONUS;
      else scores.set(key, { score: GRAPH_BONUS, item });
    }
  }

  if (maxMsgIdx > 0) {
    for (const entry of scores.values()) {
      const msgIdx = hitMessageIndex(entry.item);
      if (typeof msgIdx === "number") {
        entry.score += RECENCY_ALPHA * (msgIdx / maxMsgIdx);
      }
    }
  }

  const sorted = [...scores.values()].sort((a, b) => b.score - a.score);
  return capPerKind(sorted, PER_KIND_CAPS, limit);
}

// ── Structured graph helpers (shared between eval + ST) ─────────

function slugify(name) {
  return "chr-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function getRelationships(pool, chatIds, characters) {
  const ids = normalizeChatIds(chatIds);
  const charIds = characters.map(slugify);
  const scoped = !!ids;
  const params = scoped ? [charIds, ids] : [charIds];
  const sessionFilter = scoped ? ` AND fa.session_id = ANY($2::text[])` : "";
  const { rows } = await pool.query(
    `SELECT c1.name as from_name, c2.name as to_name,
            fa.sentiment, fa.intensity, fa.description
     FROM feels_about fa
     JOIN characters c1 ON fa.from_char = c1.id
     JOIN characters c2 ON fa.to_char = c2.id
     WHERE (fa.from_char = ANY($1::text[]) OR fa.to_char = ANY($1::text[]))${sessionFilter}
     ORDER BY fa.intensity DESC
     LIMIT 20`,
    params,
  );
  return rows;
}

async function getRecentEvents(pool, chatIds, limit = 8) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const { rows } = await pool.query(
    `SELECT e.summary, e.source_text, e.significance, e.timestamp, e.message_index,
            array_agg(c.name) FILTER (WHERE c.name IS NOT NULL) as participants
     FROM events e
     LEFT JOIN participated_in pi ON pi.event_id = e.id
     LEFT JOIN characters c ON c.id = pi.character_id
     WHERE e.chat_id = ANY($1::text[])
     GROUP BY e.id
     ORDER BY e.significance DESC, e.timestamp DESC
     LIMIT $2`,
    [ids, limit],
  );
  return rows.map((r) => ({
    summary: r.summary,
    source_text: r.source_text ?? "",
    significance: r.significance,
    participants: r.participants ?? [],
    timestamp: r.timestamp,
    message_index: r.message_index ?? null,
  }));
}

/**
 * Knowledge boundaries with N+1 collapse (REVIEW §5a). Two queries
 * total, grouped in JS by character_id — not 2*N queries.
 *
 * Returns one KnowledgeBoundary entry per input character, in input
 * order. Characters with no facts still get an entry with empty arrays
 * so formatMemoryBlock can skip them cleanly.
 *
 * Scoping: facts are filtered to those present in memory_embeddings
 * for the given chats, so secrets from other chats don't leak across.
 * The NOT-know set for 'secret'/'backstory' is computed globally then
 * likewise scoped.
 */
async function getKnowledgeBoundaries(pool, chatIds, characters) {
  if (!characters || characters.length === 0) return [];
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];

  const charIds = characters.map(slugify);
  const nameById = new Map();
  characters.forEach((n, i) => nameById.set(charIds[i], n));

  // Single query for `knows` across all characters, chat-scoped via a
  // memory_embeddings join. GROUP BY implicit via ARRAY_AGG-in-JS.
  const { rows: knownRows } = await pool.query(
    `SELECT DISTINCT k.character_id, f.content
     FROM knows k
     JOIN facts f ON f.id = k.fact_id
     WHERE k.character_id = ANY($1::text[])
       AND f.id IN (
         SELECT node_id FROM memory_embeddings
         WHERE chat_id = ANY($2::text[]) AND node_type = 'fact'
       )`,
    [charIds, ids],
  );
  // Single query for `doesNotKnow`: secrets/backstory NOT linked via
  // `knows` to the character, joined per-character via a cross product.
  // Postgres's anti-join rewrites this efficiently against the knows PK.
  const { rows: unknownRows } = await pool.query(
    `SELECT c_param AS character_id, f.content
     FROM UNNEST($1::text[]) AS c_param
     CROSS JOIN facts f
     WHERE f.domain IN ('secret', 'backstory')
       AND f.id IN (
         SELECT node_id FROM memory_embeddings
         WHERE chat_id = ANY($2::text[]) AND node_type = 'fact'
       )
       AND NOT EXISTS (
         SELECT 1 FROM knows k
         WHERE k.character_id = c_param AND k.fact_id = f.id
       )`,
    [charIds, ids],
  );

  const knownByChar = new Map();
  for (const r of knownRows) {
    let arr = knownByChar.get(r.character_id);
    if (!arr) { arr = []; knownByChar.set(r.character_id, arr); }
    if (arr.length < 20) arr.push(r.content);
  }
  const unknownByChar = new Map();
  for (const r of unknownRows) {
    let arr = unknownByChar.get(r.character_id);
    if (!arr) { arr = []; unknownByChar.set(r.character_id, arr); }
    if (arr.length < 10) arr.push(r.content);
  }

  return charIds.map((cid) => ({
    character: nameById.get(cid),
    knows: knownByChar.get(cid) || [],
    doesNotKnow: unknownByChar.get(cid) || [],
  }));
}

async function getWorldState(pool, chatIds) {
  const ids = normalizeChatIds(chatIds);
  // Legacy world_state rows lack chat_id (upsertWorldState only started
  // writing it after this was flagged). NULL chat_id is treated as global
  // so pre-fix data remains visible. Cap at 20 newest so a runaway
  // extraction can't eat the entire token budget.
  if (!ids) {
    const { rows } = await pool.query(
      `SELECT key, value, valid_from as since FROM world_state
       WHERE valid_until IS NULL
       ORDER BY valid_from DESC
       LIMIT 20`,
    );
    return rows;
  }
  const { rows } = await pool.query(
    `SELECT key, value, valid_from as since FROM world_state
     WHERE valid_until IS NULL AND (chat_id = ANY($1::text[]) OR chat_id IS NULL)
     ORDER BY valid_from DESC
     LIMIT 20`,
    [ids],
  );
  return rows;
}

async function getPlotThreads(pool, chatIds) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const { rows } = await pool.query(
    `SELECT title, description, thread_type, importance, involved_chars FROM plot_threads
     WHERE chat_id = ANY($1::text[]) AND resolved_at IS NULL
     ORDER BY importance DESC
     LIMIT 10`,
    [ids],
  );
  return rows;
}

async function getRecentSnapshots(pool, chatIds, limit = 3) {
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const { rows } = await pool.query(
    `SELECT cs.summary, l.name as location_name, cs.emotional_tone, cs.present_chars
     FROM context_snapshots cs
     LEFT JOIN locations l ON cs.location_id = l.id
     WHERE cs.chat_id = ANY($1::text[])
     ORDER BY cs.message_index DESC
     LIMIT $2`,
    [ids, limit],
  );
  return rows;
}

async function getLocations(pool, chatIds, characters) {
  if (!characters || characters.length === 0) return [];
  const ids = normalizeChatIds(chatIds);
  if (!ids) return [];
  const charIds = characters.map(slugify);
  // Strict chat_id scope — unlike getWorldState where NULL means "global
  // truth", present_at NULL rows are stale is_current=TRUE snapshots from
  // legacy ingests before the chat_id column existed. They claim a
  // character is currently at a location that was true in some other
  // chat's history, which is exactly the cross-chat leak the user keeps
  // hitting. Legacy NULL rows stay invisible; re-ingest populates proper
  // chat_id on every new present_at write.
  const { rows } = await pool.query(
    `SELECT c.name as entity, l.name as location
     FROM present_at pa
     JOIN characters c ON c.id = pa.character_id
     JOIN locations l ON l.id = pa.location_id
     WHERE pa.character_id = ANY($1::text[])
       AND pa.is_current = TRUE
       AND pa.chat_id = ANY($2::text[])`,
    [charIds, ids],
  );
  return rows;
}

// ── formatMemoryBlock with SECTION_REGISTRY (§3b / §7c) ─────────

function sentimentLabel(s) {
  if (s >= 0.7) return "very positive";
  if (s >= 0.3) return "positive";
  if (s >= -0.3) return "neutral";
  if (s >= -0.7) return "negative";
  return "very negative";
}

/**
 * Section registry: ordered list of builders. Each `build(result)`
 * returns either a string (the rendered section including the `## Header`)
 * or null/"" to skip.
 *
 * Order is LOAD-BEARING: ground-truth sections (locations, world state,
 * active plot threads, matched *) render first so that when the block
 * overflows `maxChars` and is truncated, the ground truth survives.
 * Relationships go last — they're the bulkiest and most OK to truncate.
 *
 * This is the data-driven replacement for the ~170-line string-concat
 * monster in the old cdb-client.ts::formatMemoryBlock (REVIEW §3b).
 */
const SECTION_REGISTRY = [
  {
    name: "Current Scene",
    build(r) {
      if (!r.locations || r.locations.length === 0) return null;
      const lines = r.locations.map((l) => `- ${l.entity}: ${l.location}`).join("\n");
      return `## Current Scene\n${lines}`;
    },
  },
  {
    name: "World State",
    build(r) {
      if (!r.worldState || r.worldState.length === 0) return null;
      const lines = r.worldState.map((ws) => `- ${ws.key}: ${ws.value}`).join("\n");
      return `## World State\n${lines}`;
    },
  },
  {
    name: "Active Plot Threads",
    build(r) {
      if (!r.plotThreads || r.plotThreads.length === 0) return null;
      const lines = r.plotThreads.map((pt) => {
        const icon = { pending: "⏳", foreshadowing: "🔮", unresolved: "❓" }[pt.thread_type] || "📌";
        const involved = pt.involved_chars && pt.involved_chars.length > 0
          ? ` (involves: ${pt.involved_chars.join(", ")})`
          : "";
        return `- ${icon} [${pt.thread_type}] ${pt.title}: ${pt.description}${involved}`;
      }).join("\n");
      return `## Active Plot Threads\n${lines}`;
    },
  },
  {
    name: "Relevant Past Context",
    build(r) {
      if (!r.fusedHits || r.fusedHits.length === 0) return null;
      const memHits = r.fusedHits.filter((h) => h.kind === "memory").slice(0, RENDER_CAPS.memory);
      if (memHits.length === 0) return null;
      const blocks = [];
      for (const h of memHits) {
        const v = h.memory;
        const prefix = typeof v.similarity === "number"
          ? `(${(v.similarity * 100).toFixed(0)}%) `
          : "";
        const turn = typeof v.message_index === "number" ? `[turn ${v.message_index}] ` : "";
        const ctx = v.context_prefix ? `${v.context_prefix}\n\n` : "";
        const text = v.raw_text || v.content || "";
        blocks.push(`- ${prefix}${turn}${ctx}${text.slice(0, SECTION_LIMITS.memoryBody)}`);
        // Neighbors rendered as their own top-level bullets with
        // uppercase markers so LLMs can't skim past them — when these
        // were nested with indented dashes, Haiku repeatedly missed the
        // exact ground-truth quote sitting in the prev/next line.
        if (r.neighborPadding && typeof v.message_index === "number") {
          const prev = r.neighborPadding.get(v.message_index - 1);
          const next = r.neighborPadding.get(v.message_index + 1);
          if (prev) {
            blocks.push(
              `- [PREV TURN ${prev.message_index} — context for turn ${v.message_index}] ` +
                prev.raw_text.slice(0, SECTION_LIMITS.memoryNeighbor).replace(/\s+/g, " "),
            );
          }
          if (next) {
            blocks.push(
              `- [NEXT TURN ${next.message_index} — context for turn ${v.message_index}] ` +
                next.raw_text.slice(0, SECTION_LIMITS.memoryNeighbor).replace(/\s+/g, " "),
            );
          }
        }
      }
      return `## Relevant Past Context\n${blocks.join("\n")}`;
    },
  },
  {
    name: "Matched Event Passages",
    build(r) {
      if (!r.fusedHits || r.fusedHits.length === 0) return null;
      const eventHits = r.fusedHits.filter((h) => h.kind === "event").slice(0, RENDER_CAPS.event);
      if (eventHits.length === 0) return null;
      const lines = eventHits
        .map((h) => {
          const e = h.event;
          const turn = typeof e.message_index === "number" ? `[turn ${e.message_index}] ` : "";
          let out = `- ${turn}${(e.source_text || "").replace(/\s+/g, " ").slice(0, SECTION_LIMITS.eventBody)}`;
          const arc = r.arcExpansion && r.arcExpansion.get(e.id);
          if (arc) {
            // Path 5 breadcrumb: if the level-1 arc has a level-0 parent
            // super-arc, surface it above the arc line so the model sees
            // the full hierarchy (event → arc → super-arc). Episodes
            // (level 2) still aren't walked by default. Strip the
            // redundant "Super Arc: " / "Arc: " template prefix that
            // arc-builder.js writes for non-LLM-named rows — the
            // "[super arc: ...]" wrapper already labels it.
            if (arc.superArcTitle) {
              const cleanTitle = arc.superArcTitle.replace(/^(Super Arc: |Arc: |Episode: )/, "");
              const superDesc = arc.superArcDescription
                ? ` — ${arc.superArcDescription.slice(0, SECTION_LIMITS.eventArcDesc)}`
                : "";
              out += `\n  [super arc: ${cleanTitle}${superDesc}]`;
            }
            const desc = arc.arcDescription
              ? ` — ${arc.arcDescription.slice(0, SECTION_LIMITS.eventArcDesc)}`
              : "";
            out += `\n  [arc: ${arc.arcTitle} (${arc.arcStatus})${desc}]`;
            if (arc.prev) {
              out += `\n  [arc prev pos ${arc.prev.position}] ${arc.prev.summary.slice(0, SECTION_LIMITS.eventArcNeighbor)}`;
            }
            if (arc.next) {
              out += `\n  [arc next pos ${arc.next.position}] ${arc.next.summary.slice(0, SECTION_LIMITS.eventArcNeighbor)}`;
            }
          }
          return out;
        })
        .join("\n");
      return `## Matched Event Passages\n${lines}`;
    },
  },
  {
    name: "Matched Dialogue Quotes",
    build(r) {
      if (!r.fusedHits || r.fusedHits.length === 0) return null;
      const dialogueHits = r.fusedHits.filter((h) => h.kind === "dialogue").slice(0, RENDER_CAPS.dialogue);
      if (dialogueHits.length === 0) return null;
      const lines = dialogueHits
        .map((h) => {
          const d = h.dialogue;
          const turn = typeof d.message_index === "number" ? `[turn ${d.message_index}] ` : "";
          return `- ${turn}${d.speaker}: "${(d.quote || "").slice(0, SECTION_LIMITS.dialogueQuote)}"`;
        })
        .join("\n");
      return `## Matched Dialogue Quotes\n${lines}`;
    },
  },
  {
    name: "Matched Scene Snapshots",
    build(r) {
      if (!r.fusedHits || r.fusedHits.length === 0) return null;
      const snapshotHits = r.fusedHits.filter((h) => h.kind === "snapshot").slice(0, RENDER_CAPS.snapshot);
      if (snapshotHits.length === 0) return null;
      const lines = snapshotHits
        .map((h) => {
          const s = h.snapshot;
          const turn = typeof s.message_index === "number" ? `[turn ${s.message_index}] ` : "";
          const loc = s.location_name ? ` [at ${s.location_name}]` : "";
          const tone = s.emotional_tone ? ` (${s.emotional_tone})` : "";
          return `- ${turn}${(s.summary || "").slice(0, SECTION_LIMITS.snapshotBody)}${loc}${tone}`;
        })
        .join("\n");
      return `## Matched Scene Snapshots\n${lines}`;
    },
  },
  {
    name: "Scene Context",
    build(r) {
      // Narrative framing: append-only views of recent history.
      if (!r.snapshots || r.snapshots.length === 0) return null;
      const lines = r.snapshots.map((s) => {
        let line = `- ${s.summary}`;
        if (s.location_name) line += ` [at ${s.location_name}]`;
        if (s.emotional_tone) line += ` (${s.emotional_tone})`;
        return line;
      }).join("\n");
      return `## Scene Context\n${lines}`;
    },
  },
  {
    name: "Recent Events",
    build(r) {
      if (!r.events || r.events.length === 0) return null;
      const lines = r.events.map((e, i) => {
        const participants = e.participants && e.participants.length > 0
          ? ` (${e.participants.join(", ")})`
          : "";
        let line = `${i + 1}. [sig ${e.significance ?? "?"}/5] ${e.summary}${participants}`;
        if (e.source_text && e.source_text.trim().length > 0) {
          const quote = e.source_text.replace(/\s+/g, " ").slice(0, SECTION_LIMITS.sceneContextQuote).trim();
          line += `\n   > "${quote}"`;
        }
        return line;
      }).join("\n");
      return `## Recent Events\n${lines}`;
    },
  },
  {
    name: "Character Knowledge Boundaries",
    build(r) {
      if (!r.knowledge || r.knowledge.length === 0) return null;
      const lines = r.knowledge.map((kb) => {
        const parts = [];
        if (kb.knows && kb.knows.length > 0) {
          parts.push(`- ${kb.character} knows: ${kb.knows.slice(0, SECTION_LIMITS.knowsTake).join("; ")}`);
        }
        if (kb.doesNotKnow && kb.doesNotKnow.length > 0) {
          parts.push(`- ${kb.character} does NOT know: ${kb.doesNotKnow.slice(0, SECTION_LIMITS.doesNotKnowTake).join("; ")}`);
        }
        return parts.join("\n");
      }).filter(Boolean).join("\n");
      return lines ? `## Character Knowledge Boundaries\n${lines}` : null;
    },
  },
  {
    name: "Relationships",
    build(r) {
      // Bulky destructively-updated snapshot goes last — OK to truncate.
      if (!r.relationships || r.relationships.length === 0) return null;
      const lines = r.relationships.slice(0, SECTION_LIMITS.relationshipTake).map((rel) => {
        const sent = sentimentLabel(rel.sentiment);
        const desc = rel.description
          ? ` — ${rel.description.slice(0, SECTION_LIMITS.relationshipDesc)}`
          : "";
        const fromName = rel.from_name ?? rel.from;
        const toName = rel.to_name ?? rel.to;
        return `- ${fromName} → ${toName}: ${sent} (${((rel.intensity ?? 0) * 100).toFixed(0)}%)${desc}`;
      }).join("\n");
      return `## Relationships\n${lines}`;
    },
  },
];

/**
 * Data-driven formatter. Walks SECTION_REGISTRY in order, collects
 * non-null results, wraps in the ChronicleDB Memory Context delimiters,
 * then truncates to `maxChars` if oversized (tail marker preserved).
 */
function formatMemoryBlock(result, maxChars) {
  const sections = [];
  for (const section of SECTION_REGISTRY) {
    const rendered = section.build(result);
    if (rendered) sections.push(rendered);
  }
  const block = `[ChronicleDB Memory Context]\n\n${sections.join("\n\n")}\n\n[/ChronicleDB Memory Context]`;
  if (block.length > maxChars) {
    return block.slice(0, maxChars) + "\n[...truncated]";
  }
  return block;
}

module.exports = {
  // Tunables / registries
  RRF_K,
  RECENCY_ALPHA,
  PER_KIND_CAPS,
  RENDER_CAPS,
  SECTION_LIMITS,
  SECTION_REGISTRY,
  // Core helpers
  slugify,
  normalizeChatIds,
  hitMessageIndex,
  capPerKind,
  // Search queries
  getMaxMessageIndex,
  vectorSearch,
  lexicalSearch,
  eventVectorSearch,
  eventLexicalSearch,
  snapshotVectorSearch,
  dialogueQuoteSearch,
  fetchArcExpansion,
  fetchNeighborPadding,
  detectMentionedCharacters,
  hybridSearch,
  // Structured graph helpers
  getRelationships,
  getRecentEvents,
  getKnowledgeBoundaries,
  getWorldState,
  getPlotThreads,
  getRecentSnapshots,
  getLocations,
  // Rendering
  formatMemoryBlock,
  sentimentLabel,
};
