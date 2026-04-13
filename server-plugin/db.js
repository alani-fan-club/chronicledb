const { Pool } = require("pg");
const { readFileSync } = require("fs");
const { resolve } = require("path");
const { createHash } = require("crypto");
const { buildOrTsquery } = require("../shared/ts-query");
const { GOLDBERG_100, NRC_EMOTION, NRC_VAD } = require("../shared/trait-lexicons");

let pool = null;
let poolConfigHash = "";

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
      max: 10,
    });
  }
  return pool;
}

async function initSchema(settings) {
  const p = getPool(settings);
  const sql = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
  const stmts = sql.split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith("--"));

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

async function upsertEvent(settings, { summary, sourceText, participants, location, significance, messageIndex, sessionId }) {
  const p = getPool(settings);
  const id = contentId("evt", `${summary}|${sessionId || ""}|${messageIndex || 0}`);

  let locationId = null;
  if (location) {
    locationId = await upsertLocation(settings, location, "");
  }

  await p.query(
    `INSERT INTO events (id, summary, source_text, significance, message_index, location_id, chat_id, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET
       summary = EXCLUDED.summary,
       source_text = COALESCE(NULLIF(EXCLUDED.source_text, ''), events.source_text),
       significance = EXCLUDED.significance`,
    [id, summary, sourceText || "", significance || 3, messageIndex || 0, locationId, sessionId || ""],
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
    await p.query(
      `INSERT INTO knows (character_id, fact_id, source, chat_id)
       VALUES ($1, $2, 'discovered', $3)
       ON CONFLICT (character_id, fact_id) DO UPDATE SET
         chat_id = COALESCE(knows.chat_id, EXCLUDED.chat_id)`,
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

async function upsertTrait(
  settings,
  { characterId, characterName, category, content, evidenceSentence, sourceChat },
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

  if (topHit && typeof topHit.cos === "number" && topHit.cos >= TRAIT_MERGE_COSINE) {
    // MERGE: append to the canonical row's aliases, bump merged_count,
    // and insert this row pointing at it so the provenance survives.
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
    try {
      await p.query(
        `INSERT INTO traits (id, character_id, category, content, source_chat, embedding, evidence_sentence, canonical_id)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
         ON CONFLICT (character_id, category, normalized_content) DO NOTHING`,
        [
          mergedId,
          characterId,
          cat,
          cleaned,
          sourceChat || "",
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

  if (
    topHit &&
    typeof topHit.cos === "number" &&
    topHit.cos >= TRAIT_VERIFY_COSINE &&
    topHit.cos < TRAIT_MERGE_COSINE
  ) {
    // VERIFY band. Path 3 (LLM verifier) is not yet built — log the
    // near-miss and fall through to NEW_CANONICAL so we don't lose the
    // candidate. TODO(Path 3): replace this branch with a call to the
    // verifier that returns MERGE / KEEP_DISTINCT / REJECT_NEW.
    console.info(
      `[ChronicleDB] trait verifier queue: "${cleaned}" vs "${topHit.content}" cos=${topHit.cos.toFixed(4)} (char=${characterId} cat=${cat})`,
    );
  }

  // NEW_CANONICAL: insert as a fresh canonical row, embedding populated
  // if we have one, canonical_id = NULL. The existing exact-normalized
  // ON CONFLICT remains as a safety net against races/case variants.
  const id = `trait-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const { rows: inserted } = await p.query(
    `INSERT INTO traits (id, character_id, category, content, source_chat, embedding, evidence_sentence)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
     ON CONFLICT (character_id, category, normalized_content) DO NOTHING
     RETURNING id`,
    [
      id,
      characterId,
      cat,
      cleaned,
      sourceChat || "",
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
async function recomputeCharacterSummary(settings, characterId) {
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

// ── Story arcs and event chains ────────────────────────────────

async function upsertStoryArc(settings, { chatId, title, description, arcType, status, importance, startMsgIdx, endMsgIdx, spineEventId }) {
  const p = getPool(settings);
  const { rows: existing } = await p.query(
    `SELECT id FROM story_arcs WHERE chat_id = $1 AND title = $2`,
    [chatId, title],
  );
  let arcId;
  if (existing.length > 0) {
    arcId = existing[0].id;
    await p.query(
      `UPDATE story_arcs SET description = $2, arc_type = $3, status = $4, importance = $5, end_msg_idx = $6, spine_event_id = COALESCE($7, spine_event_id), updated_at = NOW() WHERE id = $1`,
      [arcId, description || "", arcType || "main", status || "active", importance || 3, endMsgIdx, spineEventId],
    );
  } else {
    arcId = `arc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await p.query(
      `INSERT INTO story_arcs (id, chat_id, title, description, arc_type, status, importance, start_msg_idx, end_msg_idx, spine_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [arcId, chatId, title, description || "", arcType || "main", status || "active", importance || 3, startMsgIdx, endMsgIdx, spineEventId],
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
  await p.query(
    `INSERT INTO plot_threads (id, chat_id, thread_type, title, description, involved_chars, planted_at, resolved_at, importance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       thread_type = EXCLUDED.thread_type,
       description = EXCLUDED.description,
       resolved_at = EXCLUDED.resolved_at,
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
  // ID is content-addressed by (name, chatId) so the same-named item in two
  // different chats gets two separate rows. This means OWNS edges never
  // bleed across chats even when the same character appears in both.
  const id = contentId("item", `${name}|${chatId || ""}`);
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
    [id, name, description || "", powers || "", significance || 3, ownerId, locationId, status || "intact", chatId || null],
  );
  return id;
}

// ── Vector operations ───────────────────────────────────────��──

async function storeEmbedding(settings, { chatId, nodeType, nodeId, content, embedding, characterScope, messageIndex, rawText }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO memory_embeddings (chat_id, node_type, node_id, content, embedding, character_scope, message_index, raw_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [chatId, nodeType, nodeId, content, JSON.stringify(embedding), characterScope || [], messageIndex || null, rawText || null],
  );
}

async function upsertMemoryEmbedding(settings, { chatId, nodeType, nodeId, content, embedding, characterScope, messageIndex, rawText, contextPrefix }) {
  const p = getPool(settings);
  // Dedupe by (chat_id, node_type, node_id) so re-ingest replaces rather than appends.
  await p.query(
    `DELETE FROM memory_embeddings WHERE chat_id = $1 AND node_type = $2 AND node_id = $3`,
    [chatId, nodeType, nodeId],
  );
  await p.query(
    `INSERT INTO memory_embeddings (chat_id, node_type, node_id, content, embedding, character_scope, message_index, raw_text, context_prefix)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [chatId, nodeType, nodeId, content, JSON.stringify(embedding), characterScope || [], messageIndex ?? null, rawText || null, contextPrefix || null],
  );
}

async function upsertDialogueQuote(settings, { chatId, sessionId, speaker, quote, messageIndex }) {
  const p = getPool(settings);
  const id = createHash("sha1")
    .update(`${chatId}|${messageIndex ?? ""}|${speaker}|${quote}`)
    .digest("hex")
    .slice(0, 16);
  await p.query(
    `INSERT INTO dialogue_quotes (id, chat_id, session_id, speaker, quote, message_index)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [id, chatId, sessionId || null, speaker, quote, messageIndex ?? null],
  );
  return id;
}

async function vectorSearch(settings, { embedding, chatId, limit, characterScope }) {
  const p = getPool(settings);
  const conditions = [];
  const params = [JSON.stringify(embedding), limit || 10];
  let idx = 3;

  if (chatId) { conditions.push(`chat_id = $${idx}`); params.push(chatId); idx++; }
  if (characterScope) { conditions.push(`character_scope && $${idx}::text[]`); params.push(characterScope); idx++; }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await p.query(
    `SELECT id, chat_id, node_type, node_id, content, COALESCE(raw_text, content) as raw_text,
            character_scope, message_index, context_prefix,
            1 - (embedding <=> $1::vector) as similarity
     FROM memory_embeddings ${where}
     ORDER BY embedding <=> $1::vector LIMIT $2`,
    params,
  );
  return rows;
}

async function vectorSearchScoped(settings, { embedding, chatIds, limit }) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT id, chat_id, node_type, node_id, content, COALESCE(raw_text, content) as raw_text,
            character_scope, message_index, context_prefix,
            1 - (embedding <=> $1::vector) as similarity
     FROM memory_embeddings
     WHERE chat_id = ANY($3::text[])
     ORDER BY embedding <=> $1::vector LIMIT $2`,
    [JSON.stringify(embedding), limit || 10, chatIds],
  );
  return rows;
}

/**
 * PostgreSQL full-text lexical search on memory_embeddings.
 * Uses the GENERATED tsv column + GIN index. Returns rows ordered
 * by ts_rank descending. chatIds may be an array (scoped) or a
 * single string; if falsy, searches globally.
 *
 * Uses OR semantics via `buildOrTsquery` (from shared/ts-query.js).
 * Aligned with the eval-side lexical search so ST retrieval recall
 * matches what the eval harness measures — see REVIEW §2a. Previously
 * used `plainto_tsquery` (AND), which was ~30% less recall on multi-
 * term queries like "what did X say about Y".
 *
 * Kept in db.js as a standalone entry point even though the canonical
 * retrieval pipeline in retriever.js now goes through shared/retrieval-
 * core.js directly. Retained for db.hybridSearch legacy callers and
 * for the test suite.
 */
async function lexicalSearch(settings, { query, chatId, chatIds, limit }) {
  const p = getPool(settings);
  const tsquery = buildOrTsquery(query);
  if (!tsquery) return [];
  const scopedIds = Array.isArray(chatIds) && chatIds.length > 0
    ? chatIds
    : (chatId ? [chatId] : null);
  const conditions = ["tsv @@ to_tsquery('english', $1)"];
  const params = [tsquery, limit || 20];
  let idx = 3;
  if (scopedIds) {
    conditions.push(`chat_id = ANY($${idx}::text[])`);
    params.push(scopedIds);
    idx++;
  }
  const { rows } = await p.query(
    `SELECT id, chat_id, node_type, node_id, content, COALESCE(raw_text, content) as raw_text,
            character_scope, message_index, context_prefix,
            ts_headline('english', COALESCE(raw_text, content),
              to_tsquery('english', $1),
              'MaxWords=150, MinWords=30, MaxFragments=5, FragmentDelimiter=" ... "') as headline,
            ts_rank(tsv, to_tsquery('english', $1)) as rank
     FROM memory_embeddings
     WHERE ${conditions.join(" AND ")}
     ORDER BY rank DESC
     LIMIT $2`,
    params,
  );
  return rows;
}

/**
 * Hybrid vector + lexical search fused via Reciprocal Rank Fusion.
 * RRF formula: score = sum(1 / (k + rank)) across result lists, where
 * `rank` is the 1-indexed position in each list and k=60 (standard).
 * Overfetches each source by ~3× to give fusion material to work with.
 */
async function hybridSearch(settings, { embedding, query, chatId, chatIds, limit, characterScope }) {
  const k = 60; // RRF constant
  const finalLimit = limit || 8;
  const fetchSize = finalLimit * 3;

  const scopedIds = Array.isArray(chatIds) && chatIds.length > 0
    ? chatIds
    : (chatId ? [chatId] : null);

  const vectorPromise = scopedIds
    ? vectorSearchScoped(settings, { embedding, chatIds: scopedIds, limit: fetchSize })
    : vectorSearch(settings, { embedding, limit: fetchSize, characterScope });

  const [vectorResults, lexicalResults] = await Promise.all([
    vectorPromise,
    lexicalSearch(settings, { query, chatIds: scopedIds, limit: fetchSize }),
  ]);

  const scores = new Map(); // id → { score, item }
  vectorResults.forEach((r, i) => {
    const s = 1 / (k + i + 1);
    scores.set(r.id, { score: s, item: r });
  });
  lexicalResults.forEach((r, i) => {
    const s = 1 / (k + i + 1);
    if (scores.has(r.id)) {
      const existing = scores.get(r.id);
      existing.score += s;
      if (r.headline && !existing.item.headline) existing.item.headline = r.headline;
    } else {
      scores.set(r.id, { score: s, item: r });
    }
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, finalLimit)
    .map((x) => x.item);
}

// ── Query helpers for retrieval ────────────────────────────────

async function getRelationships(settings, characters, chatIds) {
  const p = getPool(settings);
  const charIds = characters.map(slugify);
  const scoped = Array.isArray(chatIds) && chatIds.length > 0;
  const params = scoped ? [charIds, chatIds] : [charIds];
  const sessionFilter = scoped ? ` AND fa.session_id = ANY($2::text[])` : "";
  const { rows } = await p.query(
    `SELECT c1.name as from_name, c2.name as to_name,
            fa.sentiment, fa.intensity, fa.description
     FROM feels_about fa
     JOIN characters c1 ON fa.from_char = c1.id
     JOIN characters c2 ON fa.to_char = c2.id
     WHERE (fa.from_char = ANY($1::text[]) OR fa.to_char = ANY($1::text[]))${sessionFilter}`,
    params,
  );
  return rows.map((r) => ({
    from: r.from_name, to: r.to_name,
    sentiment: r.sentiment, intensity: r.intensity,
    description: r.description,
  }));
}

async function getKnowledgeBoundaries(settings, characters, chatIds) {
  // Two queries total (not 2*N) — REVIEW §5a N+1 collapse.
  // Scope facts by chat via memory_embeddings.chat_id when chatIds is
  // provided so e.g. ChatB's secrets don't leak into Protagonist's retrieval.
  // Lorebook facts (worldbuilding/setting/background) are intentionally
  // excluded from the "doesNotKnow" set and remain globally visible via
  // their own retrieval path — 'lore' domain is left off.
  if (!characters || characters.length === 0) return [];
  const p = getPool(settings);
  const scoped = Array.isArray(chatIds) && chatIds.length > 0;
  const charIds = characters.map(slugify);
  const nameById = new Map();
  characters.forEach((n, i) => nameById.set(charIds[i], n));

  // `known` — one query, all characters, chat-scoped via the facts'
  // embedding rows. Returns character_id + content; group in JS.
  const knownChatFilter = scoped
    ? ` AND f.id IN (SELECT node_id FROM memory_embeddings WHERE node_type = 'fact' AND chat_id = ANY($2::text[]))`
    : "";
  const knownParams = scoped ? [charIds, chatIds] : [charIds];
  const { rows: knownRows } = await p.query(
    `SELECT DISTINCT k.character_id, f.content
     FROM knows k JOIN facts f ON k.fact_id = f.id
     WHERE k.character_id = ANY($1::text[])${knownChatFilter}`,
    knownParams,
  );

  // `doesNotKnow` — one query; cross product of the character list and
  // secret/backstory facts, minus what's already in `knows`. UNNEST gives
  // us one row per (character × fact) in-SQL; the anti-join is indexed.
  const unknownChatFilter = scoped
    ? ` AND f.id IN (SELECT node_id FROM memory_embeddings WHERE node_type = 'fact' AND chat_id = ANY($2::text[]))`
    : "";
  const { rows: unknownRows } = await p.query(
    `SELECT c_param AS character_id, f.content
     FROM UNNEST($1::text[]) AS c_param
     CROSS JOIN facts f
     WHERE f.domain IN ('secret', 'backstory')
       AND NOT EXISTS (
         SELECT 1 FROM knows k WHERE k.character_id = c_param AND k.fact_id = f.id
       )${unknownChatFilter}`,
    knownParams,
  );

  const knownByChar = new Map();
  for (const r of knownRows) {
    let arr = knownByChar.get(r.character_id);
    if (!arr) { arr = []; knownByChar.set(r.character_id, arr); }
    arr.push(r.content);
  }
  const unknownByChar = new Map();
  for (const r of unknownRows) {
    let arr = unknownByChar.get(r.character_id);
    if (!arr) { arr = []; unknownByChar.set(r.character_id, arr); }
    arr.push(r.content);
  }

  return charIds.map((cid) => ({
    character: nameById.get(cid),
    knows: knownByChar.get(cid) || [],
    doesNotKnow: unknownByChar.get(cid) || [],
  }));
}

async function getRecentEvents(settings, chatId, limit, chatIds) {
  const p = getPool(settings);
  // Build chat-scope filter. Prefer the explicit chatIds list if provided,
  // otherwise fall back to the single chatId. If neither is set we return
  // events globally (legacy behavior — only happens when callers haven't
  // been migrated yet).
  const scopeIds = (Array.isArray(chatIds) && chatIds.length > 0)
    ? chatIds
    : (chatId ? [chatId] : null);
  const params = scopeIds ? [limit || 5, scopeIds] : [limit || 5];
  const where = scopeIds ? `WHERE e.chat_id = ANY($2::text[])` : "";
  const { rows } = await p.query(
    `SELECT e.summary, e.source_text, e.significance, e.timestamp, e.message_index,
            array_agg(c.name) as participants
     FROM events e
     LEFT JOIN participated_in pi ON e.id = pi.event_id
     LEFT JOIN characters c ON pi.character_id = c.id
     ${where}
     GROUP BY e.id ORDER BY e.timestamp DESC LIMIT $1`,
    params,
  );
  return rows;
}

async function getWorldState(settings, chatIds) {
  const p = getPool(settings);
  const scoped = Array.isArray(chatIds) && chatIds.length > 0;
  // Legacy world_state rows lack chat_id (upsertWorldState only started
  // writing it after this was flagged). NULL chat_id is treated as global
  // so pre-fix data remains visible. Cap at 20 newest so a runaway
  // extraction can't eat the entire token budget.
  const sql = scoped
    ? `SELECT key, value, valid_from as since FROM world_state
       WHERE valid_until IS NULL AND (chat_id = ANY($1::text[]) OR chat_id IS NULL)
       ORDER BY valid_from DESC
       LIMIT 20`
    : `SELECT key, value, valid_from as since FROM world_state
       WHERE valid_until IS NULL
       ORDER BY valid_from DESC
       LIMIT 20`;
  const { rows } = await p.query(sql, scoped ? [chatIds] : []);
  return rows;
}

/**
 * N-hop recursive traversal from a starting character.
 * Finds all connected entities within `depth` hops through any edge type.
 */
async function traverseFromCharacter(settings, characterName, depth = 3, overrideChatIds) {
  const p = getPool(settings);
  const startId = slugify(characterName);

  // If the caller provided an explicit chat scope (e.g. the mindmap is
  // filtering to the current chat), use it directly. Otherwise fall back to
  // discovering every chat this character has appeared in, which is the
  // "show me everything about X" behavior the standalone mindmap page wants.
  let chatIds;
  if (Array.isArray(overrideChatIds) && overrideChatIds.length > 0) {
    chatIds = overrideChatIds;
  } else {
    const { rows: chats } = await p.query(
      `SELECT chat_file FROM ingestion_status WHERE character_name = $1 AND status = 'done'`,
      [characterName],
    );
    chatIds = chats.map((c) => c.chat_file.replace(".jsonl", ""));

    // Fallback: find session_ids that start with the character name
    // (ST chat files are named "Character Name - date.jsonl")
    if (chatIds.length === 0) {
      const { rows: sessions } = await p.query(
        `SELECT DISTINCT session_id FROM feels_about WHERE session_id LIKE $1
         UNION
         SELECT DISTINCT chat_id FROM events WHERE chat_id LIKE $1`,
        [`${characterName}%`],
      );
      chatIds = sessions.map((s) => s.session_id).filter(Boolean);
    }
  }

  if (chatIds.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Recursive CTE: walk through edges scoped to this character's chats
  const { rows } = await p.query(`
    WITH RECURSIVE
    all_edges AS (
      -- Character relationships
      SELECT from_char as src, 'character'::text as src_type, to_char as dst, 'character'::text as dst_type
      FROM feels_about WHERE session_id = ANY($3)
      UNION ALL
      SELECT to_char, 'character', from_char, 'character'
      FROM feels_about WHERE session_id = ANY($3)
      UNION ALL
      -- Character knows facts (chat-scoped via knows.chat_id)
      SELECT k.character_id, 'character', k.fact_id, 'fact'
      FROM knows k WHERE k.chat_id = ANY($3)
      UNION ALL
      -- Character participated in events (from this char's chats)
      SELECT pi.character_id, 'character', pi.event_id, 'event'
      FROM participated_in pi
      JOIN events e ON e.id = pi.event_id WHERE e.chat_id = ANY($3)
      UNION ALL
      SELECT pi.event_id, 'event', pi.character_id, 'character'
      FROM participated_in pi
      JOIN events e ON e.id = pi.event_id WHERE e.chat_id = ANY($3)
      UNION ALL
      -- Events at locations
      SELECT e.id, 'event', e.location_id, 'location'
      FROM events e WHERE e.chat_id = ANY($3) AND e.location_id IS NOT NULL
      UNION ALL
      -- Characters own items (chat-scoped via items.chat_id)
      SELECT i.owner_id, 'character', i.id, 'item'
      FROM items i WHERE i.owner_id IS NOT NULL AND i.chat_id = ANY($3)
      UNION ALL
      -- Items at locations (chat-scoped)
      SELECT i.id, 'item', i.location_id, 'location'
      FROM items i WHERE i.location_id IS NOT NULL AND i.chat_id = ANY($3)
      UNION ALL
      -- Characters involved in plot threads
      SELECT ptc.character_id, 'character', ptc.plot_id, 'plot_thread'
      FROM plot_thread_characters ptc
      JOIN plot_threads pt ON pt.id = ptc.plot_id WHERE pt.chat_id = ANY($3)
      UNION ALL
      -- Events in story arcs
      SELECT ae.event_id, 'event', ae.arc_id, 'story_arc'
      FROM arc_events ae
      JOIN story_arcs sa ON sa.id = ae.arc_id WHERE sa.chat_id = ANY($3)
      UNION ALL
      SELECT ae.arc_id, 'story_arc', ae.event_id, 'event'
      FROM arc_events ae
      JOIN story_arcs sa ON sa.id = ae.arc_id WHERE sa.chat_id = ANY($3)
      UNION ALL
      -- Event causal chains
      SELECT ec.from_event_id, 'event', ec.to_event_id, 'event'
      FROM event_chains ec
      JOIN events e1 ON e1.id = ec.from_event_id
      WHERE e1.chat_id = ANY($3)
    ),
    graph_walk AS (
      SELECT $1::text as node_id, 'character'::text as node_type, 0 as hop
      UNION
      SELECT ae.dst, ae.dst_type, gw.hop + 1
      FROM graph_walk gw
      JOIN all_edges ae ON ae.src = gw.node_id AND ae.src_type = gw.node_type
      WHERE gw.hop < $2
    )
    SELECT DISTINCT node_id, node_type, min(hop) as hop
    FROM graph_walk
    GROUP BY node_id, node_type
    ORDER BY hop, node_type
  `, [startId, depth, chatIds]);

  // Hydrate the node IDs into full objects
  const nodes = [];
  const charIds = rows.filter((r) => r.node_type === "character").map((r) => r.node_id);
  const factIds = rows.filter((r) => r.node_type === "fact").map((r) => r.node_id);
  const eventIds = rows.filter((r) => r.node_type === "event").map((r) => r.node_id);
  const locIds = rows.filter((r) => r.node_type === "location").map((r) => r.node_id);
  const itemIds = rows.filter((r) => r.node_type === "item").map((r) => r.node_id);
  const plotIds = rows.filter((r) => r.node_type === "plot_thread").map((r) => r.node_id);
  const arcIds = rows.filter((r) => r.node_type === "story_arc").map((r) => r.node_id);

  if (charIds.length > 0) {
    const { rows: chars } = await p.query(`SELECT * FROM characters WHERE id = ANY($1)`, [charIds]);
    for (const c of chars) nodes.push({ id: c.id, label: c.name, type: "character", metadata: c });
  }
  if (factIds.length > 0) {
    const { rows: fs } = await p.query(`SELECT * FROM facts WHERE id = ANY($1)`, [factIds]);
    for (const f of fs) nodes.push({ id: f.id, label: (f.content || "").slice(0, 60), type: "fact", metadata: f });
  }
  if (eventIds.length > 0) {
    const { rows: es } = await p.query(`SELECT * FROM events WHERE id = ANY($1)`, [eventIds]);
    for (const e of es) nodes.push({ id: e.id, label: (e.summary || "").slice(0, 60), type: "event", metadata: e });
  }
  if (locIds.length > 0) {
    const { rows: ls } = await p.query(`SELECT * FROM locations WHERE id = ANY($1)`, [locIds]);
    for (const l of ls) nodes.push({ id: l.id, label: l.name, type: "location", metadata: l });
  }
  if (itemIds.length > 0) {
    const { rows: its } = await p.query(`SELECT * FROM items WHERE id = ANY($1)`, [itemIds]);
    for (const i of its) nodes.push({ id: i.id, label: i.name, type: "item", metadata: i });
  }
  if (plotIds.length > 0) {
    const { rows: pts } = await p.query(`SELECT * FROM plot_threads WHERE id = ANY($1)`, [plotIds]);
    for (const pt of pts) nodes.push({ id: pt.id, label: pt.title, type: "plot_thread", metadata: pt });
  }
  if (arcIds.length > 0) {
    const { rows: arcs } = await p.query(`SELECT * FROM story_arcs WHERE id = ANY($1)`, [arcIds]);
    for (const arc of arcs) nodes.push({ id: arc.id, label: arc.title, type: "story_arc", metadata: arc });
  }

  // Get edges between discovered nodes — scoped to this character's chats
  const edges = [];

  if (charIds.length > 0) {
    const { rows: rels } = await p.query(
      `SELECT from_char as source, to_char as target, sentiment, intensity, description
       FROM feels_about
       WHERE from_char = ANY($1) AND to_char = ANY($1) AND session_id = ANY($2)`,
      [charIds, chatIds],
    );
    for (const r of rels) {
      edges.push({ id: `fa-${r.source}-${r.target}`, source: r.source, target: r.target,
        type: "FEELS_ABOUT", label: r.description || "",
        sentiment: parseFloat(r.sentiment) || 0, intensity: parseFloat(r.intensity) || 0.5 });
    }
  }

  if (charIds.length > 0 && factIds.length > 0) {
    const { rows: kn } = await p.query(
      `SELECT character_id, fact_id FROM knows WHERE character_id = ANY($1) AND fact_id = ANY($2)`,
      [charIds, factIds],
    );
    for (const k of kn) {
      edges.push({ id: `kn-${k.character_id}-${k.fact_id}`, source: k.character_id, target: k.fact_id,
        type: "KNOWS", label: "knows", sentiment: 0, intensity: 0.3 });
    }
  }

  if (charIds.length > 0 && eventIds.length > 0) {
    const { rows: partRows } = await p.query(
      `SELECT pi.character_id, pi.event_id, pi.role
       FROM participated_in pi
       JOIN events e ON e.id = pi.event_id
       WHERE pi.character_id = ANY($1) AND pi.event_id = ANY($2) AND e.chat_id = ANY($3)`,
      [charIds, eventIds, chatIds],
    );
    for (const pr of partRows) {
      edges.push({ id: `pi-${pr.character_id}-${pr.event_id}`, source: pr.character_id, target: pr.event_id,
        type: "PARTICIPATED_IN", label: pr.role || "participated", sentiment: 0, intensity: 0.5 });
    }
  }

  // Event location edges
  if (eventIds.length > 0 && locIds.length > 0) {
    const { rows: elocs } = await p.query(
      `SELECT id, location_id FROM events WHERE id = ANY($1) AND location_id = ANY($2)`,
      [eventIds, locIds],
    );
    for (const e of elocs) {
      edges.push({ id: `at-${e.id}-${e.location_id}`, source: e.id, target: e.location_id,
        type: "OCCURRED_AT", label: "at", sentiment: 0, intensity: 0.3 });
    }
  }

  // Item ownership
  if (itemIds.length > 0) {
    const { rows: its } = await p.query(
      `SELECT id, owner_id, location_id FROM items WHERE id = ANY($1)`, [itemIds],
    );
    for (const it of its) {
      if (it.owner_id) edges.push({ id: `own-${it.owner_id}-${it.id}`, source: it.owner_id, target: it.id,
        type: "OWNS", label: "owns", sentiment: 0, intensity: 0.4 });
      if (it.location_id) edges.push({ id: `at-${it.id}-${it.location_id}`, source: it.id, target: it.location_id,
        type: "LOCATED_AT", label: "located at", sentiment: 0, intensity: 0.3 });
    }
  }

  // Plot thread links
  if (plotIds.length > 0 && charIds.length > 0) {
    const { rows: pts } = await p.query(
      `SELECT plot_id, character_id FROM plot_thread_characters WHERE plot_id = ANY($1) AND character_id = ANY($2)`,
      [plotIds, charIds],
    );
    for (const pt of pts) {
      edges.push({ id: `pt-${pt.character_id}-${pt.plot_id}`, source: pt.character_id, target: pt.plot_id,
        type: "INVOLVED_IN", label: "involved in", sentiment: 0, intensity: 0.4 });
    }
  }

  // Arc containment
  if (arcIds.length > 0 && eventIds.length > 0) {
    const { rows: aes } = await p.query(
      `SELECT arc_id, event_id, is_anchor FROM arc_events WHERE arc_id = ANY($1) AND event_id = ANY($2)`,
      [arcIds, eventIds],
    );
    for (const ae of aes) {
      edges.push({ id: `ae-${ae.arc_id}-${ae.event_id}`, source: ae.arc_id, target: ae.event_id,
        type: "CONTAINS_EVENT", label: ae.is_anchor ? "anchor" : "contains",
        sentiment: 0, intensity: ae.is_anchor ? 0.9 : 0.5, isAnchor: ae.is_anchor });
    }
  }

  // Event chains
  if (eventIds.length > 0) {
    const { rows: chs } = await p.query(
      `SELECT ec.from_event_id, ec.to_event_id, ec.chain_type, ec.description
       FROM event_chains ec
       JOIN events e ON e.id = ec.from_event_id
       WHERE ec.from_event_id = ANY($1) AND ec.to_event_id = ANY($1) AND e.chat_id = ANY($2)`,
      [eventIds, chatIds],
    );
    for (const c of chs) {
      edges.push({ id: `ch-${c.from_event_id}-${c.to_event_id}`, source: c.from_event_id, target: c.to_event_id,
        type: "CAUSED", label: c.chain_type || "caused", description: c.description,
        sentiment: 0, intensity: 0.7 });
    }
  }

  return { nodes, edges };
}

async function getGraphData(settings, { scope, character, chatIds }) {
  const p = getPool(settings);
  const nodes = [];
  const edges = [];
  const connectedIds = new Set();

  // When chatIds is provided, every edge query is filtered by chat scope.
  // Tables that carry chat id directly: events.chat_id, feels_about.session_id,
  // plot_threads.chat_id, story_arcs.chat_id. Tables without one (participated_in,
  // plot_thread_characters, arc_events, event_chains, items) are scoped
  // indirectly by joining an in-scope table and only keeping rows whose
  // foreign ids are in the resulting set.
  const scoped = Array.isArray(chatIds) && chatIds.length > 0;

  // feels_about: direct scope via session_id
  const relsSql = scoped
    ? `SELECT from_char, to_char, sentiment, intensity, description
       FROM feels_about WHERE session_id = ANY($1::text[])`
    : `SELECT from_char, to_char, sentiment, intensity, description FROM feels_about`;
  const relsParams = scoped ? [chatIds] : [];
  const { rows: rels } = await p.query(relsSql, relsParams);
  for (const r of rels) {
    connectedIds.add(r.from_char);
    connectedIds.add(r.to_char);
    edges.push({
      id: `fa-${r.from_char}-${r.to_char}`,
      source: r.from_char, target: r.to_char,
      type: "FEELS_ABOUT", label: (r.description || "").slice(0, 60),
      sentiment: parseFloat(r.sentiment) || 0,
      intensity: parseFloat(r.intensity) || 0.5,
    });
  }

  // Collect the set of in-scope event ids once so every edge type keyed on
  // event_id can filter against it without an extra round-trip per query.
  let inScopeEventIds = null;
  if (scoped) {
    const { rows: evs } = await p.query(
      `SELECT id FROM events WHERE chat_id = ANY($1::text[])`,
      [chatIds],
    );
    inScopeEventIds = new Set(evs.map((r) => r.id));
  }
  const eventInScope = (id) => !scoped || inScopeEventIds.has(id);

  // participated_in: scope indirectly via events.chat_id join
  const partsSql = scoped
    ? `SELECT pi.character_id, pi.event_id, pi.role
       FROM participated_in pi
       JOIN events e ON e.id = pi.event_id
       WHERE e.chat_id = ANY($1::text[])`
    : `SELECT character_id, event_id, role FROM participated_in`;
  const { rows: parts } = await p.query(partsSql, scoped ? [chatIds] : []);
  for (const pi of parts) {
    connectedIds.add(pi.character_id);
    connectedIds.add(pi.event_id);
    edges.push({
      id: `pi-${pi.character_id}-${pi.event_id}`,
      source: pi.character_id, target: pi.event_id,
      type: "PARTICIPATED_IN", label: pi.role || "participated",
      sentiment: 0, intensity: 0.5,
    });
  }

  // Items: directly scoped by chat_id. Legacy rows with NULL chat_id are
  // dropped under scoped mode (same pattern as feels_about.session_id).
  // Unscoped mode keeps the old behavior of showing everything with an
  // owner/location regardless of chat.
  const itemSql = scoped
    ? `SELECT id, name, owner_id, location_id FROM items
       WHERE chat_id = ANY($1::text[])
         AND (owner_id IS NOT NULL OR location_id IS NOT NULL)`
    : `SELECT id, name, owner_id, location_id FROM items
       WHERE owner_id IS NOT NULL OR location_id IS NOT NULL`;
  const { rows: itemOwners } = await p.query(itemSql, scoped ? [chatIds] : []);
  for (const it of itemOwners) {
    connectedIds.add(it.id);
    if (it.owner_id) {
      connectedIds.add(it.owner_id);
      edges.push({
        id: `own-${it.owner_id}-${it.id}`,
        source: it.owner_id, target: it.id,
        type: "OWNS", label: "owns",
        sentiment: 0, intensity: 0.4,
      });
    }
    if (it.location_id) {
      connectedIds.add(it.location_id);
      edges.push({
        id: `at-${it.id}-${it.location_id}`,
        source: it.id, target: it.location_id,
        type: "LOCATED_AT", label: "located at",
        sentiment: 0, intensity: 0.3,
      });
    }
  }

  // Events at locations: directly scoped by events.chat_id
  const evtLocSql = scoped
    ? `SELECT id, location_id FROM events
       WHERE location_id IS NOT NULL AND chat_id = ANY($1::text[])`
    : `SELECT id, location_id FROM events WHERE location_id IS NOT NULL`;
  const { rows: evtLocs } = await p.query(evtLocSql, scoped ? [chatIds] : []);
  for (const e of evtLocs) {
    connectedIds.add(e.id);
    connectedIds.add(e.location_id);
    edges.push({
      id: `at-${e.id}-${e.location_id}`,
      source: e.id, target: e.location_id,
      type: "OCCURRED_AT", label: "at",
      sentiment: 0, intensity: 0.3,
    });
  }

  // Plot thread characters: plot_threads has chat_id so join to it
  const plotSql = scoped
    ? `SELECT ptc.plot_id, ptc.character_id
       FROM plot_thread_characters ptc
       JOIN plot_threads pt ON pt.id = ptc.plot_id
       WHERE pt.chat_id = ANY($1::text[])`
    : `SELECT plot_id, character_id FROM plot_thread_characters`;
  const { rows: plotChars } = await p.query(plotSql, scoped ? [chatIds] : []);
  for (const pc of plotChars) {
    connectedIds.add(pc.plot_id);
    connectedIds.add(pc.character_id);
    edges.push({
      id: `pt-${pc.character_id}-${pc.plot_id}`,
      source: pc.character_id, target: pc.plot_id,
      type: "INVOLVED_IN", label: "involved in",
      sentiment: 0, intensity: 0.4,
    });
  }

  // Story arc events: story_arcs has chat_id
  const arcSql = scoped
    ? `SELECT ae.arc_id, ae.event_id, ae.is_anchor
       FROM arc_events ae
       JOIN story_arcs sa ON sa.id = ae.arc_id
       WHERE sa.chat_id = ANY($1::text[])`
    : `SELECT ae.arc_id, ae.event_id, ae.is_anchor FROM arc_events ae`;
  const { rows: arcEvents } = await p.query(arcSql, scoped ? [chatIds] : []);
  for (const ae of arcEvents) {
    connectedIds.add(ae.arc_id);
    connectedIds.add(ae.event_id);
    edges.push({
      id: `ae-${ae.arc_id}-${ae.event_id}`,
      source: ae.arc_id, target: ae.event_id,
      type: "CONTAINS_EVENT",
      label: ae.is_anchor ? "anchor event" : "contains",
      sentiment: 0, intensity: ae.is_anchor ? 0.9 : 0.5,
      isAnchor: ae.is_anchor,
    });
  }

  // Event chains: scope by requiring both endpoints to be in-scope events.
  const { rows: chains } = await p.query(
    `SELECT from_event_id, to_event_id, chain_type, description FROM event_chains`,
  );
  for (const c of chains) {
    if (!eventInScope(c.from_event_id) || !eventInScope(c.to_event_id)) continue;
    connectedIds.add(c.from_event_id);
    connectedIds.add(c.to_event_id);
    edges.push({
      id: `ch-${c.from_event_id}-${c.to_event_id}`,
      source: c.from_event_id, target: c.to_event_id,
      type: "CAUSED", label: c.chain_type || "caused",
      description: c.description,
      sentiment: 0, intensity: 0.7,
    });
  }

  // Hydrate all nodes
  if (connectedIds.size > 0) {
    const idArray = [...connectedIds];

    const { rows: chars } = await p.query(`SELECT * FROM characters WHERE id = ANY($1)`, [idArray]);
    for (const c of chars) nodes.push({ id: c.id, label: c.name, type: "character", metadata: c });

    const { rows: locs } = await p.query(`SELECT * FROM locations WHERE id = ANY($1)`, [idArray]);
    for (const l of locs) nodes.push({ id: l.id, label: l.name, type: "location", metadata: l });

    const { rows: evts } = await p.query(`SELECT * FROM events WHERE id = ANY($1)`, [idArray]);
    for (const e of evts) nodes.push({ id: e.id, label: (e.summary || "").slice(0, 60), type: "event", metadata: e });

    const { rows: its } = await p.query(`SELECT * FROM items WHERE id = ANY($1)`, [idArray]);
    for (const i of its) nodes.push({ id: i.id, label: i.name, type: "item", metadata: i });

    const { rows: pts } = await p.query(`SELECT * FROM plot_threads WHERE id = ANY($1)`, [idArray]);
    for (const pt of pts) nodes.push({ id: pt.id, label: pt.title, type: "plot_thread", metadata: pt });

    const { rows: arcs } = await p.query(`SELECT * FROM story_arcs WHERE id = ANY($1)`, [idArray]);
    for (const arc of arcs) nodes.push({ id: arc.id, label: arc.title, type: "story_arc", metadata: arc });
  }

  return { nodes, edges };
}

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

// ── Character panel queries ────────────────────────────────────

async function getCharacterPanelStats(settings, characterName, chatId) {
  const p = getPool(settings);
  const charId = slugify(characterName);
  // When chatId is provided, every count is scoped to that chat. traits.source_chat
  // and feels_about.session_id carry chat scope directly; participated_in is
  // scoped via events.chat_id join. Legacy rows with NULL chat are dropped
  // under scoped mode — they're cross-chat contamination from the old
  // pipeline and surfacing them is exactly what the user reported.
  if (chatId) {
    const { rows } = await p.query(
      `SELECT
         (SELECT COUNT(*) FROM participated_in pi
            JOIN events e ON e.id = pi.event_id
            WHERE pi.character_id = $1 AND e.chat_id = $2)::int AS events,
         (SELECT COUNT(*) FROM traits
            WHERE character_id = $1 AND source_chat = $2
              AND canonical_id IS NULL)::int AS traits,
         (SELECT COUNT(*) FROM feels_about
            WHERE (from_char = $1 OR to_char = $1) AND session_id = $2)::int AS relationships,
         (SELECT MAX(e.message_index) FROM events e
            JOIN participated_in pi ON pi.event_id = e.id
            WHERE pi.character_id = $1 AND e.chat_id = $2) AS last_seen_turn`,
      [charId, chatId],
    );
    const r = rows[0] || {};
    return {
      events: r.events || 0,
      traits: r.traits || 0,
      relationships: r.relationships || 0,
      lastSeenTurn: r.last_seen_turn == null ? null : Number(r.last_seen_turn),
    };
  }
  const { rows } = await p.query(
    `SELECT
       (SELECT COUNT(*) FROM participated_in WHERE character_id = $1)::int AS events,
       (SELECT COUNT(*) FROM traits
          WHERE character_id = $1 AND canonical_id IS NULL)::int AS traits,
       (SELECT COUNT(*) FROM feels_about WHERE from_char = $1 OR to_char = $1)::int AS relationships,
       (SELECT MAX(e.message_index) FROM events e
          JOIN participated_in pi ON pi.event_id = e.id
          WHERE pi.character_id = $1) AS last_seen_turn`,
    [charId],
  );
  const r = rows[0] || {};
  return {
    events: r.events || 0,
    traits: r.traits || 0,
    relationships: r.relationships || 0,
    lastSeenTurn: r.last_seen_turn == null ? null : Number(r.last_seen_turn),
  };
}

async function getCharacterRecentEvents(settings, characterName, limit, chatId) {
  const p = getPool(settings);
  const charId = slugify(characterName);
  const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 5));
  const sql = chatId
    ? `SELECT e.id, e.summary, e.source_text, e.message_index, e.significance, e.chat_id
       FROM events e
       JOIN participated_in pi ON pi.event_id = e.id
       WHERE pi.character_id = $1 AND e.chat_id = $3
       ORDER BY e.message_index DESC NULLS LAST, e.timestamp DESC
       LIMIT $2`
    : `SELECT e.id, e.summary, e.source_text, e.message_index, e.significance, e.chat_id
       FROM events e
       JOIN participated_in pi ON pi.event_id = e.id
       WHERE pi.character_id = $1
       ORDER BY e.message_index DESC NULLS LAST, e.timestamp DESC
       LIMIT $2`;
  const params = chatId ? [charId, lim, chatId] : [charId, lim];
  const { rows } = await p.query(sql, params);
  return rows.map((r) => ({
    id: r.id,
    summary: r.summary,
    sourceText: r.source_text || "",
    messageIndex: r.message_index,
    significance: r.significance,
    chatId: r.chat_id,
  }));
}

async function getCharacterOutboundRelationships(settings, characterName, chatId) {
  const p = getPool(settings);
  const charId = slugify(characterName);
  // When scoped, pin directly to the session_id so only this-chat feelings
  // show. Unscoped still collapses via DISTINCT ON so the panel stays
  // compact across multi-chat characters.
  if (chatId) {
    const { rows } = await p.query(
      `SELECT c.name AS to_name, f.sentiment, f.intensity, f.description, f.updated_at
       FROM feels_about f
       JOIN characters c ON c.id = f.to_char
       WHERE f.from_char = $1 AND f.session_id = $2
       ORDER BY f.updated_at DESC`,
      [charId, chatId],
    );
    return rows.map((r) => ({
      toName: r.to_name,
      sentiment: Number(r.sentiment) || 0,
      intensity: Number(r.intensity) || 0,
      description: r.description || "",
    }));
  }
  const { rows } = await p.query(
    `SELECT DISTINCT ON (f.to_char)
            c.name AS to_name, f.sentiment, f.intensity, f.description, f.updated_at
     FROM feels_about f
     JOIN characters c ON c.id = f.to_char
     WHERE f.from_char = $1
     ORDER BY f.to_char, f.updated_at DESC`,
    [charId],
  );
  return rows.map((r) => ({
    toName: r.to_name,
    sentiment: Number(r.sentiment) || 0,
    intensity: Number(r.intensity) || 0,
    description: r.description || "",
  }));
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
  getPool, initSchema, slugify,
  upsertCharacter, findCharacterByNameOrAlias, upsertLocation, upsertRelationship, upsertEvent, upsertFact, upsertWorldState,
  upsertTrait, classifyDisposition, getTraitsForCharacter, recomputeCharacterSummary,
  insertContextSnapshot, getRecentSnapshots,
  upsertPlotThread, getActivePlotThreads, upsertItem,
  upsertStoryArc, linkEventToArc, createEventChain,
  storeEmbedding, upsertMemoryEmbedding, upsertDialogueQuote, vectorSearch, vectorSearchScoped, lexicalSearch, hybridSearch,
  getRelationships, getKnowledgeBoundaries, getRecentEvents, getWorldState,
  getGraphData, traverseFromCharacter, getCharacterMemoryConfig, saveCharacterMemoryConfig,
  getCharacterPanelStats, getCharacterRecentEvents, getCharacterOutboundRelationships, clearCharacterMemories,
  closePool,
};
