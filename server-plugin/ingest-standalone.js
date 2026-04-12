#!/usr/bin/env node

const { readFileSync } = require("fs");
const { resolve, basename } = require("path");
const db = require("./db");
const {
  extract,
  embed,
  generateSituatingBlurb,
  chunkText,
  extractDialogueQuotes,
} = require("./extractor");

function loadConfig() {
  const cfgPath = resolve(__dirname, "..", "chronicledb.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  return {
    pgHost: process.env.PGHOST || cfg.database?.host || "localhost",
    pgPort: parseInt(process.env.PGPORT || cfg.database?.port || "5432"),
    pgDatabase: process.env.PGDATABASE || cfg.database?.database || "chronicledb",
    pgUser: process.env.PGUSER || cfg.database?.user || process.env.USER,
    pgPassword: process.env.PGPASSWORD || cfg.database?.password || "",
    geminiApiKey: process.env.GEMINI_API_KEY || cfg.embedding?.apiKey || "",
    extractionApiKey: process.env.GEMINI_API_KEY || cfg.embedding?.apiKey || "",
    extractionApiType: "gemini",
    extractionModel: process.env.GEMINI_LLM_MODEL || "gemini-2.5-flash-lite",
    contextModel: process.env.GEMINI_CONTEXT_MODEL || "gemini-2.5-flash-lite",
    geminiEmbeddingModel: cfg.embedding?.model || "gemini-embedding-2-preview",
    geminiEmbeddingDimension: cfg.embedding?.dimension || 768,
    stDataRoot: cfg.sillytavern?.dataRoot || "",
  };
}

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--file") args.file = process.argv[++i];
    else if (a === "--character") args.character = process.argv[++i];
    else if (a === "--batch-size") args.batchSize = parseInt(process.argv[++i]);
    else if (a === "--context-window") args.contextWindow = parseInt(process.argv[++i]);
  }
  return args;
}

function buildBatches(messages, batchSize) {
  const batches = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    batches.push({ batchIdx: i, batch: messages.slice(i, i + batchSize) });
  }
  return batches;
}

async function run() {
  const settings = loadConfig();
  const args = parseArgs();
  if (!args.file) {
    console.error("Usage: node ingest-standalone.js --file <path.jsonl> [--character NAME] [--batch-size 10] [--context-window 4]");
    process.exit(1);
  }

  const filePath = args.file;
  const filename = basename(filePath);
  const chatId = filename.replace(/\.jsonl$/, "");
  const batchSize = args.batchSize || 10;
  const ctxWindow = args.contextWindow || 4;

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) throw new Error("Empty chat file");

  const metadata = JSON.parse(lines[0]);
  const charName = args.character || metadata.character_name || "Unknown";
  const userName = metadata.user_name || "User";

  const messages = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.mes !== undefined && !msg.is_system) {
        messages.push({
          name: msg.name,
          is_user: msg.is_user,
          is_system: msg.is_system || false,
          mes: msg.swipe_id !== undefined && msg.swipes?.[msg.swipe_id] ? msg.swipes[msg.swipe_id] : msg.mes,
          send_date: msg.send_date,
        });
      }
    } catch { /* skip malformed */ }
  }

  console.log(`[ingest] chat_id=${chatId} character=${charName} messages=${messages.length} batches=${Math.ceil(messages.length / batchSize)}`);

  const allBatches = buildBatches(messages, batchSize);
  let extractedCount = 0;
  let embedCount = 0;
  let chunkCount = 0;
  let quoteCount = 0;
  const t0 = Date.now();

  for (let g = 0; g < allBatches.length; g++) {
    const { batchIdx: i, batch } = allBatches[g];

    let extraction = null;
    try {
      extraction = await extract(settings, { characterName: charName, userName, messages: batch });
    } catch (err) {
      console.warn(`[ingest] batch ${i} extraction failed: ${err.message.slice(0, 200)}`);
    }

    if (extraction) try {
      for (const char of (extraction.characters || [])) {
        const description = (char.traits || []).map((t) => t.content).join("; ");
        await db.upsertCharacter(settings, { name: char.name, aliases: char.aliases || [], description, firstSeen: chatId });
        const charId = db.slugify(char.name);
        if (char.role || char.status || char.significance) {
          const p = db.getPool(settings);
          await p.query(
            `UPDATE characters SET role = COALESCE(NULLIF($2,''),role), status = COALESCE(NULLIF($3,''),status), significance = GREATEST(significance,$4) WHERE id = $1`,
            [charId, char.role || "", char.status || "", char.significance || 3],
          );
        }
        for (const trait of (char.traits || [])) {
          if (trait.content) {
            await db.upsertTrait(settings, {
              characterId: charId,
              category: trait.category || "personality",
              content: trait.content,
              sourceChat: chatId,
            });
          }
        }
      }

      for (const rel of (extraction.relationships || [])) {
        await db.upsertRelationship(settings, {
          from: rel.from, to: rel.to,
          sentiment: parseFloat(rel.sentiment) || 0,
          intensity: parseFloat(rel.intensity) || 0.5,
          description: rel.description || "",
          sessionId: chatId,
        });
      }

      const eventKeyToId = new Map();
      for (const event of (extraction.events || [])) {
        const eventId = await db.upsertEvent(settings, {
          summary: event.summary,
          sourceText: event.source_quote,
          participants: event.participants,
          location: event.location,
          significance: event.significance,
          messageIndex: i,
          sessionId: chatId,
        });
        if (event.event_key) eventKeyToId.set(event.event_key, eventId);
      }

      for (const chain of (extraction.event_chains || [])) {
        const fromId = eventKeyToId.get(chain.from);
        const toId = eventKeyToId.get(chain.to);
        if (fromId && toId) {
          await db.createEventChain(settings, {
            fromEventId: fromId, toEventId: toId,
            chainType: chain.chain_type || "caused",
            description: chain.description || "",
          });
        }
      }

      for (const arc of (extraction.story_arcs || [])) {
        const spineId = arc.spine_event_key ? eventKeyToId.get(arc.spine_event_key) : null;
        const arcId = await db.upsertStoryArc(settings, {
          chatId, title: arc.title, description: arc.description || "",
          arcType: arc.arc_type || "main", status: arc.status || "active",
          importance: arc.importance || 3, startMsgIdx: i, endMsgIdx: i + batch.length,
          spineEventId: spineId,
        });
        let pos = 0;
        for (const key of (arc.event_keys || [])) {
          const eventId = eventKeyToId.get(key);
          if (eventId) await db.linkEventToArc(settings, { arcId, eventId, position: pos++, isAnchor: eventId === spineId });
        }
      }

      for (const ws of (extraction.world_state || [])) {
        await db.upsertWorldState(settings, { ...ws, chatId });
      }

      for (const ku of (extraction.knowledge_updates || [])) {
        if (ku.learned) await db.upsertFact(settings, { content: ku.learned, domain: "knowledge", confidence: 0.9, characterScope: [ku.character] });
      }

      for (const item of (extraction.items || [])) {
        await db.upsertItem(settings, {
          name: item.name, description: item.description, powers: item.powers,
          significance: item.significance, owner: item.owner, location: item.location,
          status: item.status, chatId,
        }).catch(() => {});
      }

      if (extraction.context_snapshot) {
        const snap = extraction.context_snapshot;
        const wsSnap = {};
        for (const ws of (extraction.world_state || [])) wsSnap[ws.key] = ws.value;
        await db.insertContextSnapshot(settings, {
          chatId, messageIndex: i,
          summary: snap.summary || "",
          locationName: snap.location || null,
          presentChars: snap.present_characters || [],
          emotionalTone: snap.emotional_tone || "",
          worldStateSnapshot: wsSnap,
        });
      }

      for (const pt of (extraction.plot_threads || [])) {
        await db.upsertPlotThread(settings, {
          chatId, title: pt.title, description: pt.description || "",
          threadType: pt.type || "pending",
          involvedChars: pt.involved_characters || [],
          plantedAt: i, resolvedAt: pt.type === "resolved" ? i : null,
          importance: pt.importance || 3,
        });
      }
    } catch (err) {
      console.warn(`[ingest] batch ${i} graph write error: ${err.message}`);
    }

    for (let mi = 0; mi < batch.length; mi++) {
      const m = batch[mi];
      if (m.is_system) continue;
      const text = `${m.name}: ${m.mes}`;
      if (text.length < 80) continue;
      const messageIndex = i + mi;

      const before = messages.slice(Math.max(0, messageIndex - ctxWindow), messageIndex);
      const after = messages.slice(messageIndex + 1, messageIndex + 1 + ctxWindow);
      const surroundingContext = [...before, ...after]
        .filter((mm) => !mm.is_system)
        .map((mm) => `${mm.name}: ${(mm.mes || "").slice(0, 400)}`)
        .join("\n\n");

      let situating = "";
      try {
        situating = await generateSituatingBlurb(settings, {
          chatTitle: chatId,
          surroundingContext,
          message: text,
        });
      } catch (err) {
        console.warn(`[ingest] msg ${messageIndex} situating failed: ${err.message}`);
      }

      const chunks = chunkText(m.mes);
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const labeledChunk = `${m.name}: ${chunk}`;
        const embedInput = situating ? `${situating}\n\n${labeledChunk}` : labeledChunk;
        try {
          const v = await embed(settings, embedInput);
          await db.upsertMemoryEmbedding(settings, {
            chatId,
            nodeType: chunks.length > 1 ? "message_chunk" : "message",
            nodeId: chunks.length > 1
              ? `msg-${chatId}-${messageIndex}-c${ci}`
              : `msg-${chatId}-${messageIndex}`,
            content: labeledChunk.slice(0, 2000),
            rawText: chunk,
            embedding: v,
            characterScope: [m.name],
            messageIndex,
            contextPrefix: situating || null,
          });
          embedCount++;
          if (chunks.length > 1) chunkCount++;
        } catch (err) {
          console.warn(`[ingest] msg ${messageIndex} chunk ${ci} embed failed: ${err.message}`);
        }
      }

      const quotes = extractDialogueQuotes(m.mes);
      for (const q of quotes) {
        try {
          await db.upsertDialogueQuote(settings, {
            chatId, sessionId: chatId, speaker: m.name, quote: q, messageIndex,
          });
          quoteCount++;
        } catch (err) {
          console.warn(`[ingest] msg ${messageIndex} quote insert failed: ${err.message}`);
        }
      }
    }

    extractedCount++;
    const pct = (((g + 1) / allBatches.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`[ingest] batch ${g + 1}/${allBatches.length} (${pct}%) embeds=${embedCount} chunks=${chunkCount} quotes=${quoteCount} elapsed=${elapsed}s`);
  }

  const p = db.getPool(settings);
  await p.query(
    `INSERT INTO ingestion_status (chat_file, character_name, status, messages_total, batches_done, ingested_at, updated_at)
     VALUES ($1, $2, 'done', $3, $4, NOW(), NOW())
     ON CONFLICT (chat_file) DO UPDATE SET status='done', messages_total=$3, batches_done=$4, ingested_at=NOW(), updated_at=NOW()`,
    [filename, charName, messages.length, extractedCount],
  );

  console.log(`[ingest] DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s — embeds=${embedCount} chunks=${chunkCount} quotes=${quoteCount}`);
  await db.closePool(settings);
}

run().catch((err) => {
  console.error("[ingest] FATAL:", err);
  process.exit(1);
});
