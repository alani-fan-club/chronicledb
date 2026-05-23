/**
 * Hybrid graph+vector retrieval for ChronicleDB (SillyTavern plugin).
 *
 * 90% of the retrieval logic now lives in `shared/retrieval-core.js`.
 * This file is the ST-facing orchestrator: it owns the `settings`-
 * threaded pool (so credential hot-swap still works via db.getPool),
 * builds the chat scope, calls into the shared core, and renders via
 * the shared SECTION_REGISTRY.
 *
 * ST gains from the consolidation:
 *   - event vector search
 *   - snapshot vector search
 *   - graph expansion via participated_in (character-mention boost)
 *   - neighbor padding (±1 messages around memory hits)
 *   - OR tsquery on lexical search (was AND plainto_tsquery — the
 *     biggest drift from REVIEW §2a, now fixed)
 *
 * HyDE query rewriting and Gemini cross-encoder rerank stay eval-only
 * for now because they add latency. They're one flag away from being
 * enabled: pass `{ hyde: true, rerank: true }` to the shared pipeline
 * once the ST latency budget allows it. See cdb-client.ts for the
 * Gemini direct implementations.
 */

const db = require("./db");
const { embed } = require("./extractor");
const core = require("../shared/retrieval-core");

// ── Per-consumer budget profiles ────────────────────────────────
//
// Different callers of /retrieve want wildly different slice sizes out
// of the same underlying corpus. The main generation inject path needs
// a big helping of events, quotes, and snippets to prime the model;
// the character-panel sidebar is a tiny glance and should not eat 3k
// tokens; the mindmap UI wants structural events only (no prose, no
// scene snapshots).
//
// A profile is a per-kind cap + an overall maxTokens render ceiling.
// Caller picks one by name via `budgetProfile` and can override any
// individual field explicitly. `settings.maxInjectionTokens` (the
// legacy knob on the UI extension side) still wins for the inject
// profile so existing user settings keep working.
const BUDGET_PROFILES = {
  inject:         { events: 12, dialogue: 8, memory: 10, snapshots: 3, maxTokens: 3000 },
  characterPanel: { events: 5,  dialogue: 0, memory: 5,  snapshots: 0, maxTokens: 1500 },
  mindmap:        { events: 30, dialogue: 0, memory: 0,  snapshots: 0, maxTokens: 8000 },
};

/**
 * Merge a budget profile with settings + explicit per-field overrides.
 *
 * Precedence (highest wins):
 *   1. explicit per-field overrides from the caller (overrides arg)
 *   2. settings.maxInjectionTokens (legacy UI knob → inject profile's
 *      maxTokens; also honored for other profiles because users tuning
 *      this knob generally mean "cap every memory block at N tokens")
 *   3. the named profile's defaults
 *
 * Unknown profile names fall through to the "inject" profile — it's a
 * safer default than throwing at the retrieval boundary on a typo.
 */
function resolveBudgets(settings, profileName, overrides) {
  const name = profileName && BUDGET_PROFILES[profileName] ? profileName : "inject";
  const base = BUDGET_PROFILES[name];
  const merged = { ...base };
  const settingsMaxTokens = Number(settings && settings.maxInjectionTokens);
  if (Number.isFinite(settingsMaxTokens) && settingsMaxTokens > 0) {
    merged.maxTokens = settingsMaxTokens;
  }
  if (overrides && typeof overrides === "object") {
    for (const key of ["events", "dialogue", "memory", "snapshots", "maxTokens"]) {
      const v = overrides[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        merged[key] = v;
      }
    }
  }
  merged.profile = name;
  return merged;
}

// Chat-scoped character index cache for graph expansion. Long-lived
// process → keep a per-chat Map with 5-minute TTL so chat-switching
// doesn't re-query characters every turn. The shared detector checks
// `expiresAt` and refreshes when stale.
const characterCacheByChat = new Map();
const CHARACTER_CACHE_TTL_MS = 5 * 60 * 1000;
const CHARACTER_CACHE_MAX_ENTRIES = 50;

function getCharacterCache(chatId) {
  if (!chatId) return null;
  const now = Date.now();
  let cache = characterCacheByChat.get(chatId);
  if (cache) {
    if (typeof cache.expiresAt === "number" && cache.expiresAt < now) {
      cache.entries = [];
      cache.expiresAt = 0;
    }
    // Re-set to bump insertion order; Map iterates in insert order so the
    // first key is the LRU candidate.
    characterCacheByChat.delete(chatId);
    characterCacheByChat.set(chatId, cache);
    return cache;
  }
  // 0 = "needs populating"; detectMentionedCharacters bumps to a real TTL after filling entries.
  cache = { chatId, entries: [], expiresAt: 0 };
  if (characterCacheByChat.size >= CHARACTER_CACHE_MAX_ENTRIES) {
    const oldestKey = characterCacheByChat.keys().next().value;
    if (oldestKey !== undefined) characterCacheByChat.delete(oldestKey);
  }
  characterCacheByChat.set(chatId, cache);
  return cache;
}

// ── POV epistemic mask helpers (AGARS known_nodes, derived view) ────
//
// When /retrieve is called with `pov: { characterName, upToMessageIndex }`
// we compute the character's known universe (db.getCharacterKnownUniverse)
// once and post-filter the omniscient result down to the subset the
// character could plausibly know about at that turn. Filtering happens
// AFTER retrieval-core returns — retrieval-core stays POV-unaware so its
// hybrid fusion, graph expansion, and rerank pipelines remain shared
// between ST and the eval harness.
//
// What gets filtered and how:
//   - `result.events`: getRecentEvents projects summary/message_index but
//     not event id, so we filter by message_index (eventMessageIndexes).
//     Events at unwitnessed message_indexes are dropped. Events with
//     NULL message_index are kept — we can't prove the character didn't
//     witness them, and the permissive default matches the rest of the
//     retrieval pipeline which never filters on NULL indexes.
//   - `result.fusedHits` events: filter by eventIds (hybrid-fusion event
//     rows carry `id` from the underlying events table).
//   - `result.fusedHits` memory chunks: node_type drives the filter.
//     message/message_chunk → filter by message_index. event → filter
//     by eventIds. fact → filter by factIds. character → characterIds.
//     location → locationIds. item → itemIds. lore → always kept (world-
//     level narrator knowledge is not character-scoped).
//   - `result.fusedHits` dialogue: dialogue_quotes has no event_id column
//     (only speaker/quote/message_index/chat_id). The closest structural
//     proxy for "did the character witness this line" is
//     `message_index ∈ eventMessageIndexes` — if they witnessed something
//     at turn N, they heard the lines said at turn N. This is an
//     interpretation of the spec's "drop dialogue whose event_id isn't
//     in eventIds" given the schema reality.
//   - `result.fusedHits` snapshots: kept as-is (scene-summary is narrator-
//     level per spec).
//   - `result.neighborPadding`: Map<messageIndex, …>. Drop keys whose
//     message_index isn't in eventMessageIndexes. Neighbor padding is a
//     ±1 expansion around hits; a hit that survived the filter can still
//     have a neighbor the character didn't witness, so we must re-filter.
//   - `result.arcExpansion`: Map<eventId, …>. Drop keys whose event id
//     isn't in eventIds. Arc expansion surfaces cross-arc neighbors —
//     same reason as neighbor padding.
//   - `result.locations`, `result.knowledge`, `result.relationships`,
//     `result.worldState`, `result.plotThreads`, `result.snapshots` all
//     stay as-is: they're either already character-scoped upstream
//     (getLocations, getKnowledgeBoundaries, getRelationships), or are
//     narrator-level (worldState, snapshots), or are plot scaffolding
//     the narrator needs to reason about even if no single character
//     knows the whole thing (plotThreads).
function filterFusedHitsByPov(fusedHits, universe) {
  if (!Array.isArray(fusedHits) || fusedHits.length === 0) return [];
  const { eventIds, eventMessageIndexes, factIds, locationIds, itemIds, characterIds } = universe;
  const messageTypes = new Set(["message", "message_chunk"]);
  const kept = [];
  for (const h of fusedHits) {
    if (h.kind === "event") {
      const id = h.event && h.event.id;
      if (id && eventIds.has(id)) kept.push(h);
      continue;
    }
    if (h.kind === "dialogue") {
      const mi = h.dialogue && h.dialogue.message_index;
      if (typeof mi === "number" && eventMessageIndexes.has(mi)) kept.push(h);
      continue;
    }
    if (h.kind === "snapshot") {
      // Narrator-level; keep.
      kept.push(h);
      continue;
    }
    if (h.kind === "memory") {
      const m = h.memory || {};
      const nt = m.node_type;
      if (nt === "lore") {
        kept.push(h);
        continue;
      }
      if (messageTypes.has(nt)) {
        if (typeof m.message_index === "number" && eventMessageIndexes.has(m.message_index)) {
          kept.push(h);
        }
        continue;
      }
      if (nt === "event") {
        if (m.node_id && eventIds.has(m.node_id)) kept.push(h);
        continue;
      }
      if (nt === "fact") {
        if (m.node_id && factIds.has(m.node_id)) kept.push(h);
        continue;
      }
      if (nt === "character") {
        if (m.node_id && characterIds.has(m.node_id)) kept.push(h);
        continue;
      }
      if (nt === "location") {
        if (m.node_id && locationIds.has(m.node_id)) kept.push(h);
        continue;
      }
      if (nt === "item") {
        if (m.node_id && itemIds.has(m.node_id)) kept.push(h);
        continue;
      }
      // Unknown node_type: drop under POV. Better to under-expose than
      // leak memory chunks we can't reason about.
      continue;
    }
    // Unknown kind: drop under POV for the same reason.
  }
  return kept;
}

function applyPovFilter(result, universe) {
  const { eventIds, eventMessageIndexes } = universe;

  // ── result.events ── filter by message_index (no ids available) ──
  if (Array.isArray(result.events)) {
    result.events = result.events.filter((e) => {
      if (typeof e.message_index !== "number") return true; // permissive: can't prove not witnessed
      return eventMessageIndexes.has(e.message_index);
    });
  }

  // ── fusedHits ──
  if (Array.isArray(result.fusedHits)) {
    result.fusedHits = filterFusedHitsByPov(result.fusedHits, universe);
  }

  // Refresh the per-kind convenience views from the filtered fusedHits
  // so /retrieve consumers peeking at `vectorResults` / `eventHits` /
  // `dialogueHits` see the POV-masked view too. Recomputed here rather
  // than post-filtered separately so the views never drift from
  // fusedHits under the mask.
  if (Array.isArray(result.fusedHits)) {
    result.vectorResults = result.fusedHits
      .filter((h) => h.kind === "memory")
      .map((h) => h.memory);
    result.eventHits = result.fusedHits
      .filter((h) => h.kind === "event")
      .map((h) => h.event);
    result.dialogueHits = result.fusedHits
      .filter((h) => h.kind === "dialogue")
      .map((h) => h.dialogue);
  }

  // ── neighborPadding ── Map<messageIndex, row> ──
  if (result.neighborPadding instanceof Map) {
    for (const key of [...result.neighborPadding.keys()]) {
      if (!eventMessageIndexes.has(key)) result.neighborPadding.delete(key);
    }
  }

  // ── arcExpansion ── Map<eventId, row> ──
  if (result.arcExpansion instanceof Map) {
    for (const key of [...result.arcExpansion.keys()]) {
      if (!eventIds.has(key)) result.arcExpansion.delete(key);
    }
  }

  return result;
}

async function retrieve(
  settings,
  {
    chatId,
    activeCharacters,
    recentText,
    sessionMode,
    sessionId,
    selectedChats,
    budgetProfile,
    budgetOverrides,
    pov,
  } = {},
) {
  const pool = db.getPool(settings);

  // Resolve the per-consumer budget once and thread it through every
  // downstream knob: hybrid fusion's per-kind caps, the recent-events
  // count, the snapshot count, and the eventual render ceiling.
  const budgets = resolveBudgets(settings, budgetProfile, budgetOverrides);

  // Compute the chat-id scope once and thread it through every helper.
  // - explicit selectedChats wins (per-character preference from the chat picker UI)
  // - otherwise default to the current chatId
  const chatIds = (selectedChats && selectedChats.length > 0)
    ? selectedChats
    : (chatId ? [chatId] : null);

  // ── Mention-detection-augmented active characters ──────────────
  //
  // The UI extension only knows about characters who SPEAK as themselves
  // in chat metadata (m.name) — typically just the user persona and the
  // assistant character card. Side characters the AI is voicing within a
  // single message ("Alice grunted...", "Bob held my hair") never
  // appear in m.name, so the caller's `activeCharacters` set leaves them
  // out and the trait/relationship/knowledge/location queries silently
  // omit them from the rendered memory block.
  //
  // Fix: scan `recentText` for known character names (same detector used
  // for hybrid search's graph-expansion boost) and merge those canonical
  // names into activeCharacters BEFORE the structured fetches start. This
  // is the only block that needs to run before structuredPromise; the
  // hybridSearch path below reuses the same boostCharIds for its boost.
  let boostCharIds = [];
  let mentionedNames = [];
  if (recentText) {
    const cache = getCharacterCache(chatIds && chatIds[0]);
    try {
      boostCharIds = await core.detectMentionedCharacters(pool, chatIds, recentText, cache);
    } catch (err) {
      console.warn("[ChronicleDB] detectMentionedCharacters failed:", err.message);
    }
    if (boostCharIds.length > 0) {
      try {
        const { rows } = await pool.query(
          `SELECT DISTINCT name FROM characters WHERE id = ANY($1::text[])`,
          [boostCharIds],
        );
        mentionedNames = rows.map((r) => r.name).filter(Boolean);
      } catch (err) {
        console.warn("[ChronicleDB] mentioned-name lookup failed:", err.message);
      }
    }
  }
  const augmentedActiveCharacters = Array.from(new Set([
    ...(activeCharacters || []),
    ...mentionedNames,
  ]));

  // Structured graph data (always parallel-fetchable).
  // `getRelationships`, `getRecentEvents`, `getKnowledgeBoundaries`,
  // `getWorldState`, `getPlotThreads`, `getRecentSnapshots`, `getLocations`
  // all live in the shared core now — the settings-threaded versions in
  // db.js remain for backward compatibility but this code path uses the
  // pool-parameterized variants for consistency with eval.
  //
  // Budget plumbing: the two count-bearing helpers (recent events and
  // recent snapshots) honor per-profile caps. The previous hard-coded
  // `8` and `3` are now the inject profile's defaults.
  const recentEventsLimit = Math.max(0, Number(budgets.events ?? 8));
  const recentSnapshotsLimit = Math.max(0, Number(budgets.snapshots ?? 3));
  const structuredPromise = Promise.all([
    core.getRelationships(pool, chatIds, augmentedActiveCharacters),
    core.getRecentEvents(pool, chatIds, recentEventsLimit),
    core.getKnowledgeBoundaries(pool, chatIds, augmentedActiveCharacters),
    core.getWorldState(pool, chatIds),
    core.getPlotThreads(pool, chatIds),
    core.getRecentSnapshots(pool, chatIds, recentSnapshotsLimit),
    core.getLocations(pool, chatIds, augmentedActiveCharacters),
    db.getTraitsForCharacters(settings, augmentedActiveCharacters, chatIds).catch((err) => {
      console.warn("[ChronicleDB] getTraitsForCharacters failed:", err.message);
      return [];
    }),
  ]).catch((err) => ({ __structuredError: err }));

  // Hybrid search: six-source fusion with graph expansion boost. When
  // recentText is empty (structured-only retrieve) skip the whole thing.
  let fusedHits = [];
  if (recentText) {
    let embedding = null;
    try {
      embedding = await embed(settings, recentText);
    } catch (err) {
      console.warn("[ChronicleDB] embed failed, falling back to lexical-only:", err.message);
    }

    if (embedding) {
      try {
        fusedHits = await core.hybridSearch(pool, {
          chatIds,
          embedding,
          query: recentText,
          limit: 40,
          boostCharIds,
          budgets,
        });
      } catch (err) {
        console.warn("[ChronicleDB] hybridSearch failed:", err.message);
        fusedHits = [];
      }
    } else {
      // Lexical-only fallback: still better than nothing if embed went down.
      // Honor the profile's memory cap here too — a mindmap profile with
      // memory:0 should get zero memory rows even on the fallback path.
      try {
        const lexLimit = Math.max(0, Number(budgets.memory ?? 8));
        if (lexLimit > 0) {
          const lex = await core.lexicalSearch(pool, chatIds, recentText, lexLimit);
          fusedHits = lex.map((m) => ({ kind: "memory", key: `m:${m.id}`, memory: m }));
        }
      } catch (err) {
        console.warn("[ChronicleDB] lexical fallback failed:", err.message);
      }
    }
  }

  // Neighbor padding + arc expansion in parallel (both touch the event
  // hits only; memory hits contribute the ±1 padding indices).
  const [neighborPadding, arcExpansion] = await Promise.all([
    core.fetchNeighborPadding(pool, chatIds, fusedHits),
    core.fetchArcExpansion(
      pool,
      fusedHits.filter((h) => h.kind === "event" && h.event).map((h) => h.event.id),
    ),
  ]);

  const structured = await structuredPromise;
  if (structured && structured.__structuredError) throw structured.__structuredError;
  const [relationships, events, knowledge, worldState, plotThreads, snapshots, locations, traits] = structured;

  const result = {
    relationships,
    events,
    knowledge,
    worldState,
    plotThreads,
    snapshots,
    locations,
    traits,
    fusedHits,
    neighborPadding,
    arcExpansion,
    // Legacy field names downstream of retriever.js still expect
    // vectorResults/eventHits/dialogueHits; formatMemoryBlock now pulls
    // from fusedHits instead, but other callers (e.g. /retrieve HTTP
    // response shape) may peek at the raw arrays. Expose the per-kind
    // views as a courtesy.
    vectorResults: fusedHits.filter((h) => h.kind === "memory").map((h) => h.memory),
    eventHits: fusedHits.filter((h) => h.kind === "event").map((h) => h.event),
    dialogueHits: fusedHits.filter((h) => h.kind === "dialogue").map((h) => h.dialogue),
    // Expose the resolved budget so /retrieve + formatMemoryBlock can
    // honor maxTokens without re-deriving it. Debug surfaces also peek
    // at this to explain which profile was picked.
    budgets,
  };

  // ── POV epistemic mask ──
  // When the caller supplies `pov`, derive the character's known
  // universe once and post-filter `result` in place. When `pov` is
  // undefined the behavior above is unchanged (bit-for-bit) — this
  // block is a no-op for every legacy caller.
  if (pov && pov.characterName && chatId) {
    try {
      const universe = await db.getCharacterKnownUniverse(settings, {
        characterName: pov.characterName,
        chatId,
        upToMessageIndex: pov.upToMessageIndex,
      });
      applyPovFilter(result, universe);
      // Expose the mask cardinality on the result for debug surfaces
      // and eval instrumentation. Not a Set — JSON-safe counts only.
      result.pov = {
        characterName: pov.characterName,
        upToMessageIndex: pov.upToMessageIndex ?? null,
        maskCardinality: {
          events: universe.eventIds.size,
          facts: universe.factIds.size,
          locations: universe.locationIds.size,
          items: universe.itemIds.size,
          characters: universe.characterIds.size,
        },
      };
    } catch (err) {
      // POV-filtering is a best-effort overlay; a failure shouldn't
      // nuke the whole retrieve call. Fall back to omniscient retrieval
      // and log so the caller can debug.
      console.warn("[ChronicleDB] POV filter failed, returning unmasked result:", err.message);
    }
  }

  return result;
}

/**
 * Format retrieval results into the injection block via the shared
 * SECTION_REGISTRY. ST historically passed `maxTokens` (not `maxChars`);
 * we convert at the boundary — 4 chars ≈ 1 token.
 *
 * When `result.budgets.maxTokens` is present (any path that went through
 * `retrieve()` above), it's used as the default ceiling so per-profile
 * budgets flow all the way to render. An explicit `maxTokens` arg still
 * wins over the profile value for callers that want a one-off override.
 */
function formatMemoryBlock(result, maxTokens) {
  const profileMax = result && result.budgets && Number(result.budgets.maxTokens);
  const effective = (typeof maxTokens === "number" && Number.isFinite(maxTokens))
    ? maxTokens
    : (Number.isFinite(profileMax) && profileMax > 0 ? profileMax : 1500);
  return core.formatMemoryBlock(result, effective * 4);
}

module.exports = { retrieve, formatMemoryBlock, BUDGET_PROFILES, resolveBudgets };
