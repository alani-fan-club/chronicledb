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
const { BUDGET_PROFILES, resolveBudgets } = require("../shared/retrieval-budgets");
const { applyPovFilter } = require("../shared/retrieval-pov");

// Chat-scoped character index cache for graph expansion. Long-lived
// process → keep a per-chat Map with 5-minute TTL so chat-switching
// doesn't re-query characters every turn. The shared detector checks
// `expiresAt` and refreshes when stale.
const characterCacheByChat = new Map();
const CHARACTER_CACHE_TTL_MS = 5 * 60 * 1000;

function getCharacterCache(chatId) {
  if (!chatId) return null;
  let cache = characterCacheByChat.get(chatId);
  if (!cache) {
    cache = { chatId, entries: [], expiresAt: 0 };
    characterCacheByChat.set(chatId, cache);
  }
  // If we ever grow many long-lived chats, an LRU eviction goes here.
  // For now we leak a handful of Maps per process, which is negligible.
  return cache;
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
    core.getRelationships(pool, chatIds, activeCharacters || []),
    core.getRecentEvents(pool, chatIds, recentEventsLimit),
    core.getKnowledgeBoundaries(pool, chatIds, activeCharacters || []),
    core.getWorldState(pool, chatIds),
    core.getPlotThreads(pool, chatIds),
    core.getRecentSnapshots(pool, chatIds, recentSnapshotsLimit),
    core.getLocations(pool, chatIds, activeCharacters || []),
  ]);

  // Hybrid search: six-source fusion with graph expansion boost. When
  // recentText is empty (structured-only retrieve) skip the whole thing.
  let fusedHits = [];
  let boostCharIds = [];
  if (recentText) {
    // Detect mentioned characters for the graph expansion boost.
    // Shared detector — cache scoped per chat, 5-min TTL, LRU-ish.
    const cache = getCharacterCache(chatIds && chatIds[0]);
    if (cache && cache.expiresAt === 0) cache.expiresAt = Date.now() + CHARACTER_CACHE_TTL_MS;
    try {
      boostCharIds = await core.detectMentionedCharacters(pool, chatIds, recentText, cache);
    } catch (err) {
      console.warn("[ChronicleDB] detectMentionedCharacters failed:", err.message);
    }

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

  const [relationships, events, knowledge, worldState, plotThreads, snapshots, locations] = await structuredPromise;

  const result = {
    relationships,
    events,
    knowledge,
    worldState,
    plotThreads,
    snapshots,
    locations,
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
