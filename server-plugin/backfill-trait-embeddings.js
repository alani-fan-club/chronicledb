#!/usr/bin/env node
/*
 * Backfill trait.embedding for all existing rows and then run a
 * canonical-merge pass over every (character, category) group.
 *
 * Phase 1: Embedding backfill
 *   - Walks every trait row with NULL embedding.
 *   - Joins to characters.name so we can build the contextual embedding
 *     text `${name} is ${content}` (no evidence_sentence for legacy
 *     rows — they never captured one). This matches upsertTrait's
 *     fallback shape when evidence is missing.
 *   - Batches through extractor.embedBatch (Gemini batchEmbedContents,
 *     50 per call).
 *   - UPDATEs traits.embedding per row.
 *
 * Phase 2: Canonical-merge pass
 *   - For each (character_id, category) group, ordered by row count
 *     DESC so big groups go first, walk the rows sorted by
 *     length(content) DESC (the "longer wording is more specific" rule
 *     Path 1's upsertTrait uses).
 *   - For each row, kNN against already-processed canonical rows in
 *     the same group using the partial HNSW index. If top cosine is
 *     >= 0.88, mark this row as merged: set canonical_id to the
 *     canonical, append `${content}: ${evidence}` or just content to
 *     the canonical's aliases, bump merged_count.
 *   - Rows that survive (no canonical hit) become canonical themselves
 *     — canonical_id stays NULL and they become targets for the next
 *     rows in the group.
 *
 * Phase 3: Summary refresh
 *   - Calls recomputeCharacterSummary for every character with any
 *     trait so characters.summary_embedding gets populated.
 *
 * Idempotent: re-running only touches rows with NULL embedding, and
 * the merge pass is a no-op for already-merged rows (it skips rows
 * whose canonical_id IS NOT NULL).
 *
 * Cost: ~1 embedding call per NULL-embedding row. A full backfill on
 * ~1100 rows runs ~22 batches of 50 each = 22 batchEmbedContents calls.
 * Gemini embedding is $0.15 per 1M input tokens; contextual strings
 * here are ~20 tokens each, so 1100 * 20 = 22,000 tokens, or roughly
 * $0.0033 — budget-negligible.
 *
 * Usage:
 *   node server-plugin/backfill-trait-embeddings.js
 */

const { loadScriptSettings, createPoolFromSettings } = require("./script-settings");
const { embedBatch } = require("./extractor");

const EMBED_BATCH_SIZE = 50;
const MERGE_THRESHOLD = 0.88;

async function main() {
  const { settings } = loadScriptSettings();
  const pool = createPoolFromSettings(settings);

  // ── Phase 0: Before-state counts ─────────────────────────────
  const { rows: beforeTotal } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE embedding IS NULL)::int AS null_embedding,
            COUNT(*) FILTER (WHERE canonical_id IS NULL)::int AS canonical,
            COUNT(*) FILTER (WHERE canonical_id IS NOT NULL)::int AS merged
     FROM traits`,
  );
  const before = beforeTotal[0];
  console.log(
    `[backfill-trait-embeddings] before: total=${before.total} ` +
    `null_embedding=${before.null_embedding} canonical=${before.canonical} merged=${before.merged}`,
  );
  console.log(
    `[backfill-trait-embeddings] cost estimate: ~${before.null_embedding} embedding calls ` +
    `(~${(before.null_embedding * 20).toLocaleString()} input tokens, ~$${(before.null_embedding * 20 * 0.15 / 1e6).toFixed(5)} ` +
    `at gemini-embedding-2-preview $0.15/1M)`,
  );

  // ── Phase 1: Embedding backfill ──────────────────────────────
  const { rows: targets } = await pool.query(
    `SELECT t.id AS trait_id, t.content, t.category, c.id AS character_id, c.name AS character_name
     FROM traits t
     JOIN characters c ON c.id = t.character_id
     WHERE t.embedding IS NULL
     ORDER BY t.character_id, t.category, t.id`,
  );

  if (targets.length === 0) {
    console.log("[backfill-trait-embeddings] Phase 1: nothing to embed.");
  } else {
    console.log(`[backfill-trait-embeddings] Phase 1: embedding ${targets.length} rows...`);
    let embedOk = 0;
    let embedFail = 0;
    for (let start = 0; start < targets.length; start += EMBED_BATCH_SIZE) {
      const batch = targets.slice(start, start + EMBED_BATCH_SIZE);
      const texts = batch.map(
        (r) => `${(r.character_name || r.character_id || "").toString().trim() || r.character_id} is ${r.content}`,
      );

      let vectors = null;
      try {
        vectors = await embedBatch(settings, texts);
      } catch (err) {
        console.warn(`[backfill-trait-embeddings] batch ${start}-${start + batch.length} embed failed: ${err.message}`);
        embedFail += batch.length;
        continue;
      }

      for (let i = 0; i < batch.length; i++) {
        const row = batch[i];
        const vec = vectors[i];
        if (!vec) {
          embedFail++;
          continue;
        }
        try {
          await pool.query(
            `UPDATE traits SET embedding = $1::vector WHERE id = $2`,
            [JSON.stringify(vec), row.trait_id],
          );
          embedOk++;
        } catch (err) {
          console.warn(`[backfill-trait-embeddings] update id=${row.trait_id} failed: ${err.message}`);
          embedFail++;
        }
      }
      if (embedOk % 100 === 0 || start + EMBED_BATCH_SIZE >= targets.length) {
        console.log(`  phase 1: ${embedOk}/${targets.length} ok, ${embedFail} failed`);
      }
    }
    console.log(`[backfill-trait-embeddings] Phase 1 done: ${embedOk} ok, ${embedFail} failed`);
  }

  // ── Phase 2: Canonical-merge pass ────────────────────────────
  // Walk each (character_id, category) group. For every row with an
  // embedding, ordered by length(content) DESC (the longer-wording-wins
  // rule upsertTrait uses), check kNN against canonical rows we've
  // already processed in this group — if top cosine >= 0.88, mark the
  // row as merged. Rows that don't merge stay canonical (canonical_id
  // IS NULL).
  //
  // The kNN uses idx_traits_embedding_hnsw's partial index which is
  // already restricted to canonical_id IS NULL, so the search
  // automatically excludes prior-pass merges.
  const { rows: groups } = await pool.query(
    `SELECT character_id, category, COUNT(*)::int AS n
     FROM traits
     WHERE embedding IS NOT NULL AND canonical_id IS NULL
     GROUP BY character_id, category
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC`,
  );
  console.log(`[backfill-trait-embeddings] Phase 2: ${groups.length} (character, category) groups to dedupe`);

  let totalMerged = 0;
  let totalCanonical = 0;
  const touchedCharacters = new Set();
  for (const grp of groups) {
    touchedCharacters.add(grp.character_id);

    // Longest content first. This lets more-specific wording ("Former
    // yakuza captain of Faction family") become canonical over shorter
    // "yakuza captain" fragments that land near it.
    const { rows: rows } = await pool.query(
      `SELECT id, content, evidence_sentence, length(content) AS len
       FROM traits
       WHERE character_id = $1 AND category = $2
         AND embedding IS NOT NULL AND canonical_id IS NULL
       ORDER BY length(content) DESC, id`,
      [grp.character_id, grp.category],
    );

    let grpCanonical = 0;
    let grpMerged = 0;
    for (const row of rows) {
      // Re-check: an earlier iteration may have merged this row onto
      // a longer canonical. Skip if so.
      const { rows: cur } = await pool.query(
        `SELECT canonical_id FROM traits WHERE id = $1`,
        [row.id],
      );
      if (!cur[0] || cur[0].canonical_id !== null) continue;

      // kNN against existing canonical rows in the group, EXCLUDING
      // the row itself. The partial HNSW index handles the
      // canonical_id IS NULL filter.
      const { rows: neighbors } = await pool.query(
        `SELECT id, content, 1 - (embedding <=> (SELECT embedding FROM traits WHERE id = $1)) AS cos
         FROM traits
         WHERE character_id = $2 AND category = $3
           AND canonical_id IS NULL
           AND embedding IS NOT NULL
           AND id <> $1
         ORDER BY embedding <=> (SELECT embedding FROM traits WHERE id = $1)
         LIMIT 3`,
        [row.id, grp.character_id, grp.category],
      );

      if (neighbors.length > 0 && neighbors[0].cos >= MERGE_THRESHOLD) {
        // Merge onto the nearest canonical. Because we walked in
        // length DESC order, the "nearest canonical" is always an
        // already-processed row whose content is >= this row's
        // content in length — but since we ORDER BY embedding
        // distance, an even longer row could win. Either way,
        // absorbing this row into it is correct.
        const canonical = neighbors[0];
        const aliasEntry = row.evidence_sentence
          ? `${row.content}: ${row.evidence_sentence}`
          : row.content;
        await pool.query(
          `UPDATE traits
           SET aliases = array_append(COALESCE(aliases, '{}'::text[]), $2),
               merged_count = COALESCE(merged_count, 1) + 1
           WHERE id = $1`,
          [canonical.id, aliasEntry],
        );
        await pool.query(
          `UPDATE traits SET canonical_id = $2 WHERE id = $1`,
          [row.id, canonical.id],
        );
        grpMerged++;
        totalMerged++;
      } else {
        grpCanonical++;
        totalCanonical++;
      }
    }
    if (grpMerged > 0) {
      console.log(
        `  ${grp.character_id}/${grp.category}: ${grp.n} → ${grpCanonical} canonical (+${grpMerged} merged)`,
      );
    }
  }
  console.log(
    `[backfill-trait-embeddings] Phase 2 done: ${totalCanonical} stayed canonical, ${totalMerged} merged`,
  );

  // ── Phase 3: Refresh per-character rollup embedding ──────────
  // recomputeCharacterSummary lives in db.js and takes the same
  // settings shape we've been using. We import it here rather than
  // duplicating the AVG(vector) query so the source of truth stays
  // in db.js.
  const { recomputeCharacterSummary } = require("./db");
  const allCharQuery = await pool.query(
    `SELECT DISTINCT character_id FROM traits WHERE embedding IS NOT NULL`,
  );
  console.log(
    `[backfill-trait-embeddings] Phase 3: refreshing summary_embedding for ${allCharQuery.rows.length} characters`,
  );
  let rollupOk = 0;
  let rollupFail = 0;
  for (const row of allCharQuery.rows) {
    try {
      await recomputeCharacterSummary(settings, row.character_id);
      rollupOk++;
    } catch (err) {
      console.warn(`[backfill-trait-embeddings] rollup ${row.character_id} failed: ${err.message}`);
      rollupFail++;
    }
  }
  console.log(`[backfill-trait-embeddings] Phase 3 done: ${rollupOk} ok, ${rollupFail} failed`);

  // ── After-state counts ───────────────────────────────────────
  const { rows: afterTotal } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE embedding IS NULL)::int AS null_embedding,
            COUNT(*) FILTER (WHERE canonical_id IS NULL)::int AS canonical,
            COUNT(*) FILTER (WHERE canonical_id IS NOT NULL)::int AS merged
     FROM traits`,
  );
  const after = afterTotal[0];
  console.log(
    `[backfill-trait-embeddings] after:  total=${after.total} ` +
    `null_embedding=${after.null_embedding} canonical=${after.canonical} merged=${after.merged}`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
