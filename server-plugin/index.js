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

async function tryAutoConnect() {
  if (!settings.pgHost || !settings.pgDatabase) {
    connectionState = { connected: false, error: null, initializedAt: null };
    return;
  }
  try {
    await db.initSchema(settings);
    connectionState = {
      connected: true,
      error: null,
      initializedAt: new Date().toISOString(),
    };
    console.log("[ChronicleDB] Auto-connected to database.");
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

  router.get("/status", (_req, res) => {
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
      res.json({ ok: true });
    } catch (err) {
      connectionState = { connected: false, error: err.message, initializedAt: null };
      console.error("[ChronicleDB] DB init error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Extraction endpoint ──────────────────────────────────────
  // Called by UI ext after GENERATION_ENDED (async, non-blocking)

  router.post("/extract", async (req, res) => {
    try {
      const { characterName, userName, messages, chatId, messageIndex } = req.body;

      // 1. Extract structured data from messages.
      const extraction = await extract(settings, { characterName, userName, messages });

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

      res.json({ ok: true, extraction });
    } catch (err) {
      console.error("[ChronicleDB] Extraction error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Retrieval endpoint ───────────────────────────────────────
  // Called by UI ext before GENERATION_STARTED

  router.post("/retrieve", async (req, res) => {
    try {
      const { chatId, characterName, activeCharacters, recentText, sessionId, maxTokens } = req.body;

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

      const result = await retrieve(settings, {
        chatId,
        activeCharacters: activeCharacters || [],
        recentText: recentText || "",
        sessionMode: charConfig.sessionMode || "persistent",
        sessionId,
        selectedChats, // scoped chat IDs (defaults to [chatId] when no preference set)
      });

      const memoryBlock = formatMemoryBlock(result, maxTokens || 1500);
      res.json({ result, memoryBlock });
    } catch (err) {
      console.error("[ChronicleDB] Retrieval error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Per-character memory config ────────────────────────────────
  // Tied to character card: stores which chats this character remembers

  router.get("/character-config/:characterName", async (req, res) => {
    try {
      const config = await db.getCharacterMemoryConfig(settings, req.params.characterName);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
  });

  // ── List chats for a character (reads ST data dir) ───────────

  router.get("/chats/:characterName", async (req, res) => {
    try {
      const { readdirSync, statSync } = require("fs");
      const { join, resolve } = require("path");

      const dataRoot = settings.stDataRoot || "";
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
      res.status(500).json({ error: err.message });
    }
  });

  // ── Chat ingestion (backfill a specific chat file) ───────────

  router.post("/ingest-chat", async (req, res) => {
    try {
      const { characterName, filename } = req.body;
      if (!characterName || !filename) {
        return res.status(400).json({ error: "characterName and filename required" });
      }

      const { readFileSync } = require("fs");
      const { resolve, join } = require("path");

      const dataRoot = settings.stDataRoot || "";
      const chatsBase = resolve(dataRoot, "chats");

      // Find matching directory
      const { readdirSync } = require("fs");
      const entries = readdirSync(chatsBase);
      const matchingDir = entries.find((e) => e === characterName || e.startsWith(characterName));
      if (!matchingDir) return res.status(404).json({ error: "Character chat dir not found" });

      const filePath = join(chatsBase, matchingDir, filename);
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
      res.status(500).json({ error: err.message });
    }
  });

  // ── Lorebook ingestion ───────────────────────────────────────

  router.get("/lorebooks", async (_req, res) => {
    try {
      const books = listLorebooks(settings);
      res.json(books);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/lorebooks/ingest", async (req, res) => {
    try {
      const { filename } = req.body;
      const result = await ingestLorebook(settings, filename, embed);
      res.json(result);
    } catch (err) {
      console.error("[ChronicleDB] Lorebook ingest error:", err);
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
      const chatIds = typeof req.query.chat_id === "string" && req.query.chat_id.trim().length > 0
        ? req.query.chat_id.split(",").map((s) => s.trim()).filter(Boolean)
        : null;
      let data;

      if (scope === "character" && req.query.character) {
        data = await db.traverseFromCharacter(settings, req.query.character, depth, chatIds);
      } else {
        data = await db.getGraphData(settings, { scope, character: req.query.character, chatIds });
      }
      res.json(data);
    } catch (err) {
      console.error("[ChronicleDB] Graph query error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Characters list (for mind map dropdown) ──────────────────

  router.get("/characters", async (req, res) => {
    try {
      const p = db.getPool(settings);
      const { rows } = await p.query(`SELECT name FROM characters ORDER BY name`);
      res.json(rows.map((r) => r.name));
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      const chatId = typeof req.query.chat_id === "string" && req.query.chat_id.trim().length > 0
        ? req.query.chat_id
        : null;
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
      res.status(500).json({ error: err.message });
    }
  });

  // ── Character memory panel ───────────────────────────────────
  // Feeds the per-character "Memory Management" section in the ST
  // character card sidebar (separate from the global settings panel).

  router.get("/character-stats", async (req, res) => {
    try {
      const name = req.query.name;
      if (!name) return res.status(400).json({ error: "name required" });
      const chatId = typeof req.query.chat_id === "string" && req.query.chat_id.trim().length > 0
        ? req.query.chat_id
        : null;
      const stats = await db.getCharacterPanelStats(settings, name, chatId);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/character-recent-events", async (req, res) => {
    try {
      const name = req.query.name;
      if (!name) return res.status(400).json({ error: "name required" });
      const limit = parseInt(req.query.limit, 10) || 5;
      const chatId = typeof req.query.chat_id === "string" && req.query.chat_id.trim().length > 0
        ? req.query.chat_id
        : null;
      const events = await db.getCharacterRecentEvents(settings, name, limit, chatId);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/character-relationships", async (req, res) => {
    try {
      const name = req.query.name;
      if (!name) return res.status(400).json({ error: "name required" });
      const chatId = typeof req.query.chat_id === "string" && req.query.chat_id.trim().length > 0
        ? req.query.chat_id
        : null;
      const rels = await db.getCharacterOutboundRelationships(settings, name, chatId);
      res.json(rels);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/character-memory-config", async (req, res) => {
    try {
      const name = req.query.name;
      if (!name) return res.status(400).json({ error: "name required" });
      const config = await db.getCharacterMemoryConfig(settings, name);
      res.json({ sessionMode: config.sessionMode || "persistent" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/character-memory-config", async (req, res) => {
    try {
      const { name, sessionMode } = req.body || {};
      if (!name) return res.status(400).json({ error: "name required" });
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
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/character-clear-memories", async (req, res) => {
    try {
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: "name required" });
      const cleared = await db.clearCharacterMemories(settings, name);
      res.json({ ok: true, cleared });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
  });

  // ── Character cards (all ST character PNGs) ──────────────────

  router.get("/character-cards", async (req, res) => {
    try {
      const { readdirSync } = require("fs");
      const { resolve } = require("path");
      const dataRoot = settings.stDataRoot || "";
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
      res.status(500).json({ error: err.message });
    }
  });

  // Proxy character PNGs so the mind map page can access them
  router.get("/character-image/:filename", async (req, res) => {
    try {
      const { resolve, join } = require("path");
      const { createReadStream, existsSync } = require("fs");
      const dataRoot = settings.stDataRoot || "";
      const imgPath = join(resolve(dataRoot, "characters"), req.params.filename);
      if (!existsSync(imgPath)) return res.status(404).send("Not found");
      res.setHeader("Content-Type", "image/png");
      createReadStream(imgPath).pipe(res);
    } catch (err) {
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
  });

  router.delete("/memories/:id", async (req, res) => {
    try {
      const p = db.getPool(settings);
      await p.query(`DELETE FROM memory_embeddings WHERE id = $1`, [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
