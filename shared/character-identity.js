const { createHash } = require("crypto");

function normalizeSurfaceName(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function slugify(name) {
  return "chr-" + String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function chatScopedId(name, chatId) {
  const baseSlug = slugify(name);
  if (!chatId) return baseSlug;
  const hash = createHash("sha1").update(String(chatId)).digest("hex").slice(0, 6);
  return `chr-${hash}-${baseSlug.slice(4)}`;
}

function normalizeChatIds(chatIds) {
  if (Array.isArray(chatIds)) return chatIds.filter((id) => typeof id === "string" && id.length > 0);
  if (typeof chatIds === "string" && chatIds.length > 0) return [chatIds];
  return [];
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((v) => typeof v === "string" && v.trim().length > 0))];
}

function fallbackIdsForName(name, chatIds) {
  const ids = [slugify(name)];
  for (const chatId of normalizeChatIds(chatIds)) ids.push(chatScopedId(name, chatId));
  return [...new Set(ids)];
}

async function resolveCharacterIds(pool, { names, chatIds, includeFallbacks = true } = {}) {
  const inputNames = uniqueStrings(names);
  const scopedChatIds = normalizeChatIds(chatIds);
  const byName = new Map();
  for (const name of inputNames) {
    byName.set(name, includeFallbacks ? fallbackIdsForName(name, scopedChatIds) : []);
  }
  if (!pool || inputNames.length === 0) return byName;

  const scoped = scopedChatIds.length > 0;
  const params = scoped ? [inputNames, scopedChatIds] : [inputNames];
  const chatFilter = scoped ? "AND (c.chat_id = ANY($2::text[]) OR c.chat_id IS NULL)" : "";
  // Exact-match pass (case + whitespace normalized): primary name OR alias.
  const { rows } = await pool.query(
    `WITH input(name, norm_name) AS (
       SELECT raw_name, lower(regexp_replace(trim(raw_name), '\\s+', ' ', 'g'))
       FROM UNNEST($1::text[]) AS u(raw_name)
     )
     SELECT input.name AS input_name, c.id
       FROM input
       JOIN characters c
         ON lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g')) = input.norm_name
         OR EXISTS (
           SELECT 1
             FROM unnest(COALESCE(c.aliases, '{}'::text[])) a(alias)
            WHERE lower(regexp_replace(trim(a.alias), '\\s+', ' ', 'g')) = input.norm_name
         )
      WHERE 1=1 ${chatFilter}
      ORDER BY input.name, (c.chat_id IS NULL) ASC, c.updated_at DESC NULLS LAST`,
    params,
  );

  for (const row of rows) {
    if (!row.input_name || !row.id) continue;
    const ids = byName.get(row.input_name) || [];
    if (!ids.includes(row.id)) ids.push(row.id);
    byName.set(row.input_name, ids);
  }

  // ── Containment-fallback pass (chat-scoped only) ────────────────
  // SillyTavern stores the message author as the FULL character-card
  // name (e.g. "Antonio Tony Knives Falcone  CORSETTI FAMILY") while the
  // extractor LLM emits the de-suffixed form ("Antonio Tony Knives
  // Falcone"). When the verbose form arrives in `names` from the UI's
  // last-10-messages activeCharacters, the exact-match pass returns
  // nothing and the character's traits/location silently disappear from
  // the rendered memory block.
  //
  // Fallback: for any input that resolved to ZERO ids in the exact pass
  // AND has at least 4 characters (avoid false-positive matches like
  // "Tom" against "Atom"), look for a chat-scoped row whose normalized
  // primary name OR any alias is contained in the input as a contiguous
  // substring (or vice versa). Only chat-scoped rows participate —
  // legacy global rows (chat_id IS NULL) stay invisible because their
  // alias pollution is the whole reason scoping exists.
  //
  // The check is bounded to the active chat's character set, which is
  // typically 2–10 rows, so the per-input scan is cheap. Skipped
  // entirely when scoping is off (eval/CLI) so unscoped callers don't
  // pull in rows from arbitrary chats by name overlap.
  if (scoped) {
    const unresolved = [];
    for (const name of inputNames) {
      const ids = byName.get(name) || [];
      const hasNonFallback = (rows || []).some((r) => r.input_name === name && r.id);
      if (!hasNonFallback && name.trim().length >= 4) unresolved.push(name);
    }
    if (unresolved.length > 0) {
      const { rows: fuzzyRows } = await pool.query(
        `WITH input(name, norm_name) AS (
           SELECT raw_name, lower(regexp_replace(trim(raw_name), '\\s+', ' ', 'g'))
           FROM UNNEST($1::text[]) AS u(raw_name)
         )
         SELECT DISTINCT ON (input.name) input.name AS input_name, c.id, c.name AS row_name,
                length(c.name) AS row_name_len
           FROM input
           JOIN characters c
             ON c.chat_id = ANY($2::text[])
            AND length(trim(c.name)) >= 4
            AND (
              -- row's name appears as a substring of the input name
              position(lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g'))
                       IN input.norm_name) > 0
              -- OR the input appears as a substring of the row's name
              OR position(input.norm_name
                          IN lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g'))) > 0
              -- OR a usable alias overlaps either way
              OR EXISTS (
                SELECT 1
                  FROM unnest(COALESCE(c.aliases, '{}'::text[])) a(alias)
                 WHERE length(trim(a.alias)) >= 4
                   AND (
                     position(lower(regexp_replace(trim(a.alias), '\\s+', ' ', 'g'))
                              IN input.norm_name) > 0
                     OR position(input.norm_name
                                 IN lower(regexp_replace(trim(a.alias), '\\s+', ' ', 'g'))) > 0
                   )
              )
            )
          ORDER BY input.name, length(c.name) DESC, c.updated_at DESC NULLS LAST`,
        [unresolved, scopedChatIds],
      );
      for (const row of fuzzyRows) {
        if (!row.input_name || !row.id) continue;
        const ids = byName.get(row.input_name) || [];
        if (!ids.includes(row.id)) ids.push(row.id);
        byName.set(row.input_name, ids);
      }
    }
  }

  return byName;
}

function flattenResolvedCharacterIds(byName) {
  const out = [];
  for (const ids of byName.values()) {
    for (const id of ids) {
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

module.exports = {
  normalizeSurfaceName,
  slugify,
  chatScopedId,
  fallbackIdsForName,
  resolveCharacterIds,
  flattenResolvedCharacterIds,
};
