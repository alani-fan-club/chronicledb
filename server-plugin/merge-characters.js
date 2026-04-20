#!/usr/bin/env node

// One-shot character-cluster merge. Use when the extractor has split a
// single in-story character across multiple rows (e.g. "Captain Roe" /
// "Captain James Roe" / "the merchant's father" all become separate
// chr-* ids because the extractor emitted them as different surface
// names).
//
// Resolves every name in --merge plus --canonical to its row, picks the
// canonical (the row whose name matches --canonical, else the row with
// the most events), repoints every FK reference and TEXT[] mention from
// the duplicates onto the canonical, unions aliases, and deletes the
// duplicate rows. Conflict-tolerant on every per-row UPDATE so existing
// (canonical_id, X) rows aren't violated when the duplicate also had
// (duplicate_id, X) for the same X.
//
// Usage:
//   node server-plugin/merge-characters.js \
//     --chat <chatId> \
//     --canonical "James Roe" \
//     --merge "Captain Roe" "Captain James" "the merchant's father" \
//             "Mr. Roe" "Lord Roe" "Roe of Westridge"
//
// Pass --global to also consider chat_id IS NULL rows (legacy globals).
// Pass --dry-run to print the plan without mutating.

const db = require("./db");
const { loadScriptSettings } = require("./script-settings");

function parseArgs() {
  const args = {
    merge: [], chat: null, canonical: null, global: false, dryRun: false,
    embedded: false, embeddedDataDir: null,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--chat") args.chat = process.argv[++i];
    else if (a === "--canonical") args.canonical = process.argv[++i];
    else if (a === "--global") args.global = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--embedded") {
      // Optional dataDir follows. If the next arg is a flag or absent,
      // fall back to the default ~/.chronicledb/pgdata.
      args.embedded = true;
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) args.embeddedDataDir = process.argv[++i];
    }
    else if (a === "--merge") {
      // Consume every following non-flag arg as a name to merge.
      while (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) {
        args.merge.push(process.argv[++i]);
      }
    }
  }
  return args;
}

async function resolveRow(p, name, chatId, includeGlobal) {
  // Match on name OR alias, case- and whitespace-insensitive. Prefer
  // chat-scoped over global; tiebreak to richer aliases / longer name
  // so a stub doesn't beat the real canonical.
  const lookup = String(name).trim().toLowerCase();
  const { rows } = await p.query(
    `SELECT id, chat_id, name, COALESCE(aliases, '{}'::text[]) AS aliases
       FROM characters
      WHERE (chat_id = $1 ${includeGlobal ? "OR chat_id IS NULL" : ""})
        AND (
          lower(trim(name)) = $2
          OR EXISTS (
            SELECT 1 FROM unnest(COALESCE(aliases, '{}'::text[])) a
             WHERE lower(trim(a)) = $2
          )
        )
      ORDER BY (chat_id = $1) DESC NULLS LAST,
               cardinality(COALESCE(aliases, '{}'::text[])) DESC,
               length(name) DESC`,
    [chatId, lookup],
  );
  return rows;
}

async function eventCount(p, characterId) {
  const { rows } = await p.query(
    `SELECT COUNT(*)::int AS n FROM participated_in WHERE character_id = $1`,
    [characterId],
  );
  return rows[0].n;
}

async function repointFkConflictTolerant(p, table, fkCol, dupId, canonId, conflictCols) {
  // Repoint FK rows from dupId → canonId. For tables with a UNIQUE on
  // (fkCol, ...conflictCols), a straight UPDATE would violate the
  // constraint when the canonical already has an equivalent row. So we
  // first DELETE the duplicate rows that would collide (the canonical
  // already covers them), then UPDATE everything else.
  if (conflictCols.length > 0) {
    const colMatch = conflictCols.map((c) => `t.${c} = d.${c}`).join(" AND ");
    await p.query(
      `DELETE FROM ${table} d
        WHERE d.${fkCol} = $1
          AND EXISTS (
            SELECT 1 FROM ${table} t
             WHERE t.${fkCol} = $2
               AND ${colMatch}
          )`,
      [dupId, canonId],
    );
  }
  const res = await p.query(
    `UPDATE ${table} SET ${fkCol} = $2 WHERE ${fkCol} = $1`,
    [dupId, canonId],
  );
  return res.rowCount || 0;
}

async function repointArrayMention(p, table, arrCol, dupId, canonId) {
  // For TEXT[] columns that mention character ids by value
  // (context_snapshots.present_chars, plot_threads.involved_chars).
  // Replace dupId with canonId in the array, then dedup.
  const res = await p.query(
    `UPDATE ${table}
        SET ${arrCol} = (
              SELECT COALESCE(array_agg(DISTINCT CASE WHEN x = $1 THEN $2 ELSE x END), '{}'::text[])
                FROM unnest(${arrCol}) x
            )
      WHERE $1 = ANY(${arrCol})`,
    [dupId, canonId],
  );
  return res.rowCount || 0;
}

async function mergeOne(settings, dupId, canonId, dryRun) {
  const p = db.getPool(settings);
  if (dryRun) {
    console.log(`  [dry-run] would merge ${dupId} → ${canonId}`);
    return;
  }
  const stats = {};
  // Edge tables with UNIQUE constraints — repoint with conflict handling.
  stats.feels_about_from = await repointFkConflictTolerant(p, "feels_about", "from_char", dupId, canonId, ["to_char", "session_id"]);
  stats.feels_about_to   = await repointFkConflictTolerant(p, "feels_about", "to_char",   dupId, canonId, ["from_char", "session_id"]);
  stats.knows            = await repointFkConflictTolerant(p, "knows", "character_id", dupId, canonId, ["fact_id", "chat_id"]);
  stats.participated_in  = await repointFkConflictTolerant(p, "participated_in", "character_id", dupId, canonId, ["event_id"]);
  stats.plot_thread_chr  = await repointFkConflictTolerant(p, "plot_thread_characters", "character_id", dupId, canonId, ["plot_id"]);
  stats.traits           = await repointFkConflictTolerant(p, "traits", "character_id", dupId, canonId, ["category", "normalized_content"]);
  // FK columns with no relevant uniqueness — straight UPDATE.
  stats.present_at       = await repointFkConflictTolerant(p, "present_at", "character_id", dupId, canonId, []);
  stats.items_owner      = await repointFkConflictTolerant(p, "items", "owner_id", dupId, canonId, []);
  // TEXT[] mention columns.
  stats.ctx_present      = await repointArrayMention(p, "context_snapshots", "present_chars", dupId, canonId);
  stats.plot_involved    = await repointArrayMention(p, "plot_threads", "involved_chars", dupId, canonId);
  // Capture the duplicate's name + aliases into canonical's alias list,
  // then drop the duplicate row.
  await p.query(
    `UPDATE characters c
        SET aliases = (
              SELECT array_agg(DISTINCT a)
                FROM unnest(
                  COALESCE(c.aliases, '{}'::text[])
                  || ARRAY[(SELECT name FROM characters WHERE id = $2)]
                  || COALESCE((SELECT aliases FROM characters WHERE id = $2), '{}'::text[])
                ) a
               WHERE a IS NOT NULL AND length(trim(a)) > 0
            ),
            description = COALESCE(NULLIF(c.description, ''),
                                   (SELECT description FROM characters WHERE id = $2)),
            updated_at = NOW()
      WHERE c.id = $1`,
    [canonId, dupId],
  );
  await p.query(`DELETE FROM characters WHERE id = $1`, [dupId]);
  const summary = Object.entries(stats)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  console.log(`  merged ${dupId} → ${canonId}  ${summary}`);
}

async function run() {
  const args = parseArgs();
  if (!args.canonical || args.merge.length === 0) {
    console.error(
      "Usage: node server-plugin/merge-characters.js \\\n" +
      "  --chat <chatId> --canonical \"Name\" --merge \"Alias 1\" \"Alias 2\" ...\n" +
      "Optional: --global (also match chat_id IS NULL rows), --dry-run",
    );
    process.exit(1);
  }
  const { settings } = loadScriptSettings({ requiredConfig: false, loadEnv: true });
  if (args.embedded) {
    // Force the embedded PGlite backend regardless of any pgHost the
    // shared script-settings loader fell back to. This is what live ST
    // uses for fresh installs, so the script needs an explicit way to
    // point at the same store from the CLI.
    settings.dbBackend = "embedded";
    if (args.embeddedDataDir) settings.embeddedDataDir = args.embeddedDataDir;
    settings.pgHost = "";
  }
  const p = db.getPool(settings);
  const includeGlobal = !!args.global;

  // Resolve canonical: pick the row whose surface form matches --canonical.
  const canonRows = await resolveRow(p, args.canonical, args.chat, includeGlobal);
  if (canonRows.length === 0) {
    console.error(`No row found matching canonical "${args.canonical}" (chat=${args.chat || "*"})`);
    process.exit(2);
  }
  // If multiple resolve, prefer the one whose .name lower-trim equals
  // canonical exactly; else the one with the most events.
  const target = String(args.canonical).trim().toLowerCase();
  let canon = canonRows.find((r) => r.name.trim().toLowerCase() === target);
  if (!canon) {
    let best = null;
    let bestN = -1;
    for (const r of canonRows) {
      const n = await eventCount(p, r.id);
      if (n > bestN) { best = r; bestN = n; }
    }
    canon = best;
  }
  console.log(`canonical: ${canon.id}  name=${canon.name}  chat=${canon.chat_id || "(global)"}`);

  // Resolve each --merge name and collect unique IDs that aren't the canonical.
  const dupIds = new Set();
  for (const name of args.merge) {
    const rows = await resolveRow(p, name, args.chat, includeGlobal);
    if (rows.length === 0) {
      console.warn(`  no row matches "${name}" — skipping`);
      continue;
    }
    for (const r of rows) {
      if (r.id !== canon.id) dupIds.add(r.id);
    }
  }
  if (dupIds.size === 0) {
    console.log("nothing to merge — every name already resolves to the canonical row");
    await p.end();
    return;
  }
  console.log(`will merge ${dupIds.size} row(s) into ${canon.id}:`);
  for (const id of dupIds) console.log(`  - ${id}`);

  for (const dupId of dupIds) {
    try {
      await mergeOne(settings, dupId, canon.id, args.dryRun);
    } catch (err) {
      console.error(`  FAILED ${dupId} → ${canon.id}: ${err.message}`);
    }
  }

  await p.end();
}

run().catch((err) => {
  console.error("merge-characters failed:", err);
  process.exit(1);
});
