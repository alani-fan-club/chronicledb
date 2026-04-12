/**
 * ChronicleDB — SillyTavern Server Plugin
 * Persistent graph+vector memory for RP.
 *
 * ST server plugins export: init(router), exit(), info
 */

const db = require("./db");
const { extract, embed } = require("./extractor");
const { retrieve, formatMemoryBlock } = require("./retriever");

let settings = {};

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

  // ── Settings endpoint (UI extension saves/loads settings here) ──

  router.post("/settings", (req, res) => {
    settings = { ...settings, ...req.body };
    console.log("[ChronicleDB] Settings updated.");
    res.json({ ok: true });
  });

  router.get("/settings", (_req, res) => {
    res.json(settings);
  });

  // ── Schema init ──────────────────────────────────────────────

  router.post("/init-db", async (_req, res) => {
    try {
      await db.initSchema(settings);
      res.json({ ok: true });
    } catch (err) {
      console.error("[ChronicleDB] DB init error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Extraction endpoint ──────────────────────────────────────
  // Called by UI ext after GENERATION_ENDED (async, non-blocking)

  router.post("/extract", async (req, res) => {
    try {
      const { characterName, userName, messages, chatId, messageIndex } = req.body;

      // 1. Extract structured data from messages
      const extraction = await extract(settings, { characterName, userName, messages });

      // 2. Ingest into graph
      for (const char of (extraction.characters || [])) {
        await db.upsertCharacter(settings, {
          name: char.name,
          aliases: [],
          description: (char.new_facts || []).join("; "),
          firstSeen: new Date().toISOString(),
        });

        // Store character facts
        for (const fact of (char.new_facts || [])) {
          await db.upsertFact(settings, {
            content: fact,
            domain: "character",
            confidence: 0.8,
            characterScope: [char.name],
          });
        }
      }

      for (const rel of (extraction.relationships || [])) {
        await db.upsertRelationship(settings, {
          from: rel.from,
          to: rel.to,
          sentiment: parseFloat(rel.sentiment) || 0,
          intensity: parseFloat(rel.intensity) || 0.5,
          description: rel.evidence || rel.sentiment,
          sessionId: chatId,
        });
      }

      for (const event of (extraction.events || [])) {
        const eventId = await db.insertEvent(settings, {
          summary: event.summary,
          participants: event.participants,
          location: event.location,
          significance: event.significance,
          messageIndex,
          sessionId: chatId,
        });

        // Embed the event
        const eventEmbedding = await embed(settings, event.summary);
        await db.storeEmbedding(settings, {
          chatId: chatId || "",
          nodeType: "event",
          nodeId: eventId,
          content: event.summary,
          embedding: eventEmbedding,
          characterScope: event.participants,
          messageIndex,
        });
      }

      for (const ws of (extraction.world_state || [])) {
        await db.upsertWorldState(settings, ws);
      }

      for (const ku of (extraction.knowledge_updates || [])) {
        if (ku.learned) {
          await db.upsertFact(settings, {
            content: ku.learned,
            domain: "knowledge",
            confidence: 0.9,
            characterScope: [ku.character],
          });
        }
        // does_not_know entries are implicit — the character simply
        // doesn't have a KNOWS edge to those facts
      }

      // 3. Embed the full message batch for vector search
      const batchText = messages
        .filter((m) => !m.is_system)
        .map((m) => `${m.name}: ${m.mes}`)
        .join("\n")
        .slice(0, 8000);

      const batchEmbedding = await embed(settings, batchText);
      await db.storeEmbedding(settings, {
        chatId: chatId || "",
        nodeType: "conversation",
        nodeId: `batch-${Date.now()}`,
        content: batchText.slice(0, 2000),
        embedding: batchEmbedding,
        characterScope: [characterName, userName],
        messageIndex,
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
      const { chatId, activeCharacters, recentText, sessionMode, sessionId, maxTokens } = req.body;

      const result = await retrieve(settings, {
        chatId,
        activeCharacters: activeCharacters || [],
        recentText: recentText || "",
        sessionMode: sessionMode || "persistent",
        sessionId,
      });

      const memoryBlock = formatMemoryBlock(result, maxTokens || 1500);
      res.json({ result, memoryBlock });
    } catch (err) {
      console.error("[ChronicleDB] Retrieval error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Graph data for mind map ──────────────────────────────────

  router.get("/graph", async (req, res) => {
    try {
      const data = await db.getGraphData(settings, {
        scope: req.query.scope || "global",
        character: req.query.character,
        chatId: req.query.chatId,
        nodeId: req.query.nodeId,
        depth: parseInt(req.query.depth) || 2,
      });
      res.json(data);
    } catch (err) {
      console.error("[ChronicleDB] Graph query error:", err);
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
