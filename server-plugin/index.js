/**
 * ChronicleDB — SillyTavern Server Plugin
 * Persistent graph+vector memory for RP.
 *
 * ST server plugins export: init(router), exit(), info
 */

const db = require("./db");
const {
  extract,
  embed,
  applyExtractionToGraph,
  applyMessagesToVectorStore,
} = require("./extractor");
const { retrieve, formatMemoryBlock } = require("./retriever");
const { ingestLorebook, listLorebooks } = require("./lorebook");
const { safeResolveUnder } = require("./path-safety");
const { setWithBoundedEviction } = require("./bounded-map");
const { resolveStDataRoot } = require("./st-paths");
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require("fs");
const { resolve: pathResolve, dirname: pathDirname } = require("path");

let settings = {};
// Tracks live DB state so /status can report it without touching the pool.
let connectionState = { connected: false, error: null, initializedAt: null };

// Settings are cached on disk so the server can auto-reconnect on ST boot
// without waiting for the UI extension to push them via /settings.
const SETTINGS_CACHE_PATH = pathResolve(__dirname, ".settings-cache.json");

function loadCachedSettings() {
  try {
    if (!existsSync(SETTINGS_CACHE_PATH)) return null;
    return JSON.parse(readFileSync(SETTINGS_CACHE_PATH, "utf-8"));
  } catch (err) {
    console.warn("[ChronicleDB] Failed to read cached settings:", err.message);
    return null;
  }
}

function saveCachedSettings(s) {
  try {
    const dir = pathDirname(SETTINGS_CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SETTINGS_CACHE_PATH, JSON.stringify(s, null, 2));
  } catch (err) {
    console.warn("[ChronicleDB] Failed to cache settings:", err.message);
  }
}

// Recognize pg/node connectivity failures so routes can flip
// connectionState. Covers: refused / DNS / timeout / admin shutdown /
// crash shutdown / cannot_connect_now, plus the catch-all "Connection
// terminated" message pg emits when an active client loses its socket.
// Used by /extract, /retrieve, and the /status probe; intentionally
// over-inclusive so a real outage always flips state even if pg adds
// new error codes in future versions.
function isDbConnectivityError(err) {
  if (!err) return false;
  const code = err.code || "";
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
       "57P01", "57P02", "57P03", "08000", "08003", "08006"].includes(code)) return true;
  const msg = String(err.message || "").toLowerCase();
  return /connect|terminat|socket|refused|not found|timeout/.test(msg);
}

function markDisconnected(err) {
  connectionState = {
    connected: false,
    error: err?.message || String(err),
    initializedAt: null,
  };
}

function readOptionalQueryString(query, key) {
  const raw = query && typeof query[key] === "string"
    ? query[key].trim()
    : "";
  return raw.length > 0 ? raw : null;
}

function readOptionalChatId(query) {
  return readOptionalQueryString(query, "chat_id");
}

function readOptionalChatIds(query) {
  const raw = readOptionalChatId(query);
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function readRequiredRequestValue(res, source, key) {
  const value = source && source[key];
  if (value) return value;
  res.status(400).json({ error: `${key} required` });
  return null;
}

function sendInternalError(res, err) {
  res.status(500).json({ error: err.message });
}

async function fetchAndVerifyConfiguredDbIdentity(activeSettings) {
  const pool = db.getPool(activeSettings);
  const { rows: [verify] } = await pool.query(
    `SELECT current_user AS u, current_database() AS d`,
  );

  const expectedUser = (activeSettings.pgUser || "").trim();
  const expectedDb = (activeSettings.pgDatabase || "").trim();

  if (expectedUser && verify.u !== expectedUser) {
    throw new Error(
      `Connected as "${verify.u}" but settings configured user "${expectedUser}". ` +
      `Postgres trust/peer auth ignored your username — fix pg_hba.conf to require ` +
      `password auth, or update the user field to "${verify.u}" to match what Postgres ` +
      `actually logged you in as.`,
    );
  }
  if (expectedDb && verify.d !== expectedDb) {
    throw new Error(
      `Connected to database "${verify.d}" but settings configured "${expectedDb}". ` +
      `Check the database name field.`,
    );
  }

  return verify;
}

async function tryAutoConnect() {
  if (!settings.pgHost || !settings.pgDatabase) {
    connectionState = { connected: false, error: null, initializedAt: null };
    return;
  }
  try {
    await db.initSchema(settings);
    // Postgres trust auth (and peer auth on Unix sockets) ignore the
    // username field — they accept the connection as whatever role
    // the OS user maps to. So a typo in pgUser will silently "succeed"
    // and then every subsequent query runs as a different role than
    // the user thinks. Verify after connect: query SELECT current_user
    // and current_database, compare to the configured values, and
    // surface a hard error if either drifts. This catches the
    // "I had a wrong username for the database and the plugin didn't
    // catch it" failure mode reported by friends during install.
    const verify = await fetchAndVerifyConfiguredDbIdentity(settings);
    connectionState = {
      connected: true,
      error: null,
      initializedAt: new Date().toISOString(),
    };
    console.log(`[ChronicleDB] Auto-connected to database "${verify.d}" as "${verify.u}".`);
  } catch (err) {
    connectionState = {
      connected: false,
      error: err.message,
      initializedAt: null,
    };
    console.error("[ChronicleDB] Auto-connect failed:", err.message);
  }
}

/**
 * Plugin info — displayed in ST's plugin list.
 */
const info = {
  id: "chronicle-db",
  name: "ChronicleDB",
  description: "Persistent graph+vector memory for roleplay — tracks relationships, events, knowledge boundaries, and world state",
};

/**
 * Initialize the plugin. ST passes an Express router scoped to
 * /api/plugins/chronicle-db/
 */
async function init(router) {
  console.log("[ChronicleDB] Initializing server plugin...");

  // Hook pool-level idle-client errors so a DB restart or network blip
  // flips connectionState instead of silently killing queries. Without
  // this the plugin would keep reporting connected=true while every
  // subsequent query fails.
  db.setPoolErrorHandler((err) => {
    console.error("[ChronicleDB] Pool error (idle client):", err?.message || err);
    markDisconnected(err);
  });

  // Hydrate settings from the on-disk cache so we can auto-reconnect before
  // the UI extension pushes anything via POST /settings.
  const cached = loadCachedSettings();
  if (cached) {
    settings = { ...settings, ...cached };
    if (cached.initialized) {
      // Fire and forget — don't block plugin init on DB reachability.
      tryAutoConnect().catch(() => {});
    }
  }

  // ── Serve mind map UI ────────────────────────────────────────
  const { resolve, dirname } = require("path");
  const { realpathSync } = require("fs");
  const express = require("express");
  // Resolve through symlink to find the actual project root
  const pluginRealDir = realpathSync(__dirname);
  const mapPath = resolve(pluginRealDir, "..", "src", "ui");
  console.log("[ChronicleDB] Mind map path:", mapPath);
  router.use("/map", express.static(mapPath));

  // ── Settings endpoint (UI extension saves/loads settings here) ──

  router.post("/settings", async (req, res) => {
    const prev = settings;
    settings = { ...settings, ...req.body };
    saveCachedSettings(settings);

    // If credentials changed while we weren't connected, attempt reconnect
    // in the background. Idempotent initSchema makes this safe to re-run.
    const credsChanged =
      prev.pgHost !== settings.pgHost ||
      prev.pgPort !== settings.pgPort ||
      prev.pgDatabase !== settings.pgDatabase ||
      prev.pgUser !== settings.pgUser ||
      prev.pgPassword !== settings.pgPassword;
    if (settings.initialized && (credsChanged || !connectionState.connected)) {
      tryAutoConnect().catch(() => {});
    }

    res.json({ ok: true });
  });

  router.get("/settings", (_req, res) => {
    res.json(settings);
  });

  // ── Connection status ────────────────────────────────────────

  router.get("/status", async (_req, res) => {
    // Probe the pool on every poll so the UI catches runtime DB outages
    // (DB restart, network blip, admin shutdown) without waiting for the
    // next /extract or /retrieve to fail. Also surfaces recovery: if we
    // previously flipped to error but the DB is back, SELECT 1 succeeds
    // and we restore connected=true. SELECT 1 on a warm pool is
    // microseconds so a 30s client poll is effectively free.
    if (settings.pgHost && settings.pgDatabase) {
      try {
        await db.getPool(settings).query("SELECT 1");
        if (!connectionState.connected) {
          connectionState = {
            connected: true,
            error: null,
            initializedAt: new Date().toISOString(),
          };
          console.log("[ChronicleDB] DB reachable again — connectionState restored.");
        }
      } catch (err) {
        if (connectionState.connected || !connectionState.error) {
          console.warn("[ChronicleDB] /status probe failed:", err.message);
        }
        markDisconnected(err);
      }
    }
    res.json({
      connected: connectionState.connected,
      error: connectionState.error,
      initializedAt: connectionState.initializedAt,
      configured: Boolean(settings.pgHost && settings.pgDatabase),
    });
  });

  // ── Schema init ──────────────────────────────────────────────

  router.post("/init-db", async (_req, res) => {
    try {
      await db.initSchema(settings);
      // Same trust-auth verification as tryAutoConnect — a user clicking
      // "Connect & initialize" with a wrong username typo should see a
      // clear error in the UI, not a green checkmark followed by silent
      // query failures later.
      const verify = await fetchAndVerifyConfiguredDbIdentity(settings);
      connectionState = {
        connected: true,
        error: null,
        initializedAt: new Date().toISOString(),
      };
      // Persist the fact that we've initialized so subsequent ST boots
      // know to auto-reconnect. The UI also sets this flag, but doing it
      // here too means standalone /init-db POSTs still work.
      settings.initialized = true;
      saveCachedSettings(settings);
      res.json({ ok: true, user: verify.u, database: verify.d });
    } catch (err) {
      connectionState = { connected: false, error: err.message, initializedAt: null };
      console.error("[ChronicleDB] DB init error:", err);
      sendInternalError(res, err);
    }
  });

  // ── Extraction endpoint ──────────────────────────────────────
  // Called by UI ext after GENERATION_ENDED (async, non-blocking)

  // Per-chat state for the incremental arc-rebuild trigger. Tracks the
  // event_count value as of the last rebuild and a mutex so concurrent
  // /extract calls for the same chat can't double-rebuild.
  // Resets on plugin restart, which is fine — the worst case is the very
  // first /extract after restart waits a few extra messages to fire.
  const ARC_REBUILD_CACHE_MAX = 200;
  const arcRebuildLastCount = new Map(); // chatId -> int
  const arcRebuildInFlight = new Set();  // chatId

  // Bounded eviction. Both maps accumulate one entry per chat_id forever,
  // so a long-running ST process with many chats grows unboundedly. Cap at
  // ARC_REBUILD_CACHE_MAX entries and evict the oldest (Map preserves insertion order, so
  // `keys().next().value` is the least-recently-inserted). Use this wrapper
  // instead of `arcRebuildLastCount.set(chatId, n)` directly.
  function setArcRebuildCount(chatId, n) {
    setWithBoundedEviction(arcRebuildLastCount, chatId, n, ARC_REBUILD_CACHE_MAX, {
      // Set.delete(value) is a no-op if the value isn't present, so this is
      // safe even when the evicted chat has no in-flight rebuild.
      onEvict: (evictedChatId) => arcRebuildInFlight.delete(evictedChatId),
    });
  }

  // Per-(chatId, messageIndex) extract mutex. When two /extract calls
  // land for the same message — typically because the user generated
  // a swipe, then immediately swiped to regenerate before the first
  // extract finished — they would otherwise race: the slower one's
  // INSERTs land last and overwrite the faster one's, regardless of
  // which is "current". This Map keys an in-flight Promise per
  // (chatId, messageIndex) so the second call awaits the first to
  // finish before running its own DELETE+INSERT cycle. Latest writer
  // (in completion order) wins, which because of the swipe-cleanup
  // hook always corresponds to the user's currently-active swipe.
  const extractMutex = new Map(); // key: `${chatId}::${messageIndex}` -> Promise

  router.post("/extract", async (req, res) => {
    const { characterName, userName, messages, chatId, messageIndex } = req.body;
    const mutexKey = chatId && typeof messageIndex === "number"
      ? `${chatId}::${messageIndex}`
      : null;
    // Wait for any in-flight extract on the same message to finish so
    // we serialize concurrent writers for the same (chatId, msgIdx).
    // The key is intentionally per-message: parallel extracts for
    // different messages still run concurrently.
    if (mutexKey && extractMutex.has(mutexKey)) {
      try { await extractMutex.get(mutexKey); } catch { /* prior call's error is its own */ }
    }
    let release;
    let myPromise = null;
    if (mutexKey) {
      myPromise = new Promise((resolve) => { release = resolve; });
      extractMutex.set(mutexKey, myPromise);
    }
    try {
      // 0. Idempotent: if a previous extract wrote rows for this exact
      //    (chatId, messageIndex), wipe them before re-extracting. Keeps
      //    the live path's per-message extraction overwrite-clean even
      //    when the swipe-cleanup hook hasn't fired yet (or fired late).
      //    /ingest-chat keeps its own drop-and-rebuild semantics so
      //    bulk ingests are unaffected.
      if (mutexKey) {
        try {
          const pool = db.getPool(settings);
          await pool.query(
            `DELETE FROM participated_in
             WHERE event_id IN (SELECT id FROM events WHERE chat_id = $1 AND message_index = $2)`,
            [chatId, messageIndex],
          );
          await pool.query(`DELETE FROM events           WHERE chat_id = $1 AND message_index = $2`, [chatId, messageIndex]);
          await pool.query(`DELETE FROM memory_embeddings WHERE chat_id = $1 AND message_index = $2`, [chatId, messageIndex]);
          await pool.query(`DELETE FROM dialogue_quotes  WHERE chat_id = $1 AND message_index = $2`, [chatId, messageIndex]);
          await pool.query(`DELETE FROM context_snapshots WHERE chat_id = $1 AND message_index = $2`, [chatId, messageIndex]);
          await pool.query(`DELETE FROM traits WHERE source_chat = $1 AND source_message_index = $2`, [chatId, messageIndex]);
        } catch (err) {
          console.warn(`[ChronicleDB] /extract idempotent pre-clean failed (${err.message}); proceeding anyway`);
        }
      }

      // 1. Extract structured data from messages. chatId is plumbed in so
      //    the extractor can fetch already-known entities for this chat
      //    and inject them into the prompt, so the LLM stops re-naming
      //    existing characters/locations/items on every batch.
      const extraction = await extract(settings, { characterName, userName, messages, chatId });

      // 2. Graph writes — single source of truth in extractor.js. Previously
      //    this route reimplemented ~180 lines of upserts and was missing
      //    event_chains, story_arcs, locations_detail, items, and present_at.
      await applyExtractionToGraph(settings, {
        extraction,
        chatId,
        charName: characterName,
        userName,
        messageIndex,
        batchSize: (messages || []).length,
      });

      // 3. Vector writes — chunk + situating blurb + per-msg embed +
      //    dialogue quote extraction. Previously this route only stored a
      //    single "conversation" blob embed per batch, losing chunking and
      //    missing dialogue quotes entirely. In the live path `messages`
      //    is only the recent batch (not the full chat), so batchStart=0
      //    but messageIndexOffset is whatever ST told us the batch sits at
      //    in the full-chat timeline.
      const ctxWindow = settings.ingestContextWindow ?? 4;
      await applyMessagesToVectorStore(settings, {
        messages,
        chatBatch: messages,
        batchStart: 0,
        messageIndexOffset: typeof messageIndex === "number" ? messageIndex : 0,
        chatId,
        ctxWindow,
      });

      // Respond to ST immediately — arc rebuild fires async below.
      res.json({ ok: true, extraction });

      // 4. Periodic arc rebuild on the auto-ingest path. Fire ~every N
      //    new events (default 30, settings.arcRebuildEveryN). Skipped
      //    when the setting is 0, when chatId is missing, when a previous
      //    rebuild for the same chat is still in flight, or when the
      //    chat hasn't accumulated enough new events since the last
      //    rebuild. Recycled-title snapshot in arc-builder.js means the
      //    typical incremental rebuild only LLM-names new clusters
      //    (usually 0-3) instead of all 35, so cost stays bounded.
      const rebuildEveryN = Number(settings.arcRebuildEveryN ?? 30);
      if (rebuildEveryN > 0 && chatId && !arcRebuildInFlight.has(chatId)) {
        try {
          const pool = db.getPool(settings);
          const { rows: [{ n }] } = await pool.query(
            `SELECT COUNT(*)::int AS n FROM events WHERE chat_id = $1`,
            [chatId],
          );
          const lastN = arcRebuildLastCount.get(chatId) || 0;
          if (n - lastN >= rebuildEveryN) {
            arcRebuildInFlight.add(chatId);
            setArcRebuildCount(chatId, n);
            // Fire and forget — no await. Errors go to the log only.
            (async () => {
              try {
                const { rebuildArcsForChat } = require("./arc-builder");
                const r = await rebuildArcsForChat(settings, chatId, {
                  nameArcs: true, nameHierarchy: true,
                });
                console.log(
                  `[ChronicleDB] Incremental arc rebuild for ${chatId}: ` +
                  `${r.builtArcs} arcs (${r.namedArcs ?? 0} new LLM-named, ${r.recycledArcs ?? 0} recycled), ` +
                  `${r.superArcs} super (${r.namedSuperArcs ?? 0} new, ${r.recycledSuperArcs ?? 0} recycled), ` +
                  `${r.episodes} episodes (${r.namedEpisodes ?? 0} new, ${r.recycledEpisodes ?? 0} recycled), ` +
                  `Q=${(r.modularityQ ?? 0).toFixed(3)}, N=${r.totalEvents}`,
                );
              } catch (err) {
                console.warn(`[ChronicleDB] Incremental arc rebuild failed for ${chatId}: ${err.message}`);
              } finally {
                arcRebuildInFlight.delete(chatId);
              }
            })();
          }
        } catch (err) {
          // Counting query failed — log and continue, don't break ingest
          console.warn(`[ChronicleDB] Arc-rebuild counter check failed: ${err.message}`);
        }
      }
    } catch (err) {
      console.error("[ChronicleDB] Extraction error:", err);
      // Connectivity failures (DB down, pool can't connect) flip the
      // plugin's connectionState so the UI's /status poll sees the outage
      // immediately instead of waiting for an idle-client error to bubble
      // up through pool.on('error').
      if (isDbConnectivityError(err)) markDisconnected(err);
      // res.json may have already been sent if we got past step 3 — guard.
      if (!res.headersSent) {
        sendInternalError(res, err);
      }
    } finally {
      // Release the per-message mutex so the next /extract for the same
      // (chatId, messageIndex) can proceed. Done in `finally` so failures,
      // background-rebuild errors, and the success path all release.
      if (mutexKey) {
        try {
          if (release) release();
          // Only delete the entry if it is *identically* our own promise.
          // The previous check (`extractMutex.get(mutexKey) && release`)
          // was always true when `release` was truthy, so a stale finally
          // could delete a newer call's in-flight promise, causing a
          // third call to skip the mutex entirely and race. Identity
          // compare to `myPromise` so newer calls keep their own entries
          // and clean up in their own finally.
          if (extractMutex.get(mutexKey) === myPromise) {
            extractMutex.delete(mutexKey);
          }
        } catch (_) { /* never block the request on cleanup */ }
      }
    }
  });

  // ── Swipe cleanup endpoint ───────────────────────────────────
  // Called by the UI extension when the user changes the active swipe on an
  // already-extracted message. Without this, every swipe-right leaves the
  // previous swipe's events / quotes / embeddings in the DB forever.
  //
  // Caveats:
  //  - Traits don't carry message_index, so a swipe that introduces or
  //    removes traits will leave stale traits behind. The trait dedup
  //    pipeline (lexicon gate + canonical-row kNN) means most stale traits
  //    eventually get re-merged or rejected on the next extraction, but
  //    pure noise-traits from a discarded swipe will linger. Tagging traits
  //    with a source (chat_id, message_index) is a separate follow-up.
  //  - arc_events.event_id has ON DELETE CASCADE (schema.sql:234), so the
  //    rows referencing events we delete here are cleaned up automatically
  //    by the events DELETE below. event_chains.from_event_id /
  //    to_event_id are also CASCADE (schema.sql:243-244).
  //  - participated_in.event_id does NOT have ON DELETE CASCADE
  //    (schema.sql:124), so we have to clear those rows by hand before
  //    deleting events — same pattern as the manual reingest scripts.
  //  - The next /extract for the new active swipe will rewrite events with
  //    new content-addressed ids, so re-extraction is the rebuild step.
  router.post("/clear-message-extractions", async (req, res) => {
    try {
      const { chatId, messageIndex } = req.body;
      if (!chatId || typeof messageIndex !== "number") {
        return res.status(400).json({ error: "chatId and messageIndex required" });
      }
      const pool = db.getPool(settings);
      // Order matters: participated_in references events.id without ON
      // DELETE CASCADE, so we have to clear those rows before deleting the
      // events themselves (same pattern the manual reingest scripts use).
      await pool.query(
        `DELETE FROM participated_in
         WHERE event_id IN (SELECT id FROM events WHERE chat_id = $1 AND message_index = $2)`,
        [chatId, messageIndex],
      );
      const eventsRes = await pool.query(
        `DELETE FROM events WHERE chat_id = $1 AND message_index = $2 RETURNING id`,
        [chatId, messageIndex],
      );
      const memRes = await pool.query(
        `DELETE FROM memory_embeddings WHERE chat_id = $1 AND message_index = $2 RETURNING id`,
        [chatId, messageIndex],
      );
      const quoteRes = await pool.query(
        `DELETE FROM dialogue_quotes WHERE chat_id = $1 AND message_index = $2 RETURNING id`,
        [chatId, messageIndex],
      );
      const snapRes = await pool.query(
        `DELETE FROM context_snapshots WHERE chat_id = $1 AND message_index = $2 RETURNING id`,
        [chatId, messageIndex],
      );
      // Trait cleanup: traits now carry source_message_index (added in the
      // schema migration that introduced this column). Rows pre-dating the
      // column have NULL and are intentionally skipped — we don't know
      // which message they came from. Future swipes on the same message
      // clean up cleanly because new traits are tagged at write time.
      const traitRes = await pool.query(
        `DELETE FROM traits WHERE source_chat = $1 AND source_message_index = $2 RETURNING id`,
        [chatId, messageIndex],
      );
      res.json({
        ok: true,
        deleted: {
          events: eventsRes.rowCount,
          memory_embeddings: memRes.rowCount,
          dialogue_quotes: quoteRes.rowCount,
          context_snapshots: snapRes.rowCount,
          traits: traitRes.rowCount,
        },
      });
    } catch (err) {
      console.error("[ChronicleDB] /clear-message-extractions error:", err);
      sendInternalError(res, err);
    }
  });

  // ── Retrieval endpoint ───────────────────────────────────────
  // Called by UI ext before GENERATION_STARTED

  router.post("/retrieve", async (req, res) => {
    try {
      const {
        chatId,
        characterName,
        activeCharacters,
        recentText,
        sessionId,
        maxTokens,
        budgetProfile,
        budgetOverrides,
        pov,
      } = req.body;

      // Load per-character config to know which chats to remember
      const charConfig = characterName
        ? await db.getCharacterMemoryConfig(settings, characterName)
        : { sessionMode: "persistent", selectedChats: [] };

      // Honor the chat picker. If the user hasn't picked any chats, fall back
      // to the current chatId so retrieval is at least scoped to this chat
      // (avoids cross-chat pollution between e.g. ChatB and Protagonist).
      const configuredChats = Array.isArray(charConfig.selectedChats) ? charConfig.selectedChats : [];
      const selectedChats = configuredChats.length > 0
        ? configuredChats
        : (chatId ? [chatId] : []);

      // AGARS per-character epistemic mask: optional `pov` payload on
      // the /retrieve request threads through to retriever.js as a
      // post-filter over the omniscient result. When the caller omits
      // `pov`, retrieve() behaves bit-for-bit as before.
      //
      // Shape: `{ characterName: string, upToMessageIndex?: number }`.
      // Defensive normalization: accept either a string characterName
      // or nothing; an empty string is treated as "no POV" so the
      // downstream call can no-op without a special case.
      const povArg = (pov && typeof pov === "object" && typeof pov.characterName === "string" && pov.characterName.trim().length > 0)
        ? {
            characterName: pov.characterName.trim(),
            upToMessageIndex: typeof pov.upToMessageIndex === "number" ? pov.upToMessageIndex : undefined,
          }
        : undefined;

      const result = await retrieve(settings, {
        chatId,
        activeCharacters: activeCharacters || [],
        recentText: recentText || "",
        sessionMode: charConfig.sessionMode || "persistent",
        sessionId,
        selectedChats, // scoped chat IDs (defaults to [chatId] when no preference set)
        budgetProfile,
        budgetOverrides,
        pov: povArg,
      });

      // Precedence for the render ceiling:
      //   1. explicit req.body.maxTokens (legacy one-off override)
      //   2. result.budgets.maxTokens (from the resolved profile, which
      //      already honors settings.maxInjectionTokens and explicit
      //      per-field budgetOverrides)
      //   3. 1500 fallback (unchanged)
      // retriever.js::formatMemoryBlock already prefers result.budgets
      // when no maxTokens is passed, so we only pass a value when the
      // caller explicitly asked for one.
      const memoryBlock = typeof maxTokens === "number"
        ? formatMemoryBlock(result, maxTokens)
        : formatMemoryBlock(result);
      res.json({ result, memoryBlock });
    } catch (err) {
      console.error("[ChronicleDB] Retrieval error:", err);
      if (isDbConnectivityError(err)) markDisconnected(err);
      sendInternalError(res, err);
    }
  });

  // ── Per-character memory config ────────────────────────────────
  // Tied to character card: stores which chats this character remembers

  router.get("/character-config/:characterName", async (req, res) => {
    try {
      const config = await db.getCharacterMemoryConfig(settings, req.params.characterName);
      res.json(config);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.post("/character-config/:characterName", async (req, res) => {
    try {
      await db.saveCharacterMemoryConfig(settings, {
        characterName: req.params.characterName,
        sessionMode: req.body.sessionMode,
        selectedChats: req.body.selectedChats,
      });
      res.json({ ok: true });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // ── List chats for a character (reads ST data dir) ───────────

  router.get("/chats/:characterName", async (req, res) => {
    try {
      const { readdirSync, statSync } = require("fs");
      const { join, resolve } = require("path");

      const dataRoot = resolveStDataRoot(settings);
      const chatsBase = resolve(dataRoot, "chats");
      const charName = req.params.characterName;
      const entries = readdirSync(chatsBase);
      const matchingDir = entries.find((e) => e === charName || e.startsWith(charName));

      if (!matchingDir) return res.json([]);

      const dirPath = join(chatsBase, matchingDir);
      if (!statSync(dirPath).isDirectory()) return res.json([]);

      const chatFiles = readdirSync(dirPath)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .map((f) => {
          const stat = statSync(join(dirPath, f));
          const dateMatch = f.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
          // Count actual message lines (subtract 1 for metadata header)
          let messageCount;
          try {
            const content = require("fs").readFileSync(join(dirPath, f), "utf-8");
            messageCount = content.split("\n").filter((l) => l.trim()).length - 1;
          } catch {
            messageCount = Math.max(1, Math.floor(stat.size / 2000));
          }
          return {
            filename: f,
            chatId: f.replace(".jsonl", ""),
            date: dateMatch ? dateMatch[1] : "",
            size: stat.size,
            messageEstimate: Math.max(0, messageCount),
          };
        });

      // Enrich with ingestion status
      try {
        const p = db.getPool(settings);
        const { rows: statuses } = await p.query(
          `SELECT chat_file, status, batches_done, ingested_at FROM ingestion_status WHERE character_name = $1`,
          [charName],
        );
        const statusMap = new Map(statuses.map((s) => [s.chat_file, s]));
        for (const chat of chatFiles) {
          const s = statusMap.get(chat.filename);
          if (s) {
            chat.ingested = s.status === "done";
            chat.ingestStatus = s.status;
            chat.ingestedAt = s.ingested_at;
            chat.batchesDone = s.batches_done;
          }
        }
      } catch { /* status table might not exist yet */ }

      res.json(chatFiles);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // ── Chat ingestion (backfill a specific chat file) ───────────

  router.post("/ingest-chat", async (req, res) => {
    try {
      const { characterName, filename } = req.body;
      if (!characterName || !filename) {
        return res.status(400).json({ error: "characterName and filename required" });
      }
      // Reject traversal-y characterName up front. The directory-picking
      // logic below uses a fuzzy `startsWith` match on `characterName`, so
      // feeding it `../../../../etc` would otherwise try to resolve
      // outside `chatsBase`. Blocking the raw input is the simplest gate.
      if (typeof characterName !== "string"
          || characterName.length === 0
          || characterName.includes("..")
          || characterName.includes("\0")
          || characterName.includes("/")
          || characterName.includes("\\")) {
        return res.status(400).json({ error: `unsafe characterName: "${characterName}"` });
      }

      const { readFileSync } = require("fs");
      const { resolve } = require("path");

      const dataRoot = resolveStDataRoot(settings);
      const chatsBase = resolve(dataRoot, "chats");

      // Find matching directory
      const { readdirSync } = require("fs");
      const entries = readdirSync(chatsBase);
      const matchingDir = entries.find((e) => e === characterName || e.startsWith(characterName));
      if (!matchingDir) return res.status(404).json({ error: "Character chat dir not found" });

      // Re-verify the selected directory actually lives under chatsBase
      // (readdirSync can't normally return traversal entries, but this is
      // defense-in-depth against a compromised ST data dir or a follower
      // symlink). Then resolve the chat JSONL filename safely under that
      // directory so `filename` can't escape either.
      let matchedDir;
      let filePath;
      try {
        matchedDir = safeResolveUnder(chatsBase, matchingDir);
        filePath = safeResolveUnder(matchedDir, filename);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      if (lines.length === 0) return res.status(400).json({ error: "Empty chat file" });

      // Parse metadata from first line
      const metadata = JSON.parse(lines[0]);
      const charName = metadata.character_name || characterName;
      const userName = metadata.user_name || "User";
      const chatId = filename.replace(".jsonl", "");

      // Parse messages
      const messages = [];
      for (let i = 1; i < lines.length; i++) {
        try {
          const msg = JSON.parse(lines[i]);
          // Skip system messages and empty messages
          if (msg.mes !== undefined && !msg.is_system) messages.push(msg);
        } catch { /* skip malformed */ }
      }

      // Process in batches with parallel extraction. Concurrency is
      // settings-driven (default 1) because the Gemini free tier chokes
      // at higher concurrency; paid tiers can safely run 2-4.
      const batchSize = settings.extractionBatchSize ?? 10;
      const concurrency = Math.max(1, settings.extractionConcurrency ?? 1);
      const ctxWindow = settings.ingestContextWindow ?? 4;
      let extracted = 0;
      const totalBatches = Math.ceil(messages.length / batchSize);

      // Build all batches upfront.
      const allBatches = [];
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize).map((m) => ({
          name: m.name,
          is_user: m.is_user,
          is_system: m.is_system || false,
          mes: m.swipe_id !== undefined && m.swipes?.[m.swipe_id] ? m.swipes[m.swipe_id] : m.mes,
          send_date: m.send_date,
        }));
        allBatches.push({ batchIdx: i, batch });
      }

      for (let g = 0; g < allBatches.length; g += concurrency) {
        const group = allBatches.slice(g, g + concurrency);

        // Parallel extraction LLM calls — the only part that benefits from
        // concurrency; DB writes downstream must stay serial to avoid
        // deadlocks on shared entity rows.
        const extractionResults = await Promise.allSettled(
          group.map(({ batch }) =>
            extract(settings, { characterName: charName, userName, messages: batch })
          ),
        );

        for (let k = 0; k < group.length; k++) {
          const { batchIdx: i, batch } = group[k];
          const er = extractionResults[k];
          if (er.status !== "fulfilled") {
            console.warn(`[ChronicleDB] Batch ${i} extraction failed:`, er.reason?.message);
            continue;
          }
          const extraction = er.value;

          try {
            await applyExtractionToGraph(settings, {
              extraction,
              chatId,
              charName,
              userName,
              messageIndex: i,
              batchSize: batch.length,
            });
            await applyMessagesToVectorStore(settings, {
              messages,
              chatBatch: batch,
              batchStart: i,
              messageIndexOffset: i,
              chatId,
              ctxWindow,
            });
            extracted++;
          } catch (err) {
            console.warn(`[ChronicleDB] Ingest batch ${i} error:`, err.message, err.stack?.split("\n").slice(0, 3).join(" | "));
          }
        }
      }

      // Path 1: after the batch loop completes, rebuild arcs structurally
      // over the full chat's events via Louvain community detection on a
      // weighted event graph. Non-fatal — ingest succeeds even if clustering
      // fails. See RESEARCH_ARCS.md §5 Path 1 and arc-builder.js.
      //
      // Path 4 + 5: `nameArcs: true` LLM-names level-1 arcs; `nameHierarchy:
      // true` extends naming to level-0 super-arcs and level-2 episodes
      // (gated on per-cluster density; low-coherence clusters still fall
      // back to the templated name). Eval harnesses leave both off so grid
      // sweeps don't pay the LLM cost per iteration.
      try {
        const { rebuildArcsForChat } = require("./arc-builder");
        const r = await rebuildArcsForChat(settings, chatId, { nameArcs: true, nameHierarchy: true });
        console.log(
          `[ChronicleDB] Arc rebuild for ${chatId}: ${r.builtArcs} arcs (${r.namedArcs ?? 0} LLM-named), ${r.superArcs} super-arcs (${r.namedSuperArcs ?? 0} LLM-named), ${r.episodes} episodes (${r.namedEpisodes ?? 0} LLM-named), ${r.prunedArcs} pruned, Q=${(r.modularityQ ?? 0).toFixed(3)}, N=${r.totalEvents}`,
        );
      } catch (err) {
        console.warn(`[ChronicleDB] Arc rebuild failed for ${chatId}:`, err.message);
      }

      // Record ingestion status
      const p = db.getPool(settings);
      await p.query(
        `INSERT INTO ingestion_status (chat_file, character_name, status, messages_total, batches_done, ingested_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (chat_file) DO UPDATE SET status = $3, messages_total = $4, batches_done = $5, ingested_at = NOW(), updated_at = NOW()`,
        [filename, charName, extracted > 0 ? "done" : "failed", messages.length, extracted],
      );

      res.json({
        ok: true,
        character: charName,
        chatId,
        messagesTotal: messages.length,
        batchesProcessed: extracted,
        batchesTotal: totalBatches,
      });
    } catch (err) {
      console.error("[ChronicleDB] Ingest chat error:", err);
      sendInternalError(res, err);
    }
  });

  // ── Lorebook ingestion ───────────────────────────────────────

  router.get("/lorebooks", async (_req, res) => {
    try {
      const books = listLorebooks(settings);
      res.json(books);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.post("/lorebooks/ingest", async (req, res) => {
    try {
      const { filename } = req.body;
      const result = await ingestLorebook(settings, filename, embed);
      res.json(result);
    } catch (err) {
      // ingestLorebook() throws validation errors from the path-traversal
      // guard with recognizable prefixes. Map those to 400; anything else
      // is a real server failure and returns 500.
      const msg = err.message || "";
      if (msg.startsWith("unsafe filename:")
          || msg.startsWith("path traversal blocked:")
          || msg === "filename required") {
        return res.status(400).json({ error: msg });
      }
      console.error("[ChronicleDB] Lorebook ingest error:", err);
      sendInternalError(res, err);
    }
  });

  // ── All-chats list for the mind map filter dropdown ─────────

  router.get("/chats", async (req, res) => {
    try {
      const p = db.getPool(settings);
      const { rows } = await p.query(
        `SELECT DISTINCT chat_file AS chat_id, character_name, ingested_at
         FROM ingestion_status
         WHERE status = 'done'
         ORDER BY ingested_at DESC NULLS LAST, chat_file`,
      );
      res.json(rows.map((r) => ({
        chatId: (r.chat_id || "").replace(/\.jsonl$/, ""),
        character: r.character_name,
        label: `${r.character_name} — ${(r.chat_id || "").replace(/\.jsonl$/, "")}`,
      })));
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // ── Graph data for mind map ──────────────────────────────────

  router.get("/graph", async (req, res) => {
    try {
      const scope = req.query.scope || "global";
      const depth = parseInt(req.query.depth) || 3;
      // Accept chat_id as single value or comma-separated list. When set,
      // every edge query filters to the given chat(s); characters and
      // locations reached by those edges still render as nodes.
      const chatIds = readOptionalChatIds(req.query);

      // Hard-reject global scope with no chat filter. Without this the user
      // gets an empty payload from the db-level guard and has no idea why.
      // The db.getGraphData guard stays in place as defense-in-depth.
      if (scope === "global" && (!chatIds || chatIds.length === 0)) {
        return res.status(400).json({
          error: "scope=global requires a chat_id query parameter to avoid unbounded payloads. Pass ?chat_id=... or use scope=character.",
        });
      }

      let data;

      if (scope === "character" && req.query.character) {
        data = await db.traverseFromCharacter(settings, req.query.character, depth, chatIds);
      } else {
        data = await db.getGraphData(settings, { scope, character: req.query.character, chatIds });
      }
      res.json(data);
    } catch (err) {
      console.error("[ChronicleDB] Graph query error:", err);
      sendInternalError(res, err);
    }
  });

  // ── Characters list (for mind map dropdown) ──────────────────

  router.get("/characters", async (req, res) => {
    try {
      const p = db.getPool(settings);
      const { rows } = await p.query(`SELECT name FROM characters ORDER BY name`);
      res.json(rows.map((r) => r.name));
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.get("/character/:name/traits", async (req, res) => {
    try {
      const p = db.getPool(settings);
      const charId = db.slugify(req.params.name);
      // Accept chat_id as a filter so the standalone mindmap detail panel
      // can scope character traits to the currently-selected chat filter.
      // Unscoped (no chat_id) still returns all traits for the character —
      // the "show everything about X" fallback behavior the page defaults to.
      const chatId = readOptionalChatId(req.query);
      // User-visible trait read: filter out merged variant rows so the
      // same trait never surfaces twice. Path 1's canonical-row dedup
      // pipeline keeps merged rows in place for provenance, but they
      // must never reach the UI.
      const sql = chatId
        ? `SELECT category, content, source_chat FROM traits
           WHERE character_id = $1 AND source_chat = $2 AND canonical_id IS NULL
           ORDER BY category, content`
        : `SELECT category, content, source_chat FROM traits
           WHERE character_id = $1 AND canonical_id IS NULL
           ORDER BY category, content`;
      const params = chatId ? [charId, chatId] : [charId];
      const { rows } = await p.query(sql, params);
      res.json(rows);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // ── Character memory panel ───────────────────────────────────
  // Feeds the per-character "Memory Management" section in the ST
  // character card sidebar (separate from the global settings panel).

  router.get("/character-stats", async (req, res) => {
    try {
      const name = readRequiredRequestValue(res, req.query, "name");
      if (!name) return;
      const chatId = readOptionalChatId(req.query);
      const stats = await db.getCharacterPanelStats(settings, name, chatId);
      res.json(stats);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.get("/character-recent-events", async (req, res) => {
    try {
      const name = readRequiredRequestValue(res, req.query, "name");
      if (!name) return;
      const limit = parseInt(req.query.limit, 10) || 5;
      const chatId = readOptionalChatId(req.query);
      const events = await db.getCharacterRecentEvents(settings, name, limit, chatId);
      res.json(events);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.get("/character-relationships", async (req, res) => {
    try {
      const name = readRequiredRequestValue(res, req.query, "name");
      if (!name) return;
      const chatId = readOptionalChatId(req.query);
      const rels = await db.getCharacterOutboundRelationships(settings, name, chatId);
      res.json(rels);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.get("/character-memory-config", async (req, res) => {
    try {
      const name = readRequiredRequestValue(res, req.query, "name");
      if (!name) return;
      const config = await db.getCharacterMemoryConfig(settings, name);
      res.json({ sessionMode: config.sessionMode || "persistent" });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.post("/character-memory-config", async (req, res) => {
    try {
      const { sessionMode } = req.body || {};
      const name = readRequiredRequestValue(res, req.body, "name");
      if (!name) return;
      // Preserve the user's chat picker selection — saveCharacterMemoryConfig
      // rewrites the whole row, so we have to read-modify-write.
      const existing = await db.getCharacterMemoryConfig(settings, name);
      await db.saveCharacterMemoryConfig(settings, {
        characterName: name,
        sessionMode: sessionMode || existing.sessionMode || "persistent",
        selectedChats: existing.selectedChats || [],
      });
      res.json({ ok: true });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.post("/character-clear-memories", async (req, res) => {
    try {
      const name = readRequiredRequestValue(res, req.body, "name");
      if (!name) return;
      const cleared = await db.clearCharacterMemories(settings, name);
      res.json({ ok: true, cleared });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // ── Character summary-embedding rollup ───────────────────────
  // Admin endpoint: iterate every character and rebuild its
  // `summary_embedding` as the mean-pool of its personality-trait
  // embeddings. Safe to run repeatedly. Intended to be fired after a
  // one-shot backfill once traits have real contextual embeddings
  // (Path 1). Per-row updates are no-ops until any trait embeddings
  // exist, at which point the aggregate starts populating.

  router.post("/recompute-character-summaries", async (req, res) => {
    try {
      const p = db.getPool(settings);
      const { rows } = await p.query("SELECT id FROM characters");
      let updated = 0;
      for (const row of rows) {
        await db.recomputeCharacterSummary(settings, row.id);
        updated++;
      }
      res.json({ updated });
    } catch (err) {
      console.error("[ChronicleDB] Recompute summaries error:", err);
      sendInternalError(res, err);
    }
  });

  // ── Character cards (all ST character PNGs) ──────────────────

  router.get("/character-cards", async (req, res) => {
    try {
      const { readdirSync } = require("fs");
      const { resolve } = require("path");
      const dataRoot = resolveStDataRoot(settings);
      const charsDir = resolve(dataRoot, "characters");
      const files = readdirSync(charsDir)
        .filter((f) => f.endsWith(".png"))
        .sort()
        .map((f) => ({
          filename: f,
          name: f.replace(".png", ""),
          // Card PNG served by ST at this path
          imagePath: `/characters/${encodeURIComponent(f)}`,
        }));
      res.json(files);
    } catch (err) {
      console.error("[ChronicleDB] Character cards error:", err);
      sendInternalError(res, err);
    }
  });

  // Proxy character PNGs so the mind map page can access them
  router.get("/character-image/:filename", async (req, res) => {
    try {
      const { resolve } = require("path");
      const { createReadStream, existsSync } = require("fs");
      const dataRoot = resolveStDataRoot(settings);
      const charsDir = resolve(dataRoot, "characters");
      let imgPath;
      try {
        // Reject `..`, forward/back slashes, NUL bytes up front, and
        // confirm the resolved path stays under `charsDir`. A request for
        // `../../etc/passwd` throws here and becomes a 400.
        imgPath = safeResolveUnder(charsDir, req.params.filename);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      if (!existsSync(imgPath)) return res.status(404).send("Not found");
      res.setHeader("Content-Type", "image/png");
      createReadStream(imgPath).pipe(res);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // ── Memory CRUD ──────────────────────────────────────────────

  router.get("/memories/:chatId", async (req, res) => {
    try {
      const p = db.getPool(settings);
      const { rows } = await p.query(
        `SELECT * FROM memory_embeddings WHERE chat_id = $1 ORDER BY created_at DESC`,
        [req.params.chatId],
      );
      res.json(rows);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  router.delete("/memories/:id", async (req, res) => {
    try {
      const p = db.getPool(settings);
      await p.query(`DELETE FROM memory_embeddings WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // ── Debug: recent LLM calls ──────────────────────────────────
  // In-memory ring buffer surface for the settings panel. Empty until
  // extractor.js is wired in a follow-up (intentionally deferred to avoid
  // conflicting with parallel edits to that file).
  router.get("/debug/llm-calls", (_req, res) => {
    res.json({ calls: require("./llm-monitor").list() });
  });

  console.log("[ChronicleDB] Server plugin ready.");
}

/**
 * Cleanup on ST shutdown.
 */
async function exit() {
  console.log("[ChronicleDB] Shutting down...");
  await db.closePool();
}

module.exports = { init, exit, info };
