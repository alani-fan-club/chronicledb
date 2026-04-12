#!/usr/bin/env node
// Backfill embeddings for events.embedding and context_snapshots.embedding.
// Scoped by chat_id LIKE pattern (defaults to %Protagonist%).
// Idempotent: only touches rows where embedding IS NULL.
//
// Usage: node backfill-multi-granularity-embeddings.js [chat_id_like]
require("dotenv").config({ path: require("path").join(__dirname, "..", "eval", ".env") });
const { Pool } = require("pg");
const { embed } = require("./extractor");

const settings = {
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2-preview",
  geminiEmbeddingDimension: parseInt(process.env.GEMINI_EMBEDDING_DIM || "768"),
};

async function main() {
  const chatFilter = process.argv[2] || "%Protagonist%";
  const pool = new Pool({
    host: "localhost",
    database: "chronicledb",
    user: process.env.PGUSER || "samantha",
  });

  const { rows: events } = await pool.query(
    `SELECT id, summary, source_text
     FROM events
     WHERE chat_id LIKE $1 AND embedding IS NULL
     ORDER BY message_index NULLS LAST, id`,
    [chatFilter],
  );
  console.log(`Events to embed: ${events.length}`);

  let ok = 0, fail = 0;
  for (const r of events) {
    const text = r.source_text && r.source_text.trim().length > 0
      ? `${r.summary}\n\n${r.source_text}`
      : r.summary;
    try {
      const v = await embed(settings, text.slice(0, 8000));
      await pool.query(
        `UPDATE events SET embedding = $1::vector WHERE id = $2`,
        [JSON.stringify(v), r.id],
      );
      ok++;
      if (ok % 50 === 0) console.log(`  events: ${ok}/${events.length}`);
    } catch (err) {
      fail++;
      console.warn(`  events fail id=${r.id}: ${err.message}`);
    }
  }
  console.log(`Events done: ${ok} ok, ${fail} failed`);

  const { rows: snapshots } = await pool.query(
    `SELECT id, summary, emotional_tone, present_chars
     FROM context_snapshots
     WHERE chat_id LIKE $1 AND embedding IS NULL
     ORDER BY message_index, id`,
    [chatFilter],
  );
  console.log(`Snapshots to embed: ${snapshots.length}`);

  let sok = 0, sfail = 0;
  for (const r of snapshots) {
    const parts = [r.summary];
    if (r.emotional_tone) parts.push(`tone: ${r.emotional_tone}`);
    if (r.present_chars && r.present_chars.length > 0) parts.push(`present: ${r.present_chars.join(", ")}`);
    const text = parts.join("\n");
    try {
      const v = await embed(settings, text.slice(0, 8000));
      await pool.query(
        `UPDATE context_snapshots SET embedding = $1::vector WHERE id = $2`,
        [JSON.stringify(v), r.id],
      );
      sok++;
      if (sok % 20 === 0) console.log(`  snapshots: ${sok}/${snapshots.length}`);
    } catch (err) {
      sfail++;
      console.warn(`  snapshots fail id=${r.id}: ${err.message}`);
    }
  }
  console.log(`Snapshots done: ${sok} ok, ${sfail} failed`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
