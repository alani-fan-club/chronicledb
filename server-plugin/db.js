const { readFileSync } = require("fs");
const { resolve } = require("path");
const { createHash } = require("crypto");
const { GOLDBERG_100, NRC_EMOTION, NRC_VAD } = require("../shared/trait-lexicons");
const {
  slugify,
  chatScopedId,
  resolveCharacterIds,
  flattenResolvedCharacterIds,
} = require("../shared/character-identity");
const { setWithBoundedEviction } = require("./bounded-map");
const { buildClient, isEmbeddedBackend, describeBackend } = require("./db/client");
const { createRetrievalDomain } = require("./db/retrieval-domain");
const { createGraphDomain } = require("./db/graph-domain");
const { createCharacterPanelDomain } = require("./db/character-panel-domain");

let pool = null;
let poolConfigHash = "";

// Pool error handler. pg.Pool emits 'error' when an IDLE client fails —
// typically because the DB server restarted, dropped the connection, or
// the network blipped. Without a listener, node-postgres crashes the
// process on emit. index.js registers a real handler that flips the
// plugin's connectionState so /status reflects the outage; before that
// runs, the default below just logs so we still see what happened.
let poolErrorHandler = (err) => {
  console.error("[ChronicleDB] Pool error (idle client):", err?.message || err);
};

function setPoolErrorHandler(fn) {
  if (typeof fn === "function") poolErrorHandler = fn;
}

/**
 * Compute a deterministic content-addressed ID from a semantic key.
 * Re-ingesting the same content will produce the same ID, allowing
 * ON CONFLICT clauses to dedupe rows instead of inserting duplicates.
 */
function contentId(prefix, key) {
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

function getPool(settings) {
  // configHash captures every input that would force a new client:
  // the backend choice (embedded vs external), the embedded data dir,
  // and the external connection coordinates. Changing any of these
  // through the settings UI tears the old client down and rebuilds.
  const configHash = isEmbeddedBackend(settings)
    ? `embedded:${settings.embeddedDataDir || ""}`
    : `external:${settings.pgHost}:${settings.pgPort}:${settings.pgDatabase}:${settings.pgUser}`;
  if (!pool || configHash !== poolConfigHash) {
    if (pool) pool.end().catch(() => {});
    poolConfigHash = configHash;
    pool = buildClient(settings);
    pool.on("error", (err) => {
      try { poolErrorHandler(err); } catch (_) { /* swallowing ensures listener never throws */ }
    });
  }
  return pool;
}

async function initSchema(settings) {
  const p = getPool(settings);
  const raw = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
  // Execute as a single multi-statement batch. Every statement is
  // idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
  // ALTER TABLE ... ADD COLUMN IF NOT EXISTS, DROP ... IF EXISTS, plus
  // the DO block gating the H3 constraint), so no transaction wrapping.
  // `.exec()` routes through the simple-query protocol on both backends
  // so multi-statement SQL is handled correctly.
  try {
    await p.exec(raw);
  } catch (err) {
    if (!err.message.includes("already exists")) {
      console.warn(`[ChronicleDB] Schema warning: ${err.message}`);
    }
  }
  console.log(`[ChronicleDB] Schema initialized — ${describeBackend(settings)}`);
}

// ── Node upserts ───────────────────────────────────────────────

const {
  storeEmbedding,
  upsertMemoryEmbedding,
  upsertDialogueQuote,
} = createRetrievalDomain({ getPool });

const {
  traverseFromCharacter,
  getGraphData,
} = createGraphDomain({ getPool, slugify, chatScopedId });

const {
  getCharacterPanelStats,
  getCharacterRecentEvents,
  getCharacterOutboundRelationships,
} = createCharacterPanelDomain({ getPool, slugify, chatScopedId });

// Resolve (or create) the global persona row for a given persona name.
// Persona rows have chat_id IS NULL AND is_persona = TRUE. Returns the
// row id. The id is content-addressed (`persona-<slug>`) so two chats
// referring to the same persona name converge on one row.
//
// Idempotent: if a persona row already exists for this name (by id or
// by lower(name) match) we keep it and just refresh updated_at.
async function ensurePersonaCharacter(settings, { name, aliases, description }) {
  if (!name || typeof name !== "string" || !name.trim()) return null;
  const p = getPool(settings);
  const id = `persona-${slugify(name)}`;
  const incomingForms = Array.from(new Set(
    [name, ...(aliases || [])]
      .filter((a) => typeof a === "string" && a.trim().length > 0)
      .map((a) => a.trim()),
  ));
  // Try lookup first (handles slug collisions across persona renames).
  const { rows: existing } = await p.query(
    `SELECT id FROM characters
      WHERE is_persona = TRUE AND chat_id IS NULL
        AND (id = $1 OR lower(trim(name)) = lower(trim($2::text)))
      LIMIT 1`,
    [id, name],
  );
  if (existing.length > 0) {
    const rowId = existing[0].id;
    await p.query(
      `UPDATE characters
          SET aliases = (
                SELECT COALESCE(array_agg(DISTINCT a), '{}'::text[])
                  FROM unnest(COALESCE(aliases, '{}'::text[]) || $2::text[]) a
                 WHERE a IS NOT NULL AND length(trim(a)) > 0
              ),
              description = COALESCE(NULLIF($3, ''), description),
              updated_at = NOW()
        WHERE id = $1`,
      [rowId, incomingForms, description || ""],
    );
    return rowId;
  }
  await p.query(
    `INSERT INTO characters (id, name, chat_id, aliases, description, is_persona, status)
     VALUES ($1, $2, NULL, $3, $4, TRUE, 'persona')
     ON CONFLICT (id) DO UPDATE SET
       aliases = EXCLUDED.aliases,
       description = COALESCE(NULLIF(EXCLUDED.description, ''), characters.description),
       is_persona = TRUE,
       updated_at = NOW()`,
    [id, name, incomingForms, description || ""],
  );
  return id;
}

async function upsertCharacter(settings, { name, aliases, description, firstSeen, chatId, isPersona }) {
  const p = getPool(settings);

  // Build the bag of surface forms this call asserts belong to one
  // character: the primary name plus any aliases the extractor handed
  // us. Anything in this set is what we'll match existing rows against
  // and what we'll union into the resolved row's aliases column.
  const incomingForms = Array.from(new Set(
    [name, ...(aliases || [])]
      .filter((a) => typeof a === "string" && a.trim().length > 0)
      .map((a) => a.trim()),
  ));
  const normalizedForms = incomingForms.map((n) => n.toLowerCase());

  // Look for an existing row whose own name OR alias list contains any
  // of the incoming forms (case- and whitespace-insensitive). When a
  // chat scope is set, the search is RESTRICTED to that chat — legacy
  // global rows (chat_id IS NULL) are no longer matched as a write
  // fallback, because doing so used to route every chat's extraction
  // into a single accumulating global row. (Concrete failure mode:
  // a "chr-foo" character row with chat_id IS NULL would absorb traits
  // from every subsequent chat's "Foo" character because the SELECT
  // matched it via the OR-IS-NULL clause and the UPDATE branch below
  // wrote into it instead of letting the INSERT path create a fresh
  // chat-scoped row.) Calls without a chatId still search globally so
  // CLI / system-context callers keep working against legacy rows.
  //
  // Tiebreak ordering is still load-bearing for the alias-cardinality
  // case described in the dedup notes above:
  //   1. name_match — a row whose NAME equals an incoming form ALWAYS
  //      beats a row that only has it in `aliases`.
  //   2. Larger alias set then longer name as cosmetic tiebreakers
  //      when multiple equally-strong matches remain.
  const scopeClause = chatId ? `chat_id = $1` : `chat_id IS NULL`;
  const { rows: existing } = await p.query(
    `SELECT id, chat_id,
            (lower(trim(name)) = ANY($2::text[])) AS name_match
       FROM characters
      WHERE ${scopeClause}
        AND (
          lower(trim(name)) = ANY($2::text[])
          OR EXISTS (
            SELECT 1
              FROM unnest(COALESCE(aliases, '{}'::text[])) a
             WHERE lower(trim(a)) = ANY($2::text[])
          )
        )
      ORDER BY (lower(trim(name)) = ANY($2::text[])) DESC,
               cardinality(COALESCE(aliases, '{}'::text[])) DESC,
               length(name) DESC
      LIMIT 1`,
    [chatId || null, normalizedForms],
  );

  if (existing.length > 0) {
    const row = existing[0];
    // Cross-character alias-pollution guard: BEFORE merging incoming
    // surface forms into the matched row's alias list, drop any form
    // whose lowercased value equals the primary NAME of a DIFFERENT
    // character row. Without this filter, when the LLM puts character
    // X's name under character Y's aliases (because Y's POV is full of
    // references to X), we'd union X's name into Y's row. That single
    // contamination then makes every future X extraction match Y's row
    // via the alias path — and even with the name_match priority above,
    // we'd still keep growing Y's polluted alias list every batch.
    // Drop those forms here so the row aliases stay surface forms of
    // THIS identity only.
    const otherNamesRes = await p.query(
      `SELECT DISTINCT lower(trim(name)) AS n FROM characters WHERE id <> $1`,
      [row.id],
    );
    const otherPrimaryNames = new Set(otherNamesRes.rows.map((r) => r.n).filter(Boolean));
    const cleanedForms = incomingForms.filter((f) => !otherPrimaryNames.has(f.trim().toLowerCase()));
    // Found a canonical row. Keep its name (don't try to overwrite),
    // just merge the (cleaned) surface forms into aliases so future
    // lookups hit this row. Description backfills only when empty so a
    // later thin extraction doesn't blank a rich one.
    await p.query(
      `UPDATE characters
          SET aliases = (
                SELECT COALESCE(array_agg(DISTINCT a), '{}'::text[])
                  FROM unnest(COALESCE(aliases, '{}'::text[]) || $2::text[]) a
                 WHERE a IS NOT NULL AND length(trim(a)) > 0
              ),
              description = COALESCE(NULLIF($3, ''), description),
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, cleanedForms, description || ""],
    );
    if (isPersona && chatId) {
      // Make sure the per-chat row is flagged as a persona, AND the
      // global persona row exists. Trait writes will mirror to that
      // global row via upsertTrait's personaName param.
      await p.query(
        `UPDATE characters SET is_persona = TRUE, updated_at = NOW() WHERE id = $1`,
        [row.id],
      );
      await ensurePersonaCharacter(settings, { name, aliases: cleanedForms, description: description || "" });
    }
    return row.id;
  }

  // No existing row matches any incoming surface form — create fresh.
  const id = chatId ? chatScopedId(name, chatId) : slugify(name);
  // The INSERT below ALWAYS writes is_persona=FALSE. The partial unique
  // index `characters_chat_name_uniq ON (chat_id, name) NULLS NOT DISTINCT
  // WHERE is_persona IS NOT TRUE` only covers non-persona rows, and the
  // ON CONFLICT inference targets that exact partial index — so we must
  // stay on the index's covered side here. If the caller asked for the
  // persona flag, we flip it via a follow-up UPDATE on the resolved id.
  // Doing it this way avoids a tricky three-way race: PK conflict (which
  // ON CONFLICT (chat_id, name) cannot catch), partial-index conflict,
  // and the partial-index exclusion that would otherwise let a duplicate
  // is_persona=TRUE row slip through on PK collision.
  await p.query(
    `INSERT INTO characters (id, name, chat_id, aliases, description, first_seen, is_persona)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE)
     ON CONFLICT (chat_id, name) WHERE is_persona IS NOT TRUE DO UPDATE SET
       aliases = (
         SELECT array_agg(DISTINCT a)
         FROM unnest(characters.aliases || EXCLUDED.aliases) a
       ),
       description = COALESCE(NULLIF(EXCLUDED.description, ''), characters.description),
       updated_at = NOW()`,
    [id, name, chatId || null, incomingForms, description || "", firstSeen || ""],
  );
  if (isPersona && chatId) {
    // Flip persona on the chat-scoped row, then ensure the global persona
    // pool row exists. The ensurePersonaCharacter call uses ON CONFLICT (id)
    // against the PK, so it's safe in the partial-index regime.
    await p.query(
      `UPDATE characters SET is_persona = TRUE, updated_at = NOW()
       WHERE chat_id = $1 AND name = $2`,
      [chatId, name],
    );
    await ensurePersonaCharacter(settings, { name, aliases: incomingForms, description: description || "" });
  }
  return id;
}

async function findCharacterByNameOrAlias(settings, name, chatId) {
  const p = getPool(settings);
  // Prefer the chat-scoped row; fall back to global. ORDER BY puts the
  // chat-scoped match first when both exist.
  const { rows } = await p.query(
    `SELECT id, name, aliases FROM characters
     WHERE (chat_id = $2 OR chat_id IS NULL)
       AND (name = $1::text OR $1 = ANY(aliases) OR id = $3 OR id = $4)
     ORDER BY (chat_id = $2) DESC NULLS LAST
     LIMIT 1`,
    [name, chatId || null, slugify(name), chatScopedId(name, chatId)],
  );
  return rows[0] || null;
}

async function resolveCharacterIdsForNames(settings, names, chatIds) {
  return resolveCharacterIds(getPool(settings), { names, chatIds });
}

async function upsertLocation(settings, name, description) {
  const p = getPool(settings);
  const id = "loc-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Conflict on id (deterministic). Different spellings/casings of the same
  // name slug to the same id, so the name unique constraint isn't enough.
  await p.query(
    `INSERT INTO locations (id, name, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       description = COALESCE(NULLIF(EXCLUDED.description, ''), locations.description)`,
    [id, name, description || ""],
  );
  return id;
}

// AGARS location adjacency: undirected per-chat edge between two locations
// that the source prose explicitly moved characters between. Idempotent by
// content id (lex-sorted (chat_id, a, b) hash) so (X,Y) and (Y,X) collapse
// to the same row. No-op when from === to after slug resolution (handles
// the LLM emitting two synonyms of the same room). Returns the edge id, or
// null if the transition was a self-loop.
async function upsertLocationAdjacency(settings, { chatId, fromName, toName, eventId }) {
  if (!fromName || !toName) return null;
  const fromId = await upsertLocation(settings, fromName, "");
  const toId = await upsertLocation(settings, toName, "");
  if (fromId === toId) return null;

  // Lex-sort the two endpoint ids BEFORE hashing so the content id is
  // direction-independent. The UNIQUE constraint on
  // (chat_id, location_a_id, location_b_id) is also keyed off the sorted
  // pair for the same reason.
  const [a, b] = fromId < toId ? [fromId, toId] : [toId, fromId];
  const safeChat = chatId || "";
  const id = contentId("locadj", `${safeChat}::${a}::${b}`);

  const p = getPool(settings);
  await p.query(
    `INSERT INTO location_adjacency (id, chat_id, location_a_id, location_b_id, first_seen_event_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chat_id, location_a_id, location_b_id) DO NOTHING`,
    [id, safeChat, a, b, eventId || null],
  );
  return id;
}

async function upsertRelationship(settings, { from, to, sentiment, intensity, description, sessionId }) {
  const p = getPool(settings);
  // Resolve via upsertCharacter so the per-chat-scoped ID is honored when
  // sessionId is the chat scope.
  const fromId = await upsertCharacter(settings, { name: from, chatId: sessionId });
  const toId = await upsertCharacter(settings, { name: to, chatId: sessionId });
  // Upsert keys on (from_char, to_char, session_id) so per-chat sentiment is preserved
  await p.query(
    `INSERT INTO feels_about (from_char, to_char, sentiment, intensity, description, session_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (from_char, to_char, session_id) DO UPDATE
     SET sentiment = $3, intensity = $4, description = $5, updated_at = NOW()`,
    [fromId, toId, sentiment || 0, intensity || 0.5, description || "", sessionId || ""],
  );
}

async function upsertEvent(settings, { summary, sourceText, participants, location, significance, messageIndex, sessionId, worldTime }) {
  const p = getPool(settings);
  const id = contentId("evt", `${summary}|${sessionId || ""}|${messageIndex || 0}`);

  let locationId = null;
  if (location) {
    locationId = await upsertLocation(settings, location, "");
  }

  // AGARS world_time: in-story time marker, free-form prose. Null is the
  // expected default for most events. Empty strings are normalized to NULL
  // here in JS so the update clause can use a bare COALESCE($8, ...) —
  // re-ingesting the same event without a time marker never clobbers a
  // previously-populated value.
  const wtArg = worldTime && String(worldTime).trim().length > 0 ? String(worldTime).trim() : null;

  await p.query(
    `INSERT INTO events (id, summary, source_text, significance, message_index, location_id, chat_id, timestamp, world_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
     ON CONFLICT (id) DO UPDATE SET
       summary = EXCLUDED.summary,
       source_text = COALESCE(NULLIF(EXCLUDED.source_text, ''), events.source_text),
       significance = EXCLUDED.significance,
       world_time = COALESCE($8, events.world_time)`,
    [id, summary, sourceText || "", significance || 3, messageIndex || 0, locationId, sessionId || "", wtArg],
  );

  for (const name of (participants || [])) {
    const charId = await upsertCharacter(settings, { name, chatId: sessionId });
    await p.query(
      `INSERT INTO participated_in (character_id, event_id, role)
       VALUES ($1, $2, 'participant')
       ON CONFLICT (character_id, event_id) DO NOTHING`,
      [charId, id],
    );
  }

  return id;
}

// Fact dedup threshold (pg_trgm similarity). Tuned a bit looser than
// TRAIT_SIMILARITY_THRESHOLD because fact sentences are longer than trait
// adjectives — pg_trgm scores drift down with length, so the same level
// of meaning-similarity reads as a smaller numeric value on whole
// sentences. 0.45 catches the LLM's typical batch-to-batch rewordings of
// the same fact (e.g. "X feels used by the group" / "X feels used by the
// group for their labor") without merging genuinely distinct facts.
const FACT_SIMILARITY_THRESHOLD = 0.45;

async function upsertFact(settings, { content, domain, confidence, characterScope, chatId }) {
  const p = getPool(settings);
  // Facts themselves stay globally-deduped (same content = same row) so
  // dedup still works. The chat scope lives on the knows edge instead —
  // "character X knows fact Y in chat Z" — so the same fact can be
  // known by different characters in different chats without bleeding
  // across scope.
  const cleaned = (content || "").toString().trim();
  if (!cleaned) return null;
  const dom = domain || "other";

  // Fuzzy pre-check: catch near-duplicates the content-addressed id can't.
  // The id is `contentId("fact", "${content}|${domain}")` so any rewording
  // (e.g. "X feels used by the group" vs "X feels used by the group for
  // their labor") spawns a fresh fact row and a fresh knows edge for
  // every scope character. Mirror the upsertTrait pattern: look for an
  // existing fact in the same domain that ANY of the characterScope
  // already knows in this chat (or globally if chatId is null), with
  // pg_trgm similarity above FACT_SIMILARITY_THRESHOLD. If found, reuse
  // its id and route the new knows edges there. Substring containment is
  // also accepted (e.g. "X is at the meeting" inside "X is at the
  // meeting at the council hall") — keep the longer wording as the
  // canonical content.
  let id;
  if (Array.isArray(characterScope) && characterScope.length > 0) {
    const scopeCharIds = [];
    for (const charName of characterScope) {
      if (!charName) continue;
      try {
        scopeCharIds.push(await upsertCharacter(settings, { name: charName, chatId }));
      } catch (err) {
        // Character upsert failure shouldn't block fact dedup; just skip
        // this scope entry for the lookup. We'll re-resolve in the knows
        // insert loop below.
      }
    }
    if (scopeCharIds.length > 0) {
      const { rows: similar } = await p.query(
        `SELECT f.id, f.content, length(f.content) AS len,
                similarity(lower(f.content), lower($1::text)) AS sim
           FROM facts f
          WHERE f.domain = $2
            AND EXISTS (
              SELECT 1 FROM knows k
               WHERE k.fact_id = f.id
                 AND k.character_id = ANY($3::text[])
                 AND ( $4::text IS NULL OR k.chat_id = $4 OR k.chat_id IS NULL )
            )
            AND (
              lower(f.content) = lower($1)
              OR position(lower($1) in lower(f.content)) > 0
              OR position(lower(f.content) in lower($1)) > 0
              OR similarity(lower(f.content), lower($1)) > $5
            )
          ORDER BY len DESC, sim DESC
          LIMIT 1`,
        [cleaned, dom, scopeCharIds, chatId || null, FACT_SIMILARITY_THRESHOLD],
      );
      if (similar.length > 0) {
        const match = similar[0];
        id = match.id;
        // If the new wording is longer/more specific, promote it to the
        // canonical content. The id stays — it's content-addressed off
        // the original content, but we never look the id up by hashing
        // again, so a wording rewrite is safe.
        if (cleaned.length > match.len) {
          await p.query(
            `UPDATE facts SET content = $1 WHERE id = $2`,
            [cleaned, match.id],
          ).catch(() => {});
        }
      }
    }
  }

  if (!id) {
    id = contentId("fact", `${cleaned}|${dom}`);
    await p.query(
      `INSERT INTO facts (id, content, domain, confidence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, cleaned, dom, confidence || 0.8],
    );
  }

  for (const charName of (characterScope || [])) {
    const charId = await upsertCharacter(settings, { name: charName, chatId });
    // H3: chat_id is now part of the uniqueness key via
    // knows_char_fact_chat_uniq, so identity is per-chat and we can
    // simply DO NOTHING on conflict. The old (character_id, fact_id)
    // key with a COALESCE-preserving UPDATE clobbered multi-chat rows
    // into a single row holding only the first chat_id.
    await p.query(
      `INSERT INTO knows (character_id, fact_id, source, chat_id)
       VALUES ($1, $2, 'discovered', $3)
       ON CONFLICT ON CONSTRAINT knows_char_fact_chat_uniq DO NOTHING`,
      [charId, id, chatId || null],
    );
  }

  return id;
}

// Normalize a world_state key emitted by the LLM into a stable canonical
// form before insert/supersession. Two keys that differ only in casing,
// whitespace-vs-underscore, possessive apostrophe, or trailing " status"
// / " state" suffix MUST map to the same canonical key — otherwise they
// coexist forever as parallel "current" rows and the rendered memory
// block shows the same fact twice ("Piper the Black" + "Piper the Black
// status", "cargo_content" + "cargo content"). The transformation is
// intentionally stable across calls so a row written under one casing
// can be superseded by a later batch that re-emits in another casing.
//
// We do NOT collapse synonyms (e.g. cargo_content vs cargo_nature) —
// that's the LLM's job, surfaced via the "Current world state" hint
// list in the extractor prompt so it reuses keys verbatim.
function normalizeWorldStateKey(key) {
  let k = String(key || "").trim().toLowerCase();
  // Strip possessive apostrophes ("alice's status" -> "alices status").
  k = k.replace(/['’]s\b/g, "s");
  // Drop other apostrophes and stray punctuation that the LLM sometimes
  // sprinkles in.
  k = k.replace(/[^\w\s_-]/g, "");
  // Collapse runs of whitespace and dashes into a single underscore.
  k = k.replace(/[\s\-]+/g, "_");
  // Strip a trailing _status / _state qualifier so "X status" and "X"
  // collapse onto one row (the canonical key keeps the noun, drops the
  // qualifier). Examples: "piper_the_black_status" -> "piper_the_black",
  // "ship_state" -> "ship", "cargo_status" -> "cargo".
  k = k.replace(/_(status|state)$/g, "");
  // Collapse multiple underscores left over from the above.
  k = k.replace(/_+/g, "_");
  // Trim stray leading/trailing underscores.
  k = k.replace(/^_+|_+$/g, "");
  return k;
}

async function upsertWorldState(settings, { key, value, reason, chatId, sourceMessageIndex }) {
  if (!key || typeof key !== "string" || !key.trim()) return;
  if (value === undefined || value === null) return;
  const p = getPool(settings);
  const k = normalizeWorldStateKey(key);
  if (!k) return;
  // Scope supersession to this chat so two chats tracking the same key
  // don't kick each other's state into valid_until. NULL-chat legacy rows
  // remain queryable as global fallback via getWorldState.
  if (chatId) {
    await p.query(
      `UPDATE world_state SET valid_until = NOW()
       WHERE key = $1 AND valid_until IS NULL AND chat_id = $2`,
      [k, chatId],
    );
  } else {
    await p.query(
      `UPDATE world_state SET valid_until = NOW()
       WHERE key = $1 AND valid_until IS NULL AND chat_id IS NULL`,
      [k],
    );
  }
  await p.query(
    `INSERT INTO world_state (key, value, reason, chat_id, source_message_index)
     VALUES ($1, $2, $3, $4, $5)`,
    [k, String(value), reason || "", chatId || null, sourceMessageIndex ?? null],
  );
}

// Close (set valid_until = NOW()) any "current" world_state rows whose
// keys match the supplied list — used to honor world_state_supersede
// from the extractor when it reports facts that have stopped being true.
// Keys are normalized through normalizeWorldStateKey so the LLM can pass
// either the canonical form or the surface form it last saw.
async function supersedeWorldStateKeys(settings, { keys, chatId }) {
  if (!Array.isArray(keys) || keys.length === 0) return 0;
  const normalized = Array.from(new Set(
    keys.map(normalizeWorldStateKey).filter(Boolean),
  ));
  if (normalized.length === 0) return 0;
  const p = getPool(settings);
  if (chatId) {
    const res = await p.query(
      `UPDATE world_state SET valid_until = NOW()
       WHERE key = ANY($1::text[]) AND valid_until IS NULL AND chat_id = $2`,
      [normalized, chatId],
    );
    return res.rowCount || 0;
  }
  const res = await p.query(
    `UPDATE world_state SET valid_until = NOW()
     WHERE key = ANY($1::text[]) AND valid_until IS NULL AND chat_id IS NULL`,
    [normalized],
  );
  return res.rowCount || 0;
}

// TTL sweep for snapshot-shaped world_state rows. Keys whose canonical
// form is, starts with, OR ends with one of these tokens describe
// MOMENT-IN-TIME scene state (boarding, ship motion, weather, current
// chase, the alarm being raised) — they are not standing facts. If the
// extractor stops re-emitting them for a while, that's the signal they're
// no longer the current state and should be closed even if the LLM never
// explicitly emits a supersede.
//
// Standing facts (character roles, faction, established relationships,
// learned secrets, political tension at a place) do NOT match these
// tokens and are left alone — they can stay current indefinitely until
// the extractor explicitly changes or supersedes them.
//
// Suffix matching matters because the extractor frequently emits
// scene-anchored keys like `kingdom_pursuit` or `palace_alarm` where the
// snapshot-shape is the last word, not the first. Without suffix
// matching these stayed "current" forever after the scene moved on.
const SNAPSHOT_KEY_TOKENS = [
  "boarding", "weather", "ship", "cargo", "scene",
  "current_location", "battle", "pursuit", "alarm",
  "chase", "attack", "confrontation", "escape",
];
function isSnapshotKey(key) {
  const k = normalizeWorldStateKey(key);
  return SNAPSHOT_KEY_TOKENS.some(
    (p) => k === p || k.startsWith(p + "_") || k.endsWith("_" + p),
  );
}

async function closeStaleSnapshotKeys(settings, { chatId, currentMessageIndex, ttlMessages = 12 }) {
  if (!chatId || currentMessageIndex == null) return 0;
  const p = getPool(settings);
  // Two-stage: pull candidates, filter by snapshot-prefix in JS so the
  // SQL stays portable (no regex engine assumed). Most chats have only
  // a few dozen "current" world_state rows so the candidate set is small.
  const { rows: candidates } = await p.query(
    `SELECT id, key, source_message_index
       FROM world_state
      WHERE chat_id = $1
        AND valid_until IS NULL
        AND source_message_index IS NOT NULL
        AND $2::int - source_message_index > $3::int`,
    [chatId, currentMessageIndex, ttlMessages],
  );
  const stale = candidates.filter((row) => isSnapshotKey(row.key)).map((row) => row.id);
  if (stale.length === 0) return 0;
  const res = await p.query(
    `UPDATE world_state SET valid_until = NOW() WHERE id = ANY($1::int[])`,
    [stale],
  );
  return res.rowCount || 0;
}

// ── Character traits ───────────────────────────────────────────

// Threshold tuned against representative trait pairs. Above this, we
// consider two traits near-duplicates. Lower = more aggressive merging.
const TRAIT_SIMILARITY_THRESHOLD = 0.55;

// Emotional states / transient moods / momentary reactions that the LLM
// tends to emit as "personality traits" when the character is feeling them
// in a single scene. These are never dispositional, so we reject them
// from `category = 'personality'` at write time.
//
// The check is against the English-stemmed form of the content (to collapse
// adoring/adored/adoration → 'ador', amused/amusement → 'amus', etc), so
// listing the base form is enough to catch the variants. Multi-word traits
// that contain a state word are still allowed ("calmly analytical" still
// contains "analytic" stem so it'd pass — we only reject when the ENTIRE
// content stems to just one of these words).
const TRAIT_STATE_STEMS = new Set([
  "ador", "amus", "angri", "annoy", "anxious", "appreci", "anticipatori",
  "arous", "asham", "astonish", "astound", "awe", "awestruck", "baffl",
  "bemus", "besot", "bewilder", "captiv", "charm", "confus",
  "content", "curious", "delight", "depress", "desir", "disgust", "distress",
  "eager", "elat", "embarrass", "enamor", "enrag", "enthrall", "excit",
  "exhaust", "fascin", "fear", "flush", "frustrat", "furious", "gleeful",
  "grate", "griev", "guilti", "happi", "horrifi", "humili", "impress",
  "infatu", "intimid", "irrit", "joyful", "lonely", "lust", "melancholi",
  "mesmer", "miser", "mournful", "nervou", "offend", "overwhelm", "pleas",
  "puzzl", "relax", "reliev", "remors", "resent", "sad", "scare", "shock",
  "smitten", "sorrow", "stun", "surpris", "terrifi", "thankful", "thrill",
  "touch", "uncomfort", "uneasi", "upset", "weari", "worri", "wound",
  "aghast", "mortifi", "appal", "dismay",
  // Additional state words / narrative mood phrases flagged after the
  // first cleanup pass surfaced remaining noise:
  "concern", "desper", "disarm", "disappoint", "devast", "defeat",
  "hesit", "hurt", "humbl", "indifferent", "insecur", "jealous",
  "lose", "miss", "outrag", "overjoy", "panick", "perturb", "rattl",
  "reassur", "reluctant", "repuls", "resign", "satisfi", "skeptic",
  "startl", "stress", "troubl", "tumultu", "unfazed", "unsettl",
  "unsur", "vulnerab", "wistful", "dread",
]);

function approxStem(word) {
  // Approximate the Snowball English stem by stripping common suffixes.
  // Good enough to catch the obvious offenders; TRAIT_STATE_STEMS is
  // keyed on the same approximation.
  return word
    .replace(/ies$/, "i")
    .replace(/sses$/, "ss")
    .replace(/ied$/, "i")
    .replace(/(ing|ed|ly|ness|ion|ions|ful|er|est|s)$/, "");
}

// Common English fillers we drop before inspecting trait content, so that
// "was angry" is treated the same as "angry" and "appreciative of genuine
// interaction" collapses to words where "appreciative" is the first
// meaningful token.
const TRAIT_FILLER_WORDS = new Set([
  "was", "is", "am", "are", "be", "been", "being",
  "feels", "feel", "felt", "seems", "seem", "appeared", "appears",
  "very", "somewhat", "quite", "rather", "a", "an", "the", "of", "at",
  "to", "for", "with", "by", "in", "on", "but", "and", "or", "from",
]);

function meaningfulWords(content) {
  return String(content || "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !TRAIT_FILLER_WORDS.has(w));
}

function isTransientEmotionStem(content) {
  if (!content) return false;
  const meaningful = meaningfulWords(content);
  if (meaningful.length === 0) return false;
  // Single-word case: reject if the stem matches.
  if (meaningful.length === 1) {
    const stem = approxStem(meaningful[0]);
    return TRAIT_STATE_STEMS.has(stem) || TRAIT_STATE_STEMS.has(meaningful[0]);
  }
  // Short phrase case (≤4 meaningful words): reject if it STARTS with a
  // state stem. "annoyed at staff", "awe struck", "appreciative of
  // genuine interaction" all land here. Longer phrases (5+ words) likely
  // carry enough narrative context to be more than a mood, let them through.
  if (meaningful.length > 4) return false;
  const firstStem = approxStem(meaningful[0]);
  return TRAIT_STATE_STEMS.has(firstStem) || TRAIT_STATE_STEMS.has(meaningful[0]);
}

// Arousal threshold used by `classifyDisposition` when deciding whether a
// NRC-emotion-tagged word should be auto-rejected vs queued for verification.
// NRC-VAD publishes arousal scores on a normalized [0, 1] axis. We set the
// cutoff at 0.55 — calibrated against the Path 2 spec ("arousal > 0.6") and
// the audit-reject list in RESEARCH_TRAITS.md. 0.55 is just below the
// "intense affect reaction" band where words like excited (~0.85), aroused
// (~0.85), terrified (~0.93), enamored/captivated/adoring (~0.55-0.62),
// frustrated/embarrassed/fascinated (~0.55-0.62), horrified (~0.88) sit.
// Everything below 0.55 and no Goldberg hit falls into 'verify', where
// Path 1's canonical-row dedup system makes the final call.
//
// Exact threshold uses a strict `>=` on purpose so that mid-arousal words
// sitting at the boundary (awed=0.55, confused=0.55, puzzled=0.55,
// grieving=0.55, upset=0.55) land on 'reject' rather than 'verify'.
const TRAIT_AROUSAL_REJECT_THRESHOLD = 0.55;

/**
 * Lexicon-first disposition classifier (Path 2 from RESEARCH_TRAITS.md §5).
 *
 * Runs BEFORE any embedding or LLM call in upsertTrait. Removes ~70% of
 * transient-emotion noise with zero network calls by matching candidates
 * against:
 *   - GOLDBERG_100: known persistent personality adjectives (auto-accept)
 *   - NRC_EMOTION + NRC_VAD arousal: known transient affect words
 *
 * @param {string} candidate trait content text (may be multi-word)
 * @param {string} category trait category (only 'personality' is gated here)
 * @returns {'accept' | 'reject' | 'verify'}
 */
function classifyDisposition(candidate, category) {
  // Skills / background / physical / faction pass through unchanged — a
  // faction name or a physical attribute that happens to contain an emotion
  // word shouldn't be rejected.
  if ((category || "personality") !== "personality") return "verify";

  const meaningful = meaningfulWords(candidate);
  if (meaningful.length === 0) return "verify";

  // Path 2 is designed for single-word candidates ("stoic", "aroused").
  // For multi-word candidates we still classify on the first meaningful word
  // as a best-effort — the caller's existing short-phrase gate (in
  // isTransientEmotionStem) supplements this for ≤4-word phrases.
  const first = meaningful[0];
  const stem = approxStem(first);

  // Step 1: Goldberg whitelist. If either the raw word or its approx stem
  // is in GOLDBERG_100, auto-accept. This path also wins over any NRC hit
  // so words like "calculating"/"dominant"/"charming" which live in both
  // lexicons resolve to accept.
  if (GOLDBERG_100.has(first) || GOLDBERG_100.has(stem)) {
    return "accept";
  }

  // Step 2: NRC emotion gate. If the candidate is in NRC but not in
  // Goldberg, it is probably a transient affect state. Refine the decision
  // using NRC-VAD arousal when available.
  const inNrc = NRC_EMOTION.has(first) || NRC_EMOTION.has(stem);
  if (inNrc) {
    const vadEntry = NRC_VAD.get(first) || NRC_VAD.get(stem);
    if (vadEntry && typeof vadEntry.arousal === "number") {
      // Moderate-to-high arousal = temporary state. Reject outright.
      if (vadEntry.arousal >= TRAIT_AROUSAL_REJECT_THRESHOLD) return "reject";
      // Low-arousal emotion words: unusual for a state word to be low-
      // arousal, but if it is (e.g. "weary" at ~0.32, "bored" at ~0.22,
      // "satisfied" at ~0.38), defer to the verifier.
      return "verify";
    }
    // NRC hit with no VAD coverage. Default to reject — NRC-tagged words
    // are overwhelmingly affect states, and Path 1's canonical dedup won't
    // have a chance to salvage them anyway at this stage.
    return "reject";
  }

  // Step 3: Unknown to both lexicons. Per the Path 2 spec, err on the side
  // of keeping the candidate and let downstream verification (Path 1 /
  // Path 3) decide.
  return "verify";
}

// Cosine thresholds for Path 1's canonical-row dedup pipeline. See
// RESEARCH_TRAITS.md §5 Path 1 for the calibration rationale. Top-hit
// cosine ≥ MERGE_THRESHOLD means "same trait, merge onto canonical";
// VERIFY_THRESHOLD–MERGE_THRESHOLD is the band where Path 3's LLM
// verifier would be invoked once it exists; below VERIFY_THRESHOLD is a
// new canonical row.
const TRAIT_MERGE_COSINE = 0.82;
const TRAIT_VERIFY_COSINE = 0.72;

// Process-local cache for Path 3 verifier decisions. Key is
// `${canonical_id}::${normalized_candidate}`. Cleared on restart.
//
// M13: bounded by TRAIT_VERIFY_CACHE_MAX so a long-running process
// ingesting many chats can't grow the Map without bound. On write,
// if the Map is at capacity we drop the oldest entry (Map preserves
// insertion order).
const TRAIT_VERIFY_CACHE_MAX = 1000;
const traitVerifyCache = new Map();
function setTraitVerifyCache(key, val) {
  setWithBoundedEviction(traitVerifyCache, key, val, TRAIT_VERIFY_CACHE_MAX, {
    // Preserve legacy semantics: this cache historically evicted even when
    // writing an existing key at capacity.
    evictOnUpdateAtCapacity: true,
  });
}

// C11: per-(character, category) cache of existing canonical traits, used to
// short-circuit the fuzzy pre-check SQL on the substring-match case. The
// extractor batches dozens of upsertTrait calls per character; without this
// cache each one issues its own SELECT against traits. TTL is short (5s)
// because writes within the same batch invalidate the snapshot.
const TRAIT_LIST_CACHE_TTL_MS = 5000;
const traitListCache = new Map(); // key: `${characterId}::${category}` -> { rows, expires }

function getCachedTraitList(key) {
  const entry = traitListCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    traitListCache.delete(key);
    return null;
  }
  return entry.rows;
}

function setCachedTraitList(key, rows) {
  traitListCache.set(key, { rows, expires: Date.now() + TRAIT_LIST_CACHE_TTL_MS });
}

function invalidateTraitListCache(characterId) {
  for (const k of traitListCache.keys()) {
    if (k.startsWith(`${characterId}::`)) traitListCache.delete(k);
  }
}

async function upsertTrait(
  settings,
  { characterId, characterName, characterAliases, siblingNames, category, content, evidenceSentence, sourceChat, sourceMessageIndex },
) {
  const p = getPool(settings);
  if (!content || !String(content).trim()) return null;
  const cleaned = String(content).trim();
  const cat = category || "personality";
  const evidence = (evidenceSentence || "").toString().trim();

  // Reject obvious transient emotional states before they land as
  // "personality traits". The prompt tells the LLM not to emit these but
  // it does anyway on long ingests; this is the write-side safety net.
  // Only applies to the `personality` category — a skill, background, or
  // physical entry that happens to contain an emotion word is fine.
  //
  // Two-layer gate:
  //   (1) Lexicon-first classifier (Path 2): GOLDBERG_100 whitelist +
  //       NRC_EMOTION / NRC_VAD blocklist. Runs BEFORE embedding/LLM cost.
  //   (2) TRAIT_STATE_STEMS + multi-word phrase rule. Kept as a safety net
  //       behind the lexicon path so we don't regress coverage while we
  //       tune the lexicons; the hardcoded set supersedes it long term.
  if (cat === "personality") {
    const disposition = classifyDisposition(cleaned, cat);
    if (disposition === "reject") return null;
    if (isTransientEmotionStem(cleaned)) return null;
  }

  // Attribution guard: catch the painter/voyeur leak case where the LLM
  // attaches a `skill` / `background` / `physical` trait to the wrong
  // character because the evidence sentence is from another character's
  // POV. If the evidence sentence proper-noun-mentions a SIBLING
  // (another character in the same batch) and does NOT mention this
  // character (by name or any alias), drop the trait. Personality is
  // exempt because dispositional evidence ("She did not flinch...") often
  // contains no proper noun and would be killed by this check. The guard
  // is intentionally conservative: pronoun-only sentences and sentences
  // that mention both self and a sibling pass through.
  if (
    evidence &&
    (cat === "skill" || cat === "background" || cat === "physical") &&
    Array.isArray(siblingNames) && siblingNames.length > 0
  ) {
    const selfNameList = [];
    if (characterName && typeof characterName === "string") selfNameList.push(characterName);
    for (const a of (Array.isArray(characterAliases) ? characterAliases : [])) {
      if (typeof a === "string" && a.trim()) selfNameList.push(a.trim());
    }
    const mentions = (haystack, needle) => {
      const n = (needle || "").trim();
      if (n.length < 2) return false;
      const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      return re.test(haystack);
    };
    const evidenceMentionsSelf = selfNameList.some((n) => mentions(evidence, n));
    const evidenceMentionsSibling = siblingNames.some((n) => mentions(evidence, n));
    if (evidenceMentionsSibling && !evidenceMentionsSelf) {
      console.warn(
        `[ChronicleDB] trait attribution guard: dropping ${cat} "${cleaned}" for "${characterName}" — evidence sentence names a sibling character but not this one. evidence="${evidence}"`,
      );
      return null;
    }
  }

  // Fuzzy pre-check: catch duplicates the exact-normalized unique index
  // can't see. A trait is considered a dupe of an existing one if ANY of:
  //   - `stemmed_content` matches (English stemmer collapses
  //     charmed/charming/charms to 'charm', observant/observing to 'observ',
  //     etc — this is the layer that catches morphological variants)
  //   - one content is a case-insensitive substring of the other
  //     (catches "Former prisoner" / "Former prisoner (Setting...)")
  //   - pg_trgm similarity > TRAIT_SIMILARITY_THRESHOLD
  //     (catches reordered/rephrased variants like "Manager of the Grand"
  //     / "Former manager of the Grand")
  // When a match is found, keep whichever content is longer (more specific
  // wording wins). No UPDATE — just return the winner's id.
  //
  // The fuzzy pre-check only considers canonical rows (canonical_id IS
  // NULL) — merged variants would otherwise re-match their own alias
  // content and block the Path 1 embedding pipeline from being reached.
  //
  // C11 fast path: try the cheap substring-match in JS against a cached
  // snapshot of the character's canonical traits before issuing SQL. The
  // SQL stays the source of truth — we still run it on cache miss or when
  // the JS check returns no substring hit, because stemmer / pg_trgm
  // matches can't be replicated outside Postgres.
  //
  // Chat scoping: candidate traits are restricted to the same source_chat
  // as the new emission (or NULL-source legacy rows that aren't tied to
  // any chat). Without this scope a character with traits across multiple
  // unrelated stories would let the dedup pull cross-chat candidates —
  // e.g. emitting "devoted" in one chat would find "loyal to <faction
  // from another chat>" on the same character row and the verifier would
  // propose a meaning-preserving MERGE that destroys the per-chat story
  // context. Each chat is its own setting; trait identity is
  // per-(character, chat).
  const chatScopeArg = sourceChat || "";
  const traitListKey = `${characterId}::${cat}::${chatScopeArg}`;
  let cachedList = getCachedTraitList(traitListKey);
  if (!cachedList) {
    const { rows: all } = await p.query(
      `SELECT id, content, length(content) AS len
         FROM traits
        WHERE character_id = $1 AND category = $2 AND canonical_id IS NULL
          AND ( source_chat = $3 OR source_chat IS NULL OR source_chat = '' )`,
      [characterId, cat, chatScopeArg],
    );
    cachedList = all;
    setCachedTraitList(traitListKey, all);
  }
  const cleanedLower = cleaned.toLowerCase();
  let jsSubstringHit = null;
  for (const row of cachedList) {
    const rowLower = String(row.content || "").toLowerCase();
    if (!rowLower) continue;
    if (rowLower.includes(cleanedLower) || cleanedLower.includes(rowLower)) {
      if (!jsSubstringHit || row.len > jsSubstringHit.len) jsSubstringHit = row;
    }
  }
  let similar;
  if (jsSubstringHit) {
    similar = [jsSubstringHit];
  } else {
    const res = await p.query(
      `SELECT id, content, length(content) AS len,
              similarity(lower(content), lower($3::text)) AS sim
       FROM traits
       WHERE character_id = $1 AND category = $2 AND canonical_id IS NULL
         AND ( source_chat = $5 OR source_chat IS NULL OR source_chat = '' )
         AND (
           stemmed_content = strip(to_tsvector('english', $3))::text
           OR similarity(lower(content), lower($3)) > $4
         )
       ORDER BY len DESC, sim DESC
       LIMIT 1`,
      [characterId, cat, cleaned, TRAIT_SIMILARITY_THRESHOLD, chatScopeArg],
    );
    similar = res.rows;
  }
  if (similar.length > 0) {
    const match = similar[0];
    if (match.len >= cleaned.length) return match.id;
    // New trait is longer/more specific. Rewrite the existing row's
    // content so the longer version becomes canonical. The generated
    // normalized_content column updates with it via STORED regeneration.
    try {
      await p.query(
        `UPDATE traits SET content = $1 WHERE id = $2`,
        [cleaned, match.id],
      );
      invalidateTraitListCache(characterId);
    } catch (err) {
      // Rewrite could violate the unique normalized index if two distinct
      // groups collapse into one. Ignore and keep the existing row; the
      // cleanup script handles the rest.
    }
    return match.id;
  }

  // ── Path 1: contextual embedding → kNN → canonical-row dedup ──
  //
  // Build the contextual embedding text (Anthropic contextual-retrieval
  // pattern). The evidence sentence is what makes "stoic" / "unflappable"
  // / "keeps composure under pressure" land in the same neighborhood.
  // Fall back to the bare `${name} is ${content}` form when evidence is
  // missing (legacy callers, legacy prompts).
  const name = (characterName || "").toString().trim() || characterId;
  const embedText = evidence
    ? `${name} is ${cleaned}: ${evidence}`
    : `${name} is ${cleaned}`;

  let embedding = null;
  try {
    // Lazy require to avoid the db ↔ extractor circular import.
    const extractor = require("./extractor");
    embedding = await extractor.embed(settings, embedText);
  } catch (err) {
    console.warn(`[ChronicleDB] trait embed failed (${err.message}); inserting without embedding`);
    embedding = null;
  }

  // kNN against existing canonical traits for the same character and
  // category. We restrict the search to canonical_id IS NULL both so the
  // partial HNSW index (idx_traits_embedding_hnsw) is used, and so merged
  // variants never get returned and re-merged onto themselves.
  let topHit = null;
  if (embedding) {
    try {
      const { rows: neighbors } = await p.query(
        `SELECT id, content, 1 - (embedding <=> $1::vector) AS cos
         FROM traits
         WHERE character_id = $2 AND category = $3
           AND canonical_id IS NULL
           AND embedding IS NOT NULL
           AND ( source_chat = $4 OR source_chat IS NULL OR source_chat = '' )
         ORDER BY embedding <=> $1::vector
         LIMIT 3`,
        [JSON.stringify(embedding), characterId, cat, chatScopeArg],
      );
      if (neighbors.length > 0) topHit = neighbors[0];
    } catch (err) {
      console.warn(`[ChronicleDB] trait kNN failed (${err.message}); falling through to canonical insert`);
      topHit = null;
    }
  }

  // Build the alias string we'd stash on the canonical row if we merge.
  // Keep the evidence alongside the content so retrieval can do full-
  // text fallback on the merged variants without a second table.
  const aliasEntry = evidence ? `${cleaned}: ${evidence}` : cleaned;

  // Shared merge path used by both the ≥0.88 branch and Path 3's MERGE
  // verdict. Appends aliasEntry to topHit.aliases, bumps merged_count,
  // inserts this candidate as a merged variant pointing at topHit, and
  // refreshes the per-character summary rollup. Returns topHit.id.
  async function mergeCandidateOntoCanonical() {
    try {
      await p.query(
        `UPDATE traits
         SET aliases = array_append(COALESCE(aliases, '{}'::text[]), $2),
             merged_count = COALESCE(merged_count, 1) + 1
         WHERE id = $1`,
        [topHit.id, aliasEntry],
      );
    } catch (err) {
      console.warn(`[ChronicleDB] trait merge UPDATE failed (${err.message})`);
    }
    // Merge candidate ID is content-addressed by (character, category, raw
    // content, source_chat, source_message_index) so re-running the same
    // extraction batch is idempotent. Category MUST be in the key for the
    // same reason as the canonical id — otherwise the same content under
    // two categories collides on the primary key.
    const msgIdxParam = Number.isFinite(sourceMessageIndex) ? sourceMessageIndex : null;
    const mergedId = contentId(
      "trait",
      `cand:${characterId}:${cat}:${cleaned}:${sourceChat || ""}:${msgIdxParam ?? ""}`,
    );
    try {
      await p.query(
        `INSERT INTO traits (id, character_id, category, content, source_chat, source_message_index, embedding, evidence_sentence, canonical_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9)
         ON CONFLICT (character_id, category, normalized_content) DO NOTHING`,
        [
          mergedId,
          characterId,
          cat,
          cleaned,
          sourceChat || "",
          msgIdxParam,
          embedding ? JSON.stringify(embedding) : null,
          evidence || null,
          topHit.id,
        ],
      );
    } catch (err) {
      // A normalized-index conflict means an identical row already
      // exists — nothing to do.
    }
    invalidateTraitListCache(characterId);
    try {
      await recomputeCharacterSummary(settings, characterId);
    } catch (err) {
      console.warn(`[ChronicleDB] recomputeCharacterSummary failed after merge: ${err.message}`);
    }
    return topHit.id;
  }

  if (topHit && typeof topHit.cos === "number" && topHit.cos >= TRAIT_MERGE_COSINE) {
    // MERGE: ≥0.88 cosine against an existing canonical — collapse.
    return await mergeCandidateOntoCanonical();
  }

  if (
    topHit &&
    typeof topHit.cos === "number" &&
    topHit.cos >= TRAIT_VERIFY_COSINE &&
    topHit.cos < TRAIT_MERGE_COSINE
  ) {
    // Path 3: 0.80-0.88 is the ambiguous band. Ask a tiny LLM verifier
    // to decide MERGE / KEEP_DISTINCT / REJECT_NEW. Process-local cache
    // on (canonical_id, normalized_cleaned) avoids re-verifying the
    // same pair within a long ingest. Any error or unexpected response
    // falls through to NEW_CANONICAL — we never drop a trait because
    // the verifier failed.
    const cacheKey = `${topHit.id}::${cleaned.toLowerCase()}`;
    let decision = traitVerifyCache.get(cacheKey);

    if (!decision) {
      try {
        const extractor = require("./extractor");
        decision = await extractor.verifyTraitPair(settings, {
          characterName: name,
          category: cat,
          candidateContent: cleaned,
          candidateEvidence: evidence,
          existingContent: topHit.content,
          existingEvidence: "",
          cosine: topHit.cos,
        });
        setTraitVerifyCache(cacheKey, decision);
      } catch (err) {
        // Defensive: on verifier error, treat the candidate as a duplicate
        // of the top kNN hit rather than minting a new canonical row. The
        // candidate sits in the 0.80-0.88 ambiguous band — we already
        // believe it's probably the same trait, and a phantom canonical
        // would fragment the dedup pipeline. False-merge is recoverable
        // (split via admin tool); a phantom canonical pollutes kNN forever.
        console.warn(`[ChronicleDB] trait verifier failed (${err.message}); defaulting to MERGE onto top kNN hit`);
        decision = "MERGE";
      }
    }

    console.info(
      `[ChronicleDB] trait verify: "${cleaned}" vs "${topHit.content}" cos=${topHit.cos.toFixed(4)} -> ${decision}`,
    );

    // Mark the canonical as verified regardless of outcome — the pair
    // has been evaluated. verified_at is an observability / staleness
    // signal, not a correctness gate.
    try {
      await p.query(`UPDATE traits SET verified_at = NOW() WHERE id = $1`, [topHit.id]);
    } catch (_) {
      // verified_at update is best-effort; never fail the trait insert.
    }

    if (decision === "MERGE") {
      return await mergeCandidateOntoCanonical();
    }
    if (decision === "REJECT_NEW") {
      // Drop the candidate entirely. No insert, no alias, no row.
      return topHit.id;
    }
    // KEEP_DISTINCT (or any error fallback): fall through to NEW_CANONICAL.
  }

  // NEW_CANONICAL: insert as a fresh canonical row, embedding populated
  // if we have one, canonical_id = NULL. ID is content-addressed by
  // (character, category, normalized content) so re-ingesting the same
  // trait always collides with the existing row's id and the ON CONFLICT
  // clause becomes a true upsert. Category MUST be in the key — the same
  // normalized content can legitimately appear in two categories
  // ("brave" as personality AND as skill) and they'd otherwise hash to
  // the same id, causing a primary-key violation that ON CONFLICT
  // (char, cat, norm) doesn't catch (different category, no conflict on
  // the named target).
  const normalizedKey = cleaned.toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = contentId("trait", `${characterId}:${cat}:${normalizedKey}`);
  const newCanonMsgIdx = Number.isFinite(sourceMessageIndex) ? sourceMessageIndex : null;
  const { rows: inserted } = await p.query(
    `INSERT INTO traits (id, character_id, category, content, source_chat, source_message_index, embedding, evidence_sentence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)
     ON CONFLICT (character_id, category, normalized_content) DO NOTHING
     RETURNING id`,
    [
      id,
      characterId,
      cat,
      cleaned,
      sourceChat || "",
      newCanonMsgIdx,
      embedding ? JSON.stringify(embedding) : null,
      evidence || null,
    ],
  );
  let finalId;
  if (inserted.length > 0) {
    finalId = inserted[0].id;
    invalidateTraitListCache(characterId);
  } else {
    const { rows: existing } = await p.query(
      `SELECT id FROM traits
       WHERE character_id = $1 AND category = $2
         AND normalized_content = regexp_replace(lower($3::text), '[^a-z0-9]', '', 'g')
       LIMIT 1`,
      [characterId, cat, cleaned],
    );
    finalId = existing[0]?.id ?? null;
  }

  // Keep the per-character rollup fresh. Failure here must not fail the
  // trait insert — the rollup is recoverable via /recompute-character-
  // summaries. Only bother calling it when we actually produced an
  // embedding; the function is a no-op against rows with NULL embedding
  // but the extra query is pointless in that case.
  if (finalId && embedding) {
    try {
      await recomputeCharacterSummary(settings, characterId);
    } catch (err) {
      console.warn(`[ChronicleDB] recomputeCharacterSummary failed after new canonical: ${err.message}`);
    }
  }

  return finalId;
}

async function getTraitsForCharacters(settings, characterNames, chatIds) {
  if (!Array.isArray(characterNames) || characterNames.length === 0) return [];
  const p = getPool(settings);
  // Chat isolation: traits are stamped with source_chat but the character
  // row is shared across chats (legacy global rows plus alias pollution
  // where one character's aliases absorb another's name). Without a
  // source_chat filter, traits extracted in chat B surface in chat A's
  // memory block. `chatIds` is the retriever's already-resolved scope —
  // it honors sessionMode (isolated/persistent) and per-character
  // selectedChats overrides, so cross-chat opt-ins keep working without
  // a separate mode branch here. NULL source_chat rows stay visible so
  // legacy pre-migration traits don't silently disappear.
  //
  // Callers that omit chatIds (eval harness, debug tools) get the old
  // unscoped behavior for backward compat.
  //
  // Persona traits are returned ALONGSIDE chat-scoped traits via UNION,
  // tagged is_persona=true. Both branches honor the chat-scope filter:
  // the global persona row is still a structural dedup target across
  // chats (so re-emitting "hospitable" in chat B doesn't create a third
  // copy alongside chat A's), but at retrieval time each persona-
  // mirrored trait surfaces only in the chats it was actually observed
  // in. Without this, traits extracted for a user persona in a biker-MC
  // RP (e.g. "logistics expert", "doctoral student") leaked into every
  // unrelated chat that happened to reuse the same persona name —
  // because each persona-mirrored trait carries the source_chat of the
  // chat it was extracted in (upsertTrait dedup is per-source_chat),
  // we get clean per-chat persona scoping just by honoring source_chat
  // on both branches.
  //
  // Cross-chat pooling for personas is still available via the existing
  // selectedChats UX: a user who wants their priestess-Alice
  // dispositions to travel across both her temple chats configures both
  // chats in selectedChats and both contribute. The default — no
  // selectedChats — is current-chat-only, which is what stops the leak.
  //
  // The formatter splits the result into separate "## Persona Traits"
  // and "## Character Traits" sections.
  const scoped = Array.isArray(chatIds) && chatIds.length > 0;
  // Route name→id resolution through resolveCharacterIds so verbose ST author
  // names ("Young Bob Smith  Acme MC Origin Story") match the
  // de-suffixed canonicals the extractor writes ("Young Bob Smith"). The
  // sibling read paths (getRelationships, getKnowledgeBoundaries, getLocations)
  // already go through this; we were the outlier doing raw c.name = ANY($1).
  const idsByName = await resolveCharacterIds(p, { names: characterNames, chatIds });
  const charIds = flattenResolvedCharacterIds(idsByName);
  if (charIds.length === 0) return [];
  // Canonical-aware scope check: a canonical row surfaces in a given
  // chat if EITHER the canonical itself was extracted there OR any
  // merged alias variant pointing at it was extracted there. Without
  // the alias half, re-extractions in chat B that dedupe onto a chat-A
  // canonical (the common case once trait dedup kicks in) would silently
  // drop out of chat B's memory block.
  const chatFilter = scoped
    ? ` AND EXISTS (
         SELECT 1 FROM traits v
         WHERE (v.id = t.id OR v.canonical_id = t.id)
           AND (v.source_chat = ANY($2::text[]) OR v.source_chat IS NULL)
       )`
    : "";
  const params = scoped ? [charIds, chatIds] : [charIds];
  const { rows } = await p.query(
    `(
       -- Chat-scoped (or unscoped legacy) trait rows, NOT from the global
       -- persona pool. These get rendered under "## Character Traits".
       SELECT c.name AS character_name, t.category, t.content,
              FALSE AS is_persona
       FROM traits t
       JOIN characters c ON c.id = t.character_id
       WHERE COALESCE(c.is_persona, FALSE) = FALSE
         AND c.id = ANY($1::text[])
         AND t.canonical_id IS NULL${chatFilter}
     )
     UNION ALL
     (
       -- Global persona pool, NOW chat-scope-filtered by source_chat so
       -- persona-mirrored traits from unrelated chats stop leaking. The
       -- character_name is the persona's own name; the formatter renders
       -- these under "## Persona Traits".
       SELECT c.name AS character_name, t.category, t.content,
              TRUE AS is_persona
       FROM traits t
       JOIN characters c ON c.id = t.character_id
       WHERE c.is_persona = TRUE AND c.chat_id IS NULL
         AND c.id = ANY($1::text[])
         AND t.canonical_id IS NULL${chatFilter}
     )
     ORDER BY character_name, category, content`,
    params,
  );
  return rows;
}

async function getTraitsForCharacter(settings, characterId) {
  const p = getPool(settings);
  // User-visible trait read: filter out merged variant rows
  // (canonical_id IS NOT NULL) so the same trait never surfaces twice.
  // Path 1's canonical-row dedup pipeline leaves merged variants in place
  // for provenance but they must never be returned to the UI.
  const { rows } = await p.query(
    `SELECT category, content FROM traits
     WHERE character_id = $1 AND canonical_id IS NULL
     ORDER BY category`,
    [characterId],
  );
  return rows;
}

// Per-character summary embedding = mean-pool of all dispositional trait
// embeddings for that character (personality category only, per the research
// report §5 Path 4). Recomputed on trait insert/delete; the call from
// upsertTrait is wired once Path 1 lands the actual per-trait embedding
// writes. Until then the column is populated via the /recompute-character-
// summaries admin route, which is a no-op per row until any traits have a
// non-null embedding.
//
// pgvector's AVG(vector) returns the element-wise mean, which for cosine
// similarity is equivalent to centroid direction after L2 normalization.
// If no trait has an embedding yet, AVG returns NULL and we reset the
// character row's summary_embedding to NULL so the HNSW index doesn't
// retain stale vectors after a trait purge.
async function _recomputeCharacterSummaryImpl(settings, characterId) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT AVG(embedding) AS avg_embedding
     FROM traits
     WHERE character_id = $1
       AND embedding IS NOT NULL
       AND category = 'personality'`,
    [characterId],
  );
  const avg = rows[0]?.avg_embedding ?? null;
  await p.query(
    `UPDATE characters SET summary_embedding = $2, updated_at = NOW()
     WHERE id = $1`,
    [characterId, avg],
  );
  return avg;
}

// Leading + trailing-edge debounce keyed by characterId. The extractor's
// parallel upsertTrait means N concurrent trait writes for one character
// would otherwise fire N concurrent AVG queries. Trailing-edge (rather than
// simple coalesce) is load-bearing: the first run's AVG reads an MVCC
// snapshot taken before late writers commit, so we need one more run after
// completion to pick up anything the first run missed. Net: at most 2
// recomputes per character per burst regardless of N.
const summaryRecomputeState = new Map();

async function recomputeCharacterSummary(settings, characterId) {
  const existing = summaryRecomputeState.get(characterId);
  if (existing) {
    existing.dirty = true;
    return existing.inFlight;
  }
  const state = { inFlight: null, dirty: false };
  summaryRecomputeState.set(characterId, state);
  state.inFlight = (async () => {
    try {
      do {
        state.dirty = false;
        await _recomputeCharacterSummaryImpl(settings, characterId);
      } while (state.dirty);
    } finally {
      summaryRecomputeState.delete(characterId);
    }
  })();
  return state.inFlight;
}

// ── Story arcs and event chains ────────────────────────────────

async function upsertStoryArc(settings, { chatId, title, description, arcType, status, importance, startMsgIdx, endMsgIdx, spineEventId, source, parentArcId, hierarchyLevel }) {
  const p = getPool(settings);
  const src = source || "llm"; // RESEARCH_ARCS Path 1: structural arcs pass "structural"
  // RESEARCH_ARCS Path 5: parentArcId / hierarchyLevel default to null / 1 so
  // every pre-Path-5 caller keeps producing flat arcs with the same semantics.
  const parent = parentArcId ?? null;
  const level = Number.isInteger(hierarchyLevel) ? hierarchyLevel : 1;
  // Scope the title-collision check by hierarchy_level so Path 5's three
  // levels can't step on each other even in the unlikely case two spines
  // produce the same 80-char templated title within one rebuild pass.
  const { rows: existing } = await p.query(
    `SELECT id FROM story_arcs WHERE chat_id = $1 AND title = $2 AND COALESCE(hierarchy_level, 1) = $3`,
    [chatId, title, level],
  );
  let arcId;
  if (existing.length > 0) {
    arcId = existing[0].id;
    await p.query(
      `UPDATE story_arcs SET description = $2, arc_type = $3, status = $4, importance = $5, end_msg_idx = $6, spine_event_id = COALESCE($7, spine_event_id), source = $8, parent_arc_id = $9, hierarchy_level = $10, updated_at = NOW() WHERE id = $1`,
      [arcId, description || "", arcType || "main", status || "active", importance || 3, endMsgIdx, spineEventId, src, parent, level],
    );
  } else {
    arcId = `arc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await p.query(
      `INSERT INTO story_arcs (id, chat_id, title, description, arc_type, status, importance, start_msg_idx, end_msg_idx, spine_event_id, source, parent_arc_id, hierarchy_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [arcId, chatId, title, description || "", arcType || "main", status || "active", importance || 3, startMsgIdx, endMsgIdx, spineEventId, src, parent, level],
    );
  }
  return arcId;
}

async function linkEventToArc(settings, { arcId, eventId, position, isAnchor }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO arc_events (arc_id, event_id, position, is_anchor) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [arcId, eventId, position || 0, isAnchor || false],
  ).catch(err => console.warn(`[ChronicleDB] linkEventToArc failed:`, err.message));
}

// event_chains is visualization-only: writes happen here but no
// retrieval/graph code reads it. Kept so the mindmap can grow into using
// the causal edges already being captured.
async function createEventChain(settings, { fromEventId, toEventId, chainType, description }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO event_chains (from_event_id, to_event_id, chain_type, description) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [fromEventId, toEventId, chainType || "caused", description || ""],
  ).catch(err => console.warn(`[ChronicleDB] createEventChain failed:`, err.message));
}

// ── Context snapshots ──────────────────────────────────────────

async function insertContextSnapshot(settings, { chatId, messageIndex, summary, locationName, presentChars, emotionalTone, worldStateSnapshot }) {
  const p = getPool(settings);
  const id = `ctx-${chatId}-${messageIndex}`;
  let locationId = null;
  if (locationName) locationId = await upsertLocation(settings, locationName, "");
  await p.query(
    `INSERT INTO context_snapshots (id, chat_id, message_index, summary, location_id, present_chars, emotional_tone, world_state_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET summary = $4, location_id = $5, present_chars = $6, emotional_tone = $7, world_state_snapshot = $8, timestamp = NOW()`,
    [id, chatId, messageIndex, summary, locationId, presentChars || [], emotionalTone || "", JSON.stringify(worldStateSnapshot || {})],
  );
  return id;
}

async function getRecentSnapshots(settings, chatId, limit) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT cs.*, l.name as location_name FROM context_snapshots cs LEFT JOIN locations l ON cs.location_id = l.id WHERE cs.chat_id = $1 ORDER BY cs.message_index DESC LIMIT $2`,
    [chatId, limit || 3],
  );
  return rows;
}

// ── Plot threads ───────────────────────────────────────────────

async function upsertPlotThread(settings, { chatId, title, description, threadType, involvedChars, plantedAt, resolvedAt, importance }) {
  const p = getPool(settings);
  const plotId = contentId("plot", `${chatId || ""}|${title}`);
  // H2: resolved_at uses COALESCE(old, new) so first resolution sticks.
  // The extractor passes resolvedAt=null on pending re-emits, and the
  // old `resolved_at = EXCLUDED.resolved_at` unresolved threads every
  // time they were re-surfaced. First resolution wins; a later pending
  // re-emit can't clobber it back to NULL.
  await p.query(
    `INSERT INTO plot_threads (id, chat_id, thread_type, title, description, involved_chars, planted_at, resolved_at, importance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       thread_type = EXCLUDED.thread_type,
       description = EXCLUDED.description,
       resolved_at = COALESCE(plot_threads.resolved_at, EXCLUDED.resolved_at),
       importance = EXCLUDED.importance,
       updated_at = NOW()`,
    [plotId, chatId, threadType || "pending", title, description || "", involvedChars || [], plantedAt || null, resolvedAt || null, importance || 3],
  );

  // Link to characters (ensure they exist first)
  for (const charName of (involvedChars || [])) {
    if (!charName) continue;
    const charId = await upsertCharacter(settings, { name: charName, chatId });
    await p.query(
      `INSERT INTO plot_thread_characters (plot_id, character_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [plotId, charId],
    ).catch(() => {});
  }

  return plotId;
}

async function getActivePlotThreads(settings, chatId) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT id, chat_id, thread_type, title, description, involved_chars,
            planted_at, resolved_at, importance, created_at, updated_at
       FROM plot_threads
      WHERE chat_id = $1 AND resolved_at IS NULL
      ORDER BY importance DESC
      LIMIT 20`,
    [chatId],
  );
  return rows;
}

// Resolve an existing plot thread by id. The extractor emits stable ids
// in `resolves_thread_ids` (sourced from the "Active plot threads" list
// shown in the prompt) so resolutions land on the original row instead
// of spawning a new one with type:"resolved" under a reworded title.
// chat_id is included in the WHERE clause as a guard so an LLM-typoed id
// from another chat can't accidentally resolve someone else's thread.
async function resolvePlotThread(settings, { id, chatId, resolvedAt }) {
  if (!id) return false;
  const p = getPool(settings);
  const { rowCount } = await p.query(
    `UPDATE plot_threads
        SET thread_type = 'resolved',
            resolved_at = COALESCE(resolved_at, $3),
            updated_at = NOW()
      WHERE id = $1 AND chat_id = $2`,
    [id, chatId || "", resolvedAt ?? null],
  );
  return rowCount > 0;
}

// ── Items ──────────────────────────────────────────────────────

async function upsertItem(settings, { name, description, powers, significance, owner, location, status, chatId }) {
  const p = getPool(settings);
  // ID is content-addressed by (slug(name), chatId) so the same-named item
  // in two different chats gets two separate rows (OWNS edges never bleed
  // across chats even when the same character appears in both), and so
  // case/punctuation variants of the same in-chat item ("Bob's knife" vs
  // "bob's knife") collapse to one row. The previous scheme keyed the
  // content id off the raw name, which meant every LLM re-render of an
  // item name spawned a new row — the cross-batch fragmentation this fix
  // targets.
  const itemSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const safeChat = chatId || "";
  const id = contentId("item", `${itemSlug}|${safeChat}`);
  // Legacy-row absorption: items inserted under the old raw-name scheme
  // have different content ids than the new slug-based one, so INSERT ON
  // CONFLICT alone would leave the old row and also write a new row. A
  // pre-SELECT by slug-normalized name in this chat finds any legacy row
  // and reuses its id, so subsequent upserts converge on a single row per
  // canonical item name. Scoped to chatId so items in other chats are
  // never touched.
  const existing = await p.query(
    `SELECT id FROM items
      WHERE chat_id = $1
        AND trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) = $2
      LIMIT 1`,
    [safeChat, itemSlug],
  );
  const targetId = existing.rows[0]?.id || id;
  let ownerId = null;
  if (owner) {
    const existingOwner = await findCharacterByNameOrAlias(settings, owner, chatId);
    ownerId = existingOwner?.id || await upsertCharacter(settings, { name: owner, chatId });
  }
  const locationId = location ? await upsertLocation(settings, location, "") : null;
  await p.query(
    `INSERT INTO items (id, name, description, powers, significance, owner_id, location_id, status, chat_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       description = EXCLUDED.description,
       powers = EXCLUDED.powers,
       significance = EXCLUDED.significance,
       owner_id = EXCLUDED.owner_id,
       location_id = EXCLUDED.location_id,
       status = EXCLUDED.status,
       chat_id = COALESCE(items.chat_id, EXCLUDED.chat_id)`,
    [targetId, name, description || "", powers || "", significance || 3, ownerId, locationId, status || "intact", chatId || null],
  );
  return targetId;
}

// Cross-batch entity context for the extraction prompt. Returns the set of
// characters, locations, and items already known in this chat so the
// extractor LLM can reuse those exact names instead of spawning variant
// rows ("the tavern" in batch 5, "The Tavern" in batch 12). AGARS-inspired:
// inject the known-entity list into the prompt, then canonicalize at insert
// time as a belt-and-braces backstop. See "cross-batch entity context"
// design note.
//
// Recency proxies:
//   - characters: MAX(events.message_index) from participated_in joined
//     through events.chat_id, falling back to present_at.since.
//   - locations: MAX(events.message_index) across events in this chat that
//     point at the location, plus present_at.since when the location only
//     appears as a presence pin.
//   - items: created_at DESC (items has no updated_at column).
//
// Each list is capped at 50 entries. For characters we flatten aliases
// (each alias counts as its own entry) while preserving recency order,
// so a character whose row is the most recent contributes its canonical
// name first and then its aliases. Dedup is case-sensitive on the raw
// string so "Alice" and "alice" both land in the list; the extractor
// prompt tells the LLM to prefer these exact names.
//
// Fails closed: any SQL error returns empty lists so the extraction
// pipeline never aborts on this best-effort enrichment.
async function listKnownEntitiesForChat(settings, chatId, currentMessageIndex = null) {
  const empty = { characterNames: [], locationNames: [], itemNames: [], activePlotThreads: [], recentKnowsByChar: {}, currentWorldState: [], personaTraitsByChar: {} };
  if (!chatId) return empty;
  const p = getPool(settings);

  try {
    // Characters: distinct char ids referenced by this chat, ordered by
    // recency. We pull 50 character rows from the DB (enough headroom to
    // flatten aliases and still have 50 strings after) and do the
    // flatten + dedup in JS.
    const charRes = await p.query(
      `WITH char_refs AS (
         SELECT pi.character_id AS char_id,
                e.message_index AS msg_idx,
                NULL::timestamptz AS pa_since
           FROM participated_in pi
           JOIN events e ON e.id = pi.event_id
          WHERE e.chat_id = $1
         UNION ALL
         SELECT pa.character_id,
                NULL::int,
                pa.since
           FROM present_at pa
          WHERE pa.chat_id = $1
       )
       SELECT c.name,
              c.aliases,
              MAX(cr.msg_idx) AS max_msg_idx,
              MAX(cr.pa_since) AS max_since,
              c.updated_at
         FROM char_refs cr
         JOIN characters c ON c.id = cr.char_id
        GROUP BY c.id, c.name, c.aliases, c.updated_at
        ORDER BY MAX(cr.msg_idx) DESC NULLS LAST,
                 MAX(cr.pa_since) DESC NULLS LAST,
                 c.updated_at DESC NULLS LAST
        LIMIT 50`,
      [chatId],
    );

    const characterNames = [];
    const seenCharNames = new Set();
    const pushCharName = (n) => {
      if (characterNames.length >= 50) return;
      const s = (n || "").toString().trim();
      if (!s) return;
      if (seenCharNames.has(s)) return;
      seenCharNames.add(s);
      characterNames.push(s);
    };
    for (const row of charRes.rows) {
      pushCharName(row.name);
      const aliases = Array.isArray(row.aliases) ? row.aliases : [];
      for (const a of aliases) pushCharName(a);
      if (characterNames.length >= 50) break;
    }

    // Locations: distinct location ids pointed at by events.chat_id or
    // present_at.chat_id in this chat. Use events.message_index as the
    // recency proxy, with present_at.since as a fallback for locations
    // that only appear as presence pins.
    const locRes = await p.query(
      `WITH loc_refs AS (
         SELECT e.location_id AS loc_id,
                e.message_index AS msg_idx,
                NULL::timestamptz AS pa_since
           FROM events e
          WHERE e.chat_id = $1 AND e.location_id IS NOT NULL
         UNION ALL
         SELECT pa.location_id, NULL::int, pa.since
           FROM present_at pa
          WHERE pa.chat_id = $1 AND pa.location_id IS NOT NULL
       )
       SELECT l.name,
              MAX(lr.msg_idx) AS max_msg_idx,
              MAX(lr.pa_since) AS max_since
         FROM loc_refs lr
         JOIN locations l ON l.id = lr.loc_id
        GROUP BY l.id, l.name
        ORDER BY MAX(lr.msg_idx) DESC NULLS LAST,
                 MAX(lr.pa_since) DESC NULLS LAST
        LIMIT 50`,
      [chatId],
    );
    const locationNames = [];
    const seenLocNames = new Set();
    for (const row of locRes.rows) {
      const s = (row.name || "").toString().trim();
      if (!s || seenLocNames.has(s)) continue;
      seenLocNames.add(s);
      locationNames.push(s);
      if (locationNames.length >= 50) break;
    }

    // Items: chat-scoped via items.chat_id. Items has created_at only —
    // upsertItem rewrites description/powers/status via ON CONFLICT but
    // does not touch created_at, so created_at DESC is the best proxy
    // for "most recently seen". Legacy NULL-chat rows are intentionally
    // skipped; they don't belong to any chat and shouldn't leak into
    // every chat's known list.
    const itemRes = await p.query(
      `SELECT name FROM items
        WHERE chat_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [chatId],
    );
    const itemNames = [];
    const seenItemNames = new Set();
    for (const row of itemRes.rows) {
      const s = (row.name || "").toString().trim();
      if (!s || seenItemNames.has(s)) continue;
      seenItemNames.add(s);
      itemNames.push(s);
      if (itemNames.length >= 50) break;
    }

    // Active plot threads: surfaced so the extractor can see what already
    // exists and either reuse the same id (via resolves_thread_ids) or skip
    // re-emitting near-duplicates. Without this the LLM keeps spawning
    // reworded variants of the same tension every batch — e.g. an
    // "X cleanup" / "Cleaning up X" / "The cleanup of X" cluster all
    // pointing at the same underlying tension.
    const ptRes = await p.query(
      `SELECT id, title, description, involved_chars, importance
         FROM plot_threads
        WHERE chat_id = $1 AND resolved_at IS NULL
        ORDER BY importance DESC, updated_at DESC
        LIMIT 20`,
      [chatId],
    );
    const activePlotThreads = ptRes.rows.map((r) => ({
      id: r.id,
      title: r.title || "",
      description: r.description || "",
      involvedChars: Array.isArray(r.involved_chars) ? r.involved_chars : [],
    }));

    // Recent KNOWS per character: surfaced so the extractor can see what
    // each character has already learned in this chat and stop re-emitting
    // reworded variants of the same fact via knowledge_updates. Without
    // this, the LLM treats `learned` as a catch-all summary of the
    // character's situation and `facts` accumulates near-duplicates every
    // batch (e.g. "X feels used by the group" x4).
    const knowsRes = await p.query(
      `SELECT c.name AS character_name, f.content
         FROM knows k
         JOIN facts f ON f.id = k.fact_id
         JOIN characters c ON c.id = k.character_id
        WHERE k.chat_id = $1
        ORDER BY c.name ASC, f.created_at DESC NULLS LAST`,
      [chatId],
    );
    const recentKnowsByChar = {};
    for (const row of knowsRes.rows) {
      const n = (row.character_name || "").trim();
      const content = (row.content || "").trim();
      if (!n || !content) continue;
      if (!recentKnowsByChar[n]) recentKnowsByChar[n] = [];
      if (recentKnowsByChar[n].length >= 10) continue;
      recentKnowsByChar[n].push(content);
    }

    // Current world_state — surfaced so the extractor reuses existing
    // canonical keys instead of inventing variants every batch (the
    // failure mode we used to see: `Piper the Black status` AND
    // `Piper the Black` both surviving as parallel "current" rows
    // because the LLM emits a slightly different key the second time).
    // Cap at 30 so a runaway extraction can't eat the prompt budget.
    //
    // source_message_index is projected so the extractor can annotate
    // rows last re-emitted many turns ago as "possibly stale" — the
    // single biggest cause of frozen world_state is the LLM never
    // proactively superseding scene-anchored facts (a "tomorrow's
    // meeting" key set 30 turns ago that the current scene has clearly
    // moved past). The annotation alone won't supersede; it just makes
    // stale candidates visible to the LLM in the prompt.
    const wsRes = await p.query(
      `SELECT key, value, source_message_index FROM world_state
        WHERE chat_id = $1 AND valid_until IS NULL
        ORDER BY valid_from DESC
        LIMIT 30`,
      [chatId],
    );
    const currentWorldState = wsRes.rows.map((r) => {
      const sourceMsgIdx = typeof r.source_message_index === "number" ? r.source_message_index : null;
      let turnsSinceSeen = null;
      if (typeof currentMessageIndex === "number" && sourceMsgIdx !== null) {
        const diff = currentMessageIndex - sourceMsgIdx;
        if (diff >= 0) turnsSinceSeen = diff;
      }
      return {
        key: r.key,
        value: r.value,
        sourceMessageIndex: sourceMsgIdx,
        turnsSinceSeen,
      };
    });

    // Persona traits already known globally — surfaced so the extractor
    // doesn't waste a per-batch trait slot re-emitting a disposition the
    // persona has already established in another chat. Each persona that
    // shows up in this chat (via the chat-scoped is_persona row) gets
    // the matching global persona row's traits listed here, capped to
    // keep prompt size bounded.
    const personaTraitsByChar = {};
    const personaCharsRes = await p.query(
      `SELECT DISTINCT name FROM characters
        WHERE chat_id = $1 AND is_persona = TRUE`,
      [chatId],
    );
    for (const personaRow of personaCharsRes.rows) {
      const personaName = (personaRow.name || "").trim();
      if (!personaName) continue;
      const traitsRes = await p.query(
        `SELECT t.category, t.content
           FROM traits t
           JOIN characters c ON c.id = t.character_id
          WHERE c.is_persona = TRUE
            AND c.chat_id IS NULL
            AND lower(trim(c.name)) = lower(trim($1::text))
            AND t.canonical_id IS NULL
          ORDER BY t.merged_count DESC NULLS LAST, t.category, t.content
          LIMIT 40`,
        [personaName],
      );
      if (traitsRes.rows.length === 0) continue;
      personaTraitsByChar[personaName] = traitsRes.rows.map((r) => ({
        category: r.category,
        content: r.content,
      }));
    }

    return { characterNames, locationNames, itemNames, activePlotThreads, recentKnowsByChar, currentWorldState, personaTraitsByChar };
  } catch (err) {
    console.warn(`[ChronicleDB] listKnownEntitiesForChat(${chatId}) failed: ${err.message}`);
    return empty;
  }
}

// Retrieval vector/query helpers are extracted behind a stable facade.
// See ./db/retrieval-domain.js for these implementations.

// Graph traversal and projection helpers are extracted behind a stable facade.
// See ./db/graph-domain.js for these implementations.

// ── Per-character memory config ────────────────────────────────

async function getCharacterMemoryConfig(settings, characterName) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT character_name, session_mode, selected_chats, updated_at
       FROM character_memory_config
      WHERE character_name = $1`,
    [characterName],
  );
  if (rows.length === 0) return { characterName, sessionMode: "persistent", selectedChats: [] };
  return { characterName: rows[0].character_name, sessionMode: rows[0].session_mode, selectedChats: rows[0].selected_chats || [] };
}

async function saveCharacterMemoryConfig(settings, { characterName, sessionMode, selectedChats }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO character_memory_config (character_name, session_mode, selected_chats, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (character_name) DO UPDATE SET session_mode = $2, selected_chats = $3, updated_at = NOW()`,
    [characterName, sessionMode || "persistent", selectedChats || []],
  );
}

// Character panel query helpers are extracted behind a stable facade.
// See ./db/character-panel-domain.js for these implementations.

// ── Per-character epistemic mask (AGARS known_nodes, derived view) ─────
//
// "At turn N in chat X, what does character Y know about?" is answered
// entirely from existing edges — no stored mask, no schema changes. The
// return shape is a bag of Sets the retriever uses as an allowlist to
// post-filter omniscient retrieval results.
//
// Knowledge model:
//   - Events: a character "knows" an event iff they directly
//     `participated_in` it, OR they were `present_at` the event's
//     location during the same chat (scene-presence). The message-index
//     cap lets a caller answer "what did Y know as of turn N" without
//     poisoning the scene with post-turn spoilers.
//   - Facts: `knows.fact_id` scoped to (character, chat). Already the
//     extractor's explicit model — just read it back.
//   - Locations: locations of events the character witnessed, plus
//     every location they're `present_at` in this chat.
//   - Items: items the character owns directly (`items.owner_id`).
//     Items also have a `location_id` but no link to a witnessing event,
//     so we deliberately stop at the owned set rather than over-project.
//     See the report for the ambiguity call.
//   - Characters: other characters who co-appeared in any witnessed
//     event (via participated_in or present_at at the same location
//     for the same chat). Focal character is excluded from their own
//     set — "Y knows about Y" is trivially true and not useful for
//     post-filter cross-referencing.
//
// Implementation notes:
//   - One query per set; SELECT DISTINCT ids only — no full rows.
//   - `upToMessageIndex` is optional. When undefined/null, no
//     message-cap filter is applied (omniscient-within-edges).
//   - Returns all-empty Sets when the character can't be resolved for
//     this chat, not an error — the retriever treats an unknown POV
//     as "knows nothing", which is the safest possible fail mode.
//   - `eventMessageIndexes` is returned alongside `eventIds` as an
//     additive helper: the retriever needs it to filter
//     `result.events` (which `getRecentEvents` projects without ids)
//     and neighbor padding (keyed by message_index, not event id).
async function getCharacterKnownUniverse(settings, { characterName, chatId, upToMessageIndex } = {}) {
  const empty = {
    eventIds: new Set(),
    eventMessageIndexes: new Set(),
    factIds: new Set(),
    locationIds: new Set(),
    itemIds: new Set(),
    characterIds: new Set(),
  };
  if (!characterName || !chatId) return empty;

  const character = await findCharacterByNameOrAlias(settings, characterName, chatId);
  if (!character) return empty;
  const charId = character.id;

  const p = getPool(settings);

  // Normalize the message-index cap. `undefined` / `null` means "no cap"
  // and we pass NULL to Postgres; the WHERE clause uses IS NULL fallback
  // so a NULL cap doesn't filter. Numeric 0 is a legitimate cap value
  // ("as of turn zero") and preserved.
  const msgCap = (upToMessageIndex === undefined || upToMessageIndex === null)
    ? null
    : Number(upToMessageIndex);

  // ── Events witnessed via participated_in OR present_at ────────
  // participated_in is character-indexed so the ANY-join is cheap.
  // present_at carries chat_id directly; we pivot through events at
  // the same location AND same chat AND (optional) message_index cap.
  // The UNION collapses to a DISTINCT id + message_index projection.
  const eventsPromise = p.query(
    `SELECT DISTINCT e.id, e.message_index, e.location_id
       FROM events e
       JOIN participated_in pi ON pi.event_id = e.id
      WHERE pi.character_id = $1
        AND e.chat_id = $2
        AND ($3::int IS NULL OR e.message_index IS NULL OR e.message_index <= $3::int)
     UNION
     SELECT DISTINCT e.id, e.message_index, e.location_id
       FROM events e
       JOIN present_at pa ON pa.location_id = e.location_id
                         AND pa.chat_id = e.chat_id
      WHERE pa.character_id = $1
        AND e.chat_id = $2
        AND ($3::int IS NULL OR e.message_index IS NULL OR e.message_index <= $3::int)`,
    [charId, chatId, msgCap],
  );

  // ── Facts ─────────────────────────────────────────────────────
  // Direct read of the knows edge. chat_id scope is part of the unique
  // key, so this is a one-shot index lookup on idx_knows_chat.
  const factsPromise = p.query(
    `SELECT DISTINCT fact_id
       FROM knows
      WHERE character_id = $1
        AND chat_id = $2`,
    [charId, chatId],
  );

  // ── Locations via present_at (chat-scoped) ────────────────────
  // Event-location locations are derived from the events query above
  // and merged JS-side (avoids duplicating the UNION).
  const presentLocationsPromise = p.query(
    `SELECT DISTINCT location_id
       FROM present_at
      WHERE character_id = $1
        AND chat_id = $2
        AND location_id IS NOT NULL`,
    [charId, chatId],
  );

  // ── Items owned by this character ─────────────────────────────
  // items.owner_id is the ownership edge (confirmed via schema.sql §
  // Items and upsertItem in db.js). No separate OWNS table. Items carry
  // chat_id so we filter to this chat, but tolerate legacy NULL rows
  // that predate the chat_id column — otherwise re-scoping a character
  // to an older chat drops their own inventory.
  const itemsPromise = p.query(
    `SELECT DISTINCT id
       FROM items
      WHERE owner_id = $1
        AND (chat_id = $2 OR chat_id IS NULL)`,
    [charId, chatId],
  );

  const [eventsRes, factsRes, presentLocRes, itemsRes] = await Promise.all([
    eventsPromise, factsPromise, presentLocationsPromise, itemsPromise,
  ]);

  const eventIds = new Set();
  const eventMessageIndexes = new Set();
  const locationIds = new Set();
  for (const r of eventsRes.rows) {
    if (r.id) eventIds.add(r.id);
    if (typeof r.message_index === "number") eventMessageIndexes.add(r.message_index);
    if (r.location_id) locationIds.add(r.location_id);
  }
  for (const r of presentLocRes.rows) {
    if (r.location_id) locationIds.add(r.location_id);
  }

  const factIds = new Set();
  for (const r of factsRes.rows) if (r.fact_id) factIds.add(r.fact_id);

  const itemIds = new Set();
  for (const r of itemsRes.rows) if (r.id) itemIds.add(r.id);

  // ── Co-appearing characters ────────────────────────────────────
  // Characters who participated_in any witnessed event, OR who were
  // present_at the same location during a witnessed event. One query,
  // fed the eventIds + location_ids sets. Empty-set guards: pg rejects
  // `ANY(ARRAY[]::text[])` pattern matching cleanly but we short-circuit
  // anyway to save a round-trip when the character has witnessed
  // nothing.
  const characterIds = new Set();
  if (eventIds.size > 0) {
    const eventIdArr = [...eventIds];
    const { rows: coRows } = await p.query(
      `SELECT DISTINCT character_id
         FROM participated_in
        WHERE event_id = ANY($1::text[])
          AND character_id <> $2`,
      [eventIdArr, charId],
    );
    for (const r of coRows) if (r.character_id) characterIds.add(r.character_id);
  }
  if (locationIds.size > 0) {
    const locationIdArr = [...locationIds];
    const { rows: coPresentRows } = await p.query(
      `SELECT DISTINCT character_id
         FROM present_at
        WHERE location_id = ANY($1::text[])
          AND chat_id = $2
          AND character_id <> $3`,
      [locationIdArr, chatId, charId],
    );
    for (const r of coPresentRows) if (r.character_id) characterIds.add(r.character_id);
  }

  return {
    eventIds,
    eventMessageIndexes,
    factIds,
    locationIds,
    itemIds,
    characterIds,
  };
}

function normalizeClearChatIds(chatIds) {
  if (Array.isArray(chatIds)) return chatIds.filter((id) => typeof id === "string" && id.length > 0);
  if (typeof chatIds === "string" && chatIds.length > 0) return [chatIds];
  return [];
}

async function clearCharacterMemories(settings, characterName, chatIds) {
  const p = getPool(settings);
  const scopedChatIds = normalizeClearChatIds(chatIds);
  const scoped = scopedChatIds.length > 0;
  const idsByName = scoped
    ? await resolveCharacterIds(p, { names: [characterName], chatIds: scopedChatIds })
    : null;
  const charIds = scoped
    ? (idsByName.get(characterName) || [slugify(characterName), ...scopedChatIds.map((chatId) => chatScopedId(characterName, chatId))])
    : [slugify(characterName)];
  const cleared = { traits: 0, feels_about: 0, participated_in: 0, present_at: 0, knows: 0 };
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const t = scoped
      ? await client.query(
          `DELETE FROM traits
            WHERE character_id = ANY($1::text[])
              AND source_chat = ANY($2::text[])`,
          [charIds, scopedChatIds],
        )
      : await client.query(`DELETE FROM traits WHERE character_id = ANY($1::text[])`, [charIds]);
    cleared.traits = t.rowCount || 0;
    const f = scoped
      ? await client.query(
          `DELETE FROM feels_about
            WHERE (from_char = ANY($1::text[]) OR to_char = ANY($1::text[]))
              AND session_id = ANY($2::text[])`,
          [charIds, scopedChatIds],
        )
      : await client.query(`DELETE FROM feels_about WHERE from_char = ANY($1::text[]) OR to_char = ANY($1::text[])`, [charIds]);
    cleared.feels_about = f.rowCount || 0;
    const pi = scoped
      ? await client.query(
          `DELETE FROM participated_in pi
            USING events e
            WHERE pi.event_id = e.id
              AND pi.character_id = ANY($1::text[])
              AND e.chat_id = ANY($2::text[])`,
          [charIds, scopedChatIds],
        )
      : await client.query(`DELETE FROM participated_in WHERE character_id = ANY($1::text[])`, [charIds]);
    cleared.participated_in = pi.rowCount || 0;
    const pa = scoped
      ? await client.query(
          `DELETE FROM present_at
            WHERE character_id = ANY($1::text[])
              AND chat_id = ANY($2::text[])`,
          [charIds, scopedChatIds],
        )
      : await client.query(`DELETE FROM present_at WHERE character_id = ANY($1::text[])`, [charIds]);
    cleared.present_at = pa.rowCount || 0;
    const k = scoped
      ? await client.query(
          `DELETE FROM knows
            WHERE character_id = ANY($1::text[])
              AND chat_id = ANY($2::text[])`,
          [charIds, scopedChatIds],
        )
      : await client.query(`DELETE FROM knows WHERE character_id = ANY($1::text[])`, [charIds]);
    cleared.knows = k.rowCount || 0;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  for (const charId of charIds) invalidateTraitListCache(charId);
  return cleared;
}

async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = {
  getPool, setPoolErrorHandler, initSchema, slugify, chatScopedId, resolveCharacterIdsForNames,
  upsertCharacter, ensurePersonaCharacter, findCharacterByNameOrAlias, upsertLocation, upsertLocationAdjacency, upsertRelationship, upsertEvent, upsertFact, upsertWorldState,
  normalizeWorldStateKey, supersedeWorldStateKeys, closeStaleSnapshotKeys, isSnapshotKey,
  upsertTrait, classifyDisposition, getTraitsForCharacter, getTraitsForCharacters, recomputeCharacterSummary,
  insertContextSnapshot, getRecentSnapshots,
  upsertPlotThread, getActivePlotThreads, resolvePlotThread, upsertItem, listKnownEntitiesForChat,
  upsertStoryArc, linkEventToArc, createEventChain,
  storeEmbedding, upsertMemoryEmbedding, upsertDialogueQuote,
  getGraphData, traverseFromCharacter, getCharacterMemoryConfig, saveCharacterMemoryConfig,
  getCharacterPanelStats, getCharacterRecentEvents, getCharacterOutboundRelationships, clearCharacterMemories,
  getCharacterKnownUniverse,
  closePool,
};
