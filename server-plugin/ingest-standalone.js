#!/usr/bin/env node

const { readFileSync } = require("fs");
const { resolve, basename } = require("path");
const db = require("./db");
const { loadScriptSettings } = require("./script-settings");
const {
  extract,
  applyExtractionToGraph,
  applyMessagesToVectorStore,
} = require("./extractor");

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
  const { settings } = loadScriptSettings({
    // Preserve previous ingest behavior: require chronicledb.config.json.
    requiredConfig: true,
    // Ingest standalone historically did not auto-load eval/.env.
    loadEnv: false,
  });
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
      extraction = await extract(settings, { characterName: charName, userName, messages: batch, chatId });
    } catch (err) {
      console.warn(`[ingest] batch ${i} extraction failed: ${err.message.slice(0, 200)}`);
    }

    if (extraction) {
      try {
        await applyExtractionToGraph(settings, {
          extraction,
          chatId,
          charName,
          userName,
          messageIndex: i,
          batchSize: batch.length,
        });
      } catch (err) {
        console.warn(`[ingest] batch ${i} graph write error: ${err.message}`);
      }
    }

    // Vector writes run even if graph writes threw — chunks/quotes are
    // independently valuable for retrieval.
    try {
      const stats = await applyMessagesToVectorStore(settings, {
        messages,
        chatBatch: batch,
        batchStart: i,
        messageIndexOffset: i,
        chatId,
        ctxWindow,
      });
      embedCount += stats.embeds;
      chunkCount += stats.chunks;
      quoteCount += stats.quotes;
    } catch (err) {
      console.warn(`[ingest] batch ${i} vector write error: ${err.message}`);
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
