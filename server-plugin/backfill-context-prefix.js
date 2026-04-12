#!/usr/bin/env node
// One-shot backfill for memory_embeddings rows missing context_prefix.
// Safe to re-run: only touches rows where context_prefix IS NULL.
require("dotenv").config({ path: require("path").join(__dirname, "..", "eval", ".env") });
const { Pool } = require("pg");
const { generateSituatingBlurb } = require("./extractor");

const settings = {
  extractionApiKey: process.env.GEMINI_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  contextModel: process.env.GEMINI_CONTEXT_MODEL || "gemini-2.5-flash-lite",
};

async function main() {
  const pool = new Pool({
    host: "localhost",
    database: "chronicledb",
    user: process.env.PGUSER || "samantha",
  });

  const chatFilter = process.argv[2] || "%Protagonist%";
  const { rows: targets } = await pool.query(
    `SELECT id, chat_id, node_id, message_index, COALESCE(raw_text, content) as txt
     FROM memory_embeddings
     WHERE context_prefix IS NULL AND chat_id LIKE $1
     ORDER BY chat_id, message_index, node_id`,
    [chatFilter],
  );
  console.log(`Backfilling ${targets.length} rows…`);

  for (const row of targets) {
    const { rows: ctx } = await pool.query(
      `SELECT COALESCE(raw_text, content) as txt
       FROM memory_embeddings
       WHERE chat_id = $1 AND message_index BETWEEN $2 - 4 AND $2 + 4
       ORDER BY message_index, node_id`,
      [row.chat_id, row.message_index],
    );
    const surrounding = ctx.map((c) => c.txt).join("\n---\n");

    const blurb = await generateSituatingBlurb(settings, {
      chatTitle: row.chat_id,
      surroundingContext: surrounding,
      message: row.txt,
    });

    if (!blurb) {
      console.log(`  id=${row.id} msg=${row.message_index} → empty blurb, skipping`);
      continue;
    }

    await pool.query(
      `UPDATE memory_embeddings SET context_prefix = $1 WHERE id = $2`,
      [blurb, row.id],
    );
    console.log(`  id=${row.id} msg=${row.message_index} ✓ ${blurb.slice(0, 80)}`);
  }

  await pool.end();
  console.log("Done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
