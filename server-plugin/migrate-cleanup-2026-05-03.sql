-- =============================================================================
-- One-shot data cleanup for the bugs fixed in this commit:
--
--   (a) Pre-fix upsertCharacter wrote to legacy global character rows
--       (chat_id IS NULL) when a chat-scoped row didn't exist yet, then
--       kept reusing the global row across every subsequent chat. Result:
--       one mega-row per recurring character (chr-alice had 254 trait
--       rows accumulated across ~30 unrelated roleplays).
--
--   (b) Pre-fix upsertWorldState used the LLM-emitted key verbatim, so
--       "Piper the Black status: dead" and "Piper the Black: dead" coexist
--       as parallel "current" rows. Snapshot-shaped state (boarding,
--       weather, ship motion) also accumulated forever because the LLM
--       only superseded keys when it re-emitted them with a different value.
--
-- This script is idempotent — safe to run multiple times. Read-only by
-- default: wrap in BEGIN; ... ROLLBACK; to dry-run, or BEGIN; ... COMMIT;
-- to apply. Print counts before each destructive op so the operator can
-- verify the blast radius.
--
-- Run with:
--   psql -h localhost -U samantha -d chronicledb -f migrate-cleanup-2026-05-03.sql
--
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- -----------------------------------------------------------------------------
-- (a) Quarantine global character rows so the new chat-scoped writes start
--     fresh. We don't DELETE — we move them to a status='archived' state and
--     blank their aliases array, so:
--       - Future upsertCharacter calls for the same name with a chatId will
--         create a brand-new chat-scoped row instead of matching the legacy
--         global one (we just dropped the OR-IS-NULL fallback in code, but
--         this also removes the risk that any read path joining on name
--         picks the polluted row up).
--       - Existing trait/event/relationship rows that reference the global
--         character_id remain queryable for historical/forensic purposes.
--       - The `aliases` array gets nulled so the cross-character pollution
--         guard in upsertCharacter never matches against it again.
-- -----------------------------------------------------------------------------

\echo '=== global character rows BEFORE cleanup ==='
SELECT id, name, chat_id, status,
       cardinality(COALESCE(aliases, '{}'::text[])) AS alias_count,
       (SELECT COUNT(*) FROM traits t WHERE t.character_id = c.id) AS trait_count
  FROM characters c
 WHERE chat_id IS NULL
 ORDER BY trait_count DESC NULLS LAST
 LIMIT 30;

\echo '=== quarantining global character rows ==='
UPDATE characters
   SET status  = 'archived-legacy-global-2026-05-03',
       aliases = '{}'::text[],
       updated_at = NOW()
 WHERE chat_id IS NULL
   AND status NOT LIKE 'archived-%';

-- -----------------------------------------------------------------------------
-- (b) Close stale snapshot-shaped world_state rows. These are
--     scene-moment facts (boarding, weather, ship motion, attack status,
--     cargo) that the extractor will re-emit when they change but doesn't
--     close when they end. Anything matching the snapshot prefixes whose
--     valid_from is more than 24h old gets closed; standing facts
--     (character roles, faction, knowledge) are NOT touched.
--
--     This is a one-time cleanup for the existing pollution. Going forward
--     the closeStaleSnapshotKeys() runtime sweep + world_state_supersede
--     LLM signal handle ongoing decay.
-- -----------------------------------------------------------------------------

\echo '=== stale snapshot-shaped world_state rows BEFORE cleanup ==='
SELECT chat_id, key, value, valid_from
  FROM world_state
 WHERE valid_until IS NULL
   AND valid_from < NOW() - INTERVAL '24 hours'
   AND (
        key ~ '^(boarding|weather|ship|cargo|scene|battle|pursuit|alarm)(_|$)'
        OR key ~ '_status$'
        OR key ~ '_state$'
       )
 ORDER BY chat_id, valid_from
 LIMIT 100;

\echo '=== closing stale snapshot-shaped rows ==='
UPDATE world_state
   SET valid_until = NOW()
 WHERE valid_until IS NULL
   AND valid_from < NOW() - INTERVAL '24 hours'
   AND (
        key ~ '^(boarding|weather|ship|cargo|scene|battle|pursuit|alarm)(_|$)'
        OR key ~ '_status$'
        OR key ~ '_state$'
       );

-- -----------------------------------------------------------------------------
-- (c) Collapse parallel world_state rows that differ only by canonical-key
--     normalization. After upsertWorldState started normalizing keys,
--     pre-existing rows like "Piper the Black status" and "Piper the Black"
--     both still exist as "current". Pick the most-recent row per
--     normalized-key group per chat and close the rest.
--
--     Normalization mirrors the JS helper in db.js: lowercase, possessive-s
--     stripped, non-word punctuation removed, whitespace/dash → underscore,
--     trailing _status/_state stripped.
-- -----------------------------------------------------------------------------

\echo '=== finding parallel-key world_state duplicates ==='

WITH normed AS (
  SELECT id, chat_id, key, value, valid_from,
         regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(lower(key), '[''']s\b', 's', 'g'),
                   '[^\w\s_-]', '', 'g'),
                 '[\s\-]+', '_', 'g'),
               '_(status|state)$', '', 'g'),
             '_+', '_', 'g'),
           '^_+|_+$', '', 'g'
         ) AS canonical_key
    FROM world_state
   WHERE valid_until IS NULL
),
ranked AS (
  SELECT id, chat_id, canonical_key, valid_from,
         row_number() OVER (
           PARTITION BY chat_id, canonical_key
           ORDER BY valid_from DESC, id DESC
         ) AS rn
    FROM normed
)
SELECT chat_id, canonical_key, COUNT(*) AS dup_count
  FROM ranked
 GROUP BY chat_id, canonical_key
HAVING COUNT(*) > 1
 ORDER BY dup_count DESC, chat_id
 LIMIT 40;

\echo '=== closing parallel duplicates (keeping newest per canonical key per chat) ==='

WITH normed AS (
  SELECT id, chat_id, key,
         regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(lower(key), '[''']s\b', 's', 'g'),
                   '[^\w\s_-]', '', 'g'),
                 '[\s\-]+', '_', 'g'),
               '_(status|state)$', '', 'g'),
             '_+', '_', 'g'),
           '^_+|_+$', '', 'g'
         ) AS canonical_key,
         valid_from
    FROM world_state
   WHERE valid_until IS NULL
),
ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY chat_id, canonical_key
           ORDER BY valid_from DESC, id DESC
         ) AS rn
    FROM normed
)
UPDATE world_state w
   SET valid_until = NOW()
  FROM ranked r
 WHERE w.id = r.id
   AND r.rn > 1;

-- -----------------------------------------------------------------------------
-- Summary counts so the operator can sanity-check the result.
-- -----------------------------------------------------------------------------

\echo '=== AFTER cleanup ==='

SELECT 'archived global character rows' AS metric,
       COUNT(*) FILTER (WHERE status LIKE 'archived-legacy-global-%') AS value
  FROM characters
 WHERE chat_id IS NULL;

SELECT 'world_state rows still current per chat (post-cleanup)' AS metric;
SELECT COALESCE(chat_id, '<global>') AS chat_id, COUNT(*) AS still_current
  FROM world_state
 WHERE valid_until IS NULL
 GROUP BY chat_id
 ORDER BY still_current DESC
 LIMIT 20;

-- ── Inspect, then COMMIT or ROLLBACK ────────────────────────────────────────
-- The transaction is left open. To apply the cleanup, run:
--   COMMIT;
-- To bail out, run:
--   ROLLBACK;
-- Either way, the script does NOT auto-commit so the operator can review
-- the printed BEFORE/AFTER counts and decide.
-- =============================================================================
