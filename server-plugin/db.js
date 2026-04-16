const { Pool } = require("pg");
const { readFileSync } = require("fs");
const { resolve } = require("path");
const { createHash } = require("crypto");
const { GOLDBERG_100, NRC_EMOTION, NRC_VAD } = require("../shared/trait-lexicons");
const { setWithBoundedEviction } = require("./bounded-map");
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
  const configHash = `${settings.pgHost}:${settings.pgPort}:${settings.pgDatabase}:${settings.pgUser}`;
  if (!pool || configHash !== poolConfigHash) {
    if (pool) pool.end().catch(() => {});
    poolConfigHash = configHash;
    pool = new Pool({
      host: settings.pgHost || "localhost",
      port: settings.pgPort || 5432,
      database: settings.pgDatabase || "chronicledb",
      user: settings.pgUser || process.env.USER,
      password: settings.pgPassword || "",
      // traverseFromCharacter fans out ~15 concurrent queries via Promise.all,
      // and extractor.js runs parallel upsertTrait per character on top of it.
      // max:10 was leaving the excess queries queued on the pool; 20 gives
      // headroom so the common fan-out patterns run unthrottled.
      max: 20,
    });
    pool.on("error", (err) => {
      try { poolErrorHandler(err); } catch (_) { /* swallowing ensures listener never throws */ }
    });
  }
  return pool;
}

async function initSchema(settings) {
  const p = getPool(settings);
  const raw = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
  // Strip `--` line comments BEFORE splitting on `;`. Comments can
  // legally contain `;` and backticks, and the previous naive splitter
  // would mid-cut a comment block and send the dangling second half
  // ("...`merged_count` is a cheap popularity signal. ALTER TABLE...")
  // straight to Postgres as a syntax error, silently dropping the ALTER.
  // schema.sql has no `--` inside SQL string literals, so a whole-line
  // strip is safe here.
  const sql = raw
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
  const stmts = sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);

  for (const stmt of stmts) {
    try {
      await p.query(stmt);
    } catch (err) {
      if (!err.message.includes("already exists")) {
        console.warn(`[ChronicleDB] Schema warning: ${err.message}`);
      }
    }
  }
  console.log("[ChronicleDB] Schema initialized.");
}

// ── Node upserts ───────────────────────────────────────────────

function slugify(name) {
  return "chr-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const {
  storeEmbedding,
  upsertMemoryEmbedding,
  upsertDialogueQuote,
  vectorSearch,
  vectorSearchScoped,
  lexicalSearch,
  hybridSearch,
  getRelationships,
  getKnowledgeBoundaries,
  getRecentEvents,
  getWorldState,
} = createRetrievalDomain({ getPool, slugify });

const {
  traverseFromCharacter,
  getGraphData,
} = createGraphDomain({ getPool, slugify });

const {
  getCharacterPanelStats,
  getCharacterRecentEvents,
  getCharacterOutboundRelationships,
} = createCharacterPanelDomain({ getPool, slugify });

async function upsertCharacter(settings, { name, aliases, description, firstSeen }) {
  const p = getPool(settings);
  const id = slugify(name);
  await p.query(
    `INSERT INTO characters (id, name, aliases, description, first_seen)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       aliases = (
         SELECT array_agg(DISTINCT a)
         FROM unnest(characters.aliases || EXCLUDED.aliases) a
       ),
       description = COALESCE(NULLIF(EXCLUDED.description, ''), characters.description),
       updated_at = NOW()`,
    [id, name, aliases || [], description || "", firstSeen || ""],
  );
  return id;
}

async function findCharacterByNameOrAlias(settings, name) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT id, name, aliases FROM characters
     WHERE name = $1 OR $1 = ANY(aliases) OR id = $2
     LIMIT 1`,
    [name, slugify(name)],
  );
  return rows[0] || null;
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
  const fromId = slugify(from);
  const toId = slugify(to);
  // Ensure both characters exist
  await upsertCharacter(settings, { name: from });
  await upsertCharacter(settings, { name: to });
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
    const charId = await upsertCharacter(settings, { name });
    await p.query(
      `INSERT INTO participated_in (character_id, event_id, role)
       VALUES ($1, $2, 'participant')
       ON CONFLICT (character_id, event_id) DO NOTHING`,
      [charId, id],
    );
  }

  return id;
}

async function upsertFact(settings, { content, domain, confidence, characterScope, chatId }) {
  const p = getPool(settings);
  // Facts themselves stay globally-deduped (same content = same row) so
  // dedup still works. The chat scope lives on the knows edge instead —
  // "character X knows fact Y in chat Z" — so the same fact can be
  // known by different characters in different chats without bleeding
  // across scope.
  const id = contentId("fact", `${content}|${domain || "other"}`);
  await p.query(
    `INSERT INTO facts (id, content, domain, confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, content, domain || "other", confidence || 0.8],
  );

  for (const charName of (characterScope || [])) {
    const charId = slugify(charName);
    await upsertCharacter(settings, { name: charName });
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

async function upsertWorldState(settings, { key, value, reason, chatId }) {
  if (!key || typeof key !== "string" || !key.trim()) return;
  if (value === undefined || value === null) return;
  const p = getPool(settings);
  const k = key.trim();
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
    `INSERT INTO world_state (key, value, reason, chat_id) VALUES ($1, $2, $3, $4)`,
    [k, String(value), reason || "", chatId || null],
  );
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
const TRAIT_MERGE_COSINE = 0.88;
const TRAIT_VERIFY_COSINE = 0.80;

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

async function upsertTrait(
  settings,
  { characterId, characterName, category, content, evidenceSentence, sourceChat, sourceMessageIndex },
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
  const { rows: similar } = await p.query(
    `SELECT id, content, length(content) AS len,
            similarity(lower(content), lower($3)) AS sim
     FROM traits
     WHERE character_id = $1 AND category = $2 AND canonical_id IS NULL
       AND (
         stemmed_content = strip(to_tsvector('english', $3))::text
         OR lower(content) LIKE '%' || lower($3) || '%'
         OR lower($3) LIKE '%' || lower(content) || '%'
         OR similarity(lower(content), lower($3)) > $4
       )
     ORDER BY len DESC, sim DESC
     LIMIT 1`,
    [characterId, cat, cleaned, TRAIT_SIMILARITY_THRESHOLD],
  );
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
         ORDER BY embedding <=> $1::vector
         LIMIT 3`,
        [JSON.stringify(embedding), characterId, cat],
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
    const mergedId = `trait-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const msgIdxParam = Number.isFinite(sourceMessageIndex) ? sourceMessageIndex : null;
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
        console.warn(`[ChronicleDB] trait verifier failed (${err.message}); falling through to NEW_CANONICAL`);
        decision = "KEEP_DISTINCT";
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
  // if we have one, canonical_id = NULL. The existing exact-normalized
  // ON CONFLICT remains as a safety net against races/case variants.
  const id = `trait-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
  } else {
    const { rows: existing } = await p.query(
      `SELECT id FROM traits
       WHERE character_id = $1 AND category = $2
         AND normalized_content = regexp_replace(lower($3), '[^a-z0-9]', '', 'g')
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
  ).catch(() => {});
}

async function createEventChain(settings, { fromEventId, toEventId, chainType, description }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO event_chains (from_event_id, to_event_id, chain_type, description) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [fromEventId, toEventId, chainType || "caused", description || ""],
  ).catch(() => {});
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
    const charId = slugify(charName);
    await upsertCharacter(settings, { name: charName });
    await p.query(
      `INSERT INTO plot_thread_characters (plot_id, character_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [plotId, charId],
    ).catch(() => {});
  }

  return plotId;
}

async function getActivePlotThreads(settings, chatId) {
  const p = getPool(settings);
  const { rows } = await p.query(`SELECT * FROM plot_threads WHERE chat_id = $1 AND resolved_at IS NULL ORDER BY importance DESC LIMIT 20`, [chatId]);
  return rows;
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
  const ownerId = owner ? slugify(owner) : null;
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
async function listKnownEntitiesForChat(settings, chatId) {
  const empty = { characterNames: [], locationNames: [], itemNames: [] };
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

    return { characterNames, locationNames, itemNames };
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
    `SELECT * FROM character_memory_config WHERE character_name = $1`,
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

  const character = await findCharacterByNameOrAlias(settings, characterName);
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

async function clearCharacterMemories(settings, characterName) {
  const p = getPool(settings);
  const charId = slugify(characterName);
  const cleared = { traits: 0, feels_about: 0, participated_in: 0, present_at: 0, knows: 0 };
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const t = await client.query(`DELETE FROM traits WHERE character_id = $1`, [charId]);
    cleared.traits = t.rowCount || 0;
    const f = await client.query(`DELETE FROM feels_about WHERE from_char = $1 OR to_char = $1`, [charId]);
    cleared.feels_about = f.rowCount || 0;
    const pi = await client.query(`DELETE FROM participated_in WHERE character_id = $1`, [charId]);
    cleared.participated_in = pi.rowCount || 0;
    const pa = await client.query(`DELETE FROM present_at WHERE character_id = $1`, [charId]);
    cleared.present_at = pa.rowCount || 0;
    const k = await client.query(`DELETE FROM knows WHERE character_id = $1`, [charId]);
    cleared.knows = k.rowCount || 0;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return cleared;
}

async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = {
  getPool, setPoolErrorHandler, initSchema, slugify,
  upsertCharacter, findCharacterByNameOrAlias, upsertLocation, upsertLocationAdjacency, upsertRelationship, upsertEvent, upsertFact, upsertWorldState,
  upsertTrait, classifyDisposition, getTraitsForCharacter, recomputeCharacterSummary,
  insertContextSnapshot, getRecentSnapshots,
  upsertPlotThread, getActivePlotThreads, upsertItem, listKnownEntitiesForChat,
  upsertStoryArc, linkEventToArc, createEventChain,
  storeEmbedding, upsertMemoryEmbedding, upsertDialogueQuote, vectorSearch, vectorSearchScoped, lexicalSearch, hybridSearch,
  getRelationships, getKnowledgeBoundaries, getRecentEvents, getWorldState,
  getGraphData, traverseFromCharacter, getCharacterMemoryConfig, saveCharacterMemoryConfig,
  getCharacterPanelStats, getCharacterRecentEvents, getCharacterOutboundRelationships, clearCharacterMemories,
  getCharacterKnownUniverse,
  closePool,
};

