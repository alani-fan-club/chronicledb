/**
 * ChronicleDB — SillyTavern Server Plugin
 * Persistent graph+vector memory for RP.
 *
 * ST server plugins export: init(router), exit(), info
 */

const db = require("./db");
const { extract, embed } = require("./extractor");
const { retrieve, formatMemoryBlock } = require("./retriever");
const { ingestLorebook, listLorebooks } = require("./lorebook");

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

      // Update character role/status/significance
      for (const char of (extraction.characters || [])) {
        if (char.role || char.status || char.significance) {
          const p = db.getPool(settings);
          const charId = db.slugify(char.name);
          await p.query(
            `UPDATE characters SET role = COALESCE(NULLIF($2, ''), role), status = COALESCE(NULLIF($3, ''), status), significance = GREATEST(significance, $4) WHERE id = $1`,
            [charId, char.role || "", char.status || "", char.significance || 3],
          );
        }
      }

      for (const rel of (extraction.relationships || [])) {
        await db.upsertRelationship(settings, {
          from: rel.from,
          to: rel.to,
          sentiment: parseFloat(rel.sentiment) || 0,
          intensity: parseFloat(rel.intensity) || 0.5,
          description: rel.description || rel.evidence || "",
          sessionId: chatId,
        });
      }

      // Items
      for (const item of (extraction.items || [])) {
        const p = db.getPool(settings);
        const itemId = `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        let ownerId = null;
        let locationId = null;
        if (item.owner) ownerId = db.slugify(item.owner);
        if (item.location) locationId = await db.upsertLocation(settings, item.location, "");
        await p.query(
          `INSERT INTO items (id, name, description, powers, significance, owner_id, location_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [itemId, item.name, item.description || "", item.powers || "", item.significance || 3, ownerId, locationId, item.status || "intact"],
        );
      }

      // Location detail updates
      for (const loc of (extraction.locations_detail || [])) {
        const locId = await db.upsertLocation(settings, loc.name, loc.description || "");
        const p = db.getPool(settings);
        await p.query(
          `UPDATE locations SET importance = GREATEST(importance, $2), current_state = $3 WHERE id = $1`,
          [locId, loc.importance || 3, loc.current_state || ""],
        ).catch(() => {});
      }

      // Contradictions — log for review
      for (const c of (extraction.contradictions || [])) {
        if (c) console.warn(`[ChronicleDB] Contradiction detected: ${c}`);
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

      // 3. Ingest context snapshot
      if (extraction.context_snapshot) {
        const snap = extraction.context_snapshot;
        const wsSnapshot = {};
        for (const ws of (extraction.world_state || [])) {
          wsSnapshot[ws.key] = ws.value;
        }
        await db.insertContextSnapshot(settings, {
          chatId: chatId || "",
          messageIndex: messageIndex || 0,
          summary: snap.summary || "",
          locationName: snap.location || null,
          presentChars: snap.present_characters || [],
          emotionalTone: snap.emotional_tone || "",
          worldStateSnapshot: wsSnapshot,
        });
      }

      // 4. Ingest plot threads
      for (const thread of (extraction.plot_threads || [])) {
        await db.upsertPlotThread(settings, {
          chatId: chatId || "",
          title: thread.title,
          description: thread.description || "",
          threadType: thread.type || "pending",
          involvedChars: thread.involved_characters || [],
          plantedAt: messageIndex || null,
          resolvedAt: thread.type === "resolved" ? messageIndex : null,
          importance: thread.importance || 3,
        });
      }

      // 5. Embed the full message batch for vector search
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
      const { chatId, characterName, activeCharacters, recentText, sessionId, maxTokens } = req.body;

      // Load per-character config to know which chats to remember
      const charConfig = characterName
        ? await db.getCharacterMemoryConfig(settings, characterName)
        : { sessionMode: "persistent", selectedChats: [] };

      const result = await retrieve(settings, {
        chatId,
        activeCharacters: activeCharacters || [],
        recentText: recentText || "",
        sessionMode: charConfig.sessionMode || "persistent",
        sessionId,
        selectedChats: charConfig.selectedChats || [], // scoped chat IDs
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
          return {
            filename: f,
            chatId: f.replace(".jsonl", ""),
            date: dateMatch ? dateMatch[1] : "",
            size: stat.size,
            messageEstimate: Math.max(1, Math.floor(stat.size / 2000)),
          };
        });

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
          if (msg.mes !== undefined) messages.push(msg);
        } catch { /* skip malformed */ }
      }

      // Process in batches
      const batchSize = 10;
      let extracted = 0;
      const totalBatches = Math.ceil(messages.length / batchSize);

      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize).map((m) => ({
          name: m.name,
          is_user: m.is_user,
          is_system: m.is_system || false,
          mes: m.swipe_id !== undefined && m.swipes?.[m.swipe_id] ? m.swipes[m.swipe_id] : m.mes,
          send_date: m.send_date,
        }));

        try {
          // Extract via Gemini
          const extraction = await extract(settings, { characterName: charName, userName, messages: batch });

          // Ingest characters
          for (const char of (extraction.characters || [])) {
            await db.upsertCharacter(settings, { name: char.name, aliases: [], description: (char.new_facts || []).join("; "), firstSeen: chatId });
            if (char.role || char.status || char.significance) {
              const p = db.getPool(settings);
              await p.query(`UPDATE characters SET role = COALESCE(NULLIF($2,''),role), status = COALESCE(NULLIF($3,''),status), significance = GREATEST(significance,$4) WHERE id = $1`,
                [db.slugify(char.name), char.role || "", char.status || "", char.significance || 3]);
            }
            for (const fact of (char.new_facts || [])) {
              await db.upsertFact(settings, { content: fact, domain: "character", confidence: 0.8, characterScope: [char.name] });
            }
          }

          // Relationships
          for (const rel of (extraction.relationships || [])) {
            await db.upsertRelationship(settings, { from: rel.from, to: rel.to, sentiment: parseFloat(rel.sentiment) || 0, intensity: parseFloat(rel.intensity) || 0.5, description: rel.description || "", sessionId: chatId });
          }

          // Events
          for (const event of (extraction.events || [])) {
            await db.insertEvent(settings, { summary: event.summary, participants: event.participants, location: event.location, significance: event.significance, messageIndex: i, sessionId: chatId });
          }

          // World state
          for (const ws of (extraction.world_state || [])) {
            await db.upsertWorldState(settings, ws);
          }

          // Knowledge
          for (const ku of (extraction.knowledge_updates || [])) {
            if (ku.learned) await db.upsertFact(settings, { content: ku.learned, domain: "knowledge", confidence: 0.9, characterScope: [ku.character] });
          }

          // Items
          for (const item of (extraction.items || [])) {
            const p = db.getPool(settings);
            const itemId = `item-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
            let ownerId = item.owner ? db.slugify(item.owner) : null;
            let locationId = item.location ? await db.upsertLocation(settings, item.location, "") : null;
            await p.query(`INSERT INTO items (id,name,description,powers,significance,owner_id,location_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
              [itemId, item.name, item.description||"", item.powers||"", item.significance||3, ownerId, locationId, item.status||"intact"]).catch(()=>{});
          }

          // Context snapshot
          if (extraction.context_snapshot) {
            const snap = extraction.context_snapshot;
            const wsSnap = {};
            for (const ws of (extraction.world_state || [])) wsSnap[ws.key] = ws.value;
            await db.insertContextSnapshot(settings, { chatId, messageIndex: i, summary: snap.summary||"", locationName: snap.location||null, presentChars: snap.present_characters||[], emotionalTone: snap.emotional_tone||"", worldStateSnapshot: wsSnap });
          }

          // Plot threads
          for (const pt of (extraction.plot_threads || [])) {
            await db.upsertPlotThread(settings, { chatId, title: pt.title, description: pt.description||"", threadType: pt.type||"pending", involvedChars: pt.involved_characters||[], plantedAt: i, resolvedAt: pt.type==="resolved"?i:null, importance: pt.importance||3 });
          }

          // Embed the batch
          const batchText = batch.filter(m=>!m.is_system).map(m=>`${m.name}: ${m.mes}`).join("\n").slice(0,8000);
          const batchEmbed = await embed(settings, batchText);
          await db.storeEmbedding(settings, { chatId, nodeType: "conversation", nodeId: `ingest-${chatId}-${i}`, content: batchText.slice(0,2000), embedding: batchEmbed, characterScope: [charName, userName], messageIndex: i });

          extracted++;
        } catch (err) {
          console.warn(`[ChronicleDB] Ingest batch ${i} error:`, err.message);
        }
      }

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

  // ── Graph data for mind map ──────────────────────────────────

  router.get("/graph", async (req, res) => {
    try {
      const scope = req.query.scope || "global";
      const depth = parseInt(req.query.depth) || 3;
      let data;

      if (scope === "character" && req.query.character) {
        // N-hop recursive traversal from a character
        data = await db.traverseFromCharacter(settings, req.query.character, depth);
      } else {
        data = await db.getGraphData(settings, { scope, character: req.query.character });
      }
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
