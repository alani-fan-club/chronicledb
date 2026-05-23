#!/usr/bin/env node

// Read-only audit of duplicate character rows.
//
// Groups rows in `characters` by canonical name (lowercase, internal
// whitespace collapsed to single spaces) and prints every group with
// more than one row. For each row in a group, reports id, chat_id,
// participated_in count, traits count, knows count, alias count, and
// description length — the signals you need to pick which row should
// win a merge.
//
// No mutations. Pure SELECTs. Safe to run on a live DB.
//
// Usage:
//   node server-plugin/audit-character-duplicates.js
//   node server-plugin/audit-character-duplicates.js --chat <chatId>
//   node server-plugin/audit-character-duplicates.js --min-rows 3
//   node server-plugin/audit-character-duplicates.js --embedded
//   node server-plugin/audit-character-duplicates.js --embedded ~/.chronicledb/pgdata
//
// Flags:
//   --chat <id>     Restrict the audit to one chat (rows with that
//                   chat_id, plus all legacy NULL-chat rows so cross-
//                   chat collisions with a global show up).
//   --min-rows N    Only print groups whose size >= N. Default 2.
//   --embedded [d]  Force the embedded PGlite backend; optional dataDir
//                   follows. Mirrors merge-characters.js.

const db = require("./db");
const { loadScriptSettings } = require("./script-settings");

function parseArgs() {
  const args = { chat: null, minRows: 2, embedded: false, embeddedDataDir: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--chat") args.chat = process.argv[++i];
    else if (a === "--min-rows") args.minRows = parseInt(process.argv[++i], 10) || 2;
    else if (a === "--embedded") {
      args.embedded = true;
      const next = process.argv[i + 1];
      if (next && !next.startsWith("--")) args.embeddedDataDir = process.argv[++i];
    }
  }
  if (args.minRows < 2) args.minRows = 2;
  return args;
}

async function run() {
  const args = parseArgs();
  const { settings } = loadScriptSettings({ requiredConfig: false, loadEnv: true });
  if (args.embedded) {
    settings.dbBackend = "embedded";
    if (args.embeddedDataDir) settings.embeddedDataDir = args.embeddedDataDir;
    settings.pgHost = "";
  }
  const p = db.getPool(settings);

  // Canonical key: lowercase, trim, collapse internal whitespace. Matches
  // the same normalization graph-domain.js uses on the read path so
  // groups here line up with what would visually merge in the mindmap.
  const chatFilter = args.chat
    ? `WHERE chat_id = $1 OR chat_id IS NULL`
    : "";
  const params = args.chat ? [args.chat] : [];

  const { rows: groups } = await p.query(
    `WITH norm AS (
       SELECT id, chat_id, name,
              lower(regexp_replace(trim(name), '\\s+', ' ', 'g')) AS canon,
              COALESCE(aliases, '{}'::text[]) AS aliases,
              COALESCE(description, '') AS description
         FROM characters
       ${chatFilter}
     )
     SELECT canon, COUNT(*)::int AS n
       FROM norm
      GROUP BY canon
     HAVING COUNT(*) >= ${args.minRows}
      ORDER BY n DESC, canon ASC`,
    params,
  );

  if (groups.length === 0) {
    console.log(`No name groups with >= ${args.minRows} rows${args.chat ? ` in chat ${args.chat}` : ""}.`);
    await p.end();
    return;
  }

  console.log(`Found ${groups.length} duplicate name group(s)${args.chat ? ` in chat ${args.chat}` : ""}:\n`);

  for (const g of groups) {
    // Pull the rows in this group with the per-row signals merge needs.
    // Counts come from sub-selects rather than joins so a missing index
    // never produces an over-counted row via fan-out.
    const { rows } = await p.query(
      `SELECT c.id,
              c.chat_id,
              c.name,
              cardinality(COALESCE(c.aliases, '{}'::text[])) AS n_aliases,
              length(COALESCE(c.description, '')) AS desc_len,
              (SELECT COUNT(*)::int FROM participated_in pi WHERE pi.character_id = c.id) AS n_events,
              (SELECT COUNT(*)::int FROM traits t WHERE t.character_id = c.id AND t.canonical_id IS NULL) AS n_traits,
              (SELECT COUNT(*)::int FROM knows k WHERE k.character_id = c.id) AS n_knows,
              (SELECT COUNT(*)::int FROM feels_about fa WHERE fa.from_char = c.id OR fa.to_char = c.id) AS n_rels
         FROM characters c
        WHERE lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g')) = $1
          ${args.chat ? "AND (c.chat_id = $2 OR c.chat_id IS NULL)" : ""}
        ORDER BY n_events DESC, n_traits DESC, n_aliases DESC, length(c.name) DESC, c.id ASC`,
      args.chat ? [g.canon, args.chat] : [g.canon],
    );
    console.log(`──  "${g.canon}"  (${g.n} rows)`);
    for (const r of rows) {
      const chat = r.chat_id || "(global / NULL)";
      console.log(
        `    ${r.id}\n` +
        `      name="${r.name}"  chat=${chat}\n` +
        `      events=${r.n_events}  traits=${r.n_traits}  knows=${r.n_knows}  rels=${r.n_rels}  aliases=${r.n_aliases}  desc=${r.desc_len}ch`,
      );
    }
    // Suggest a merge command using the row with the most events as canonical.
    const survivor = rows[0];
    const others = rows.slice(1);
    if (survivor && others.length > 0) {
      const otherNames = Array.from(new Set(others.map((r) => r.name).filter((n) => n && n !== survivor.name)));
      const mergeFlags = otherNames.length > 0
        ? `--merge ${otherNames.map((n) => JSON.stringify(n)).join(" ")}`
        : `--merge ${JSON.stringify(survivor.name)}`;
      const chatFlag = survivor.chat_id ? `--chat ${JSON.stringify(survivor.chat_id)}` : "";
      const globalFlag = others.some((r) => r.chat_id === null) || survivor.chat_id === null ? "--global" : "";
      console.log(
        `    suggested merge (dry-run first):\n` +
        `      node server-plugin/merge-characters.js ${chatFlag} --canonical ${JSON.stringify(survivor.name)} ${mergeFlags} ${globalFlag} --dry-run`.replace(/\s+/g, " "),
      );
    }
    console.log("");
  }

  await p.end();
}

run().catch((err) => {
  console.error("audit-character-duplicates failed:", err);
  process.exit(1);
});
