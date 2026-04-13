# Migrations

ChronicleDB does not use a formal migration framework. The plugin is redeployed in-place against existing live databases, so every schema change must be forward-compatible with older deployments. The canonical pattern is idempotent `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements in `server-plugin/schema.sql`, executed on plugin boot.

## Pattern

When evolving a table:

1. Add an `ALTER TABLE <name> ADD COLUMN IF NOT EXISTS <col> <type> [DEFAULT ...];` line to `schema.sql`, located immediately after the table's original `CREATE TABLE` block so the column appears on both fresh installs (via the CREATE) and existing installs (via the ALTER).
2. Keep the column nullable, or supply a `DEFAULT`, so the `ALTER` succeeds against rows already in the table.
3. If a backfill is required (e.g. recomputing embeddings), add a dedicated script under `server-plugin/` and document how to run it alongside the ALTER.
4. Never drop a column in place without first confirming no in-flight deployment still writes it. Prefer adding a replacement column and flipping readers, then removing the old column in a follow-up.

New tables follow the same rule: use `CREATE TABLE IF NOT EXISTS`. New indexes use `CREATE INDEX IF NOT EXISTS`. On plugin boot, `schema.sql` is executed top-to-bottom and any statement that is already applied is a no-op.

## Current post-initial-schema migrations

These are the ALTER / backfill pairs currently living in `schema.sql`:

- `events.source_text` — `ALTER TABLE events ADD COLUMN IF NOT EXISTS source_text TEXT DEFAULT ''`. Distinctive 1–2 sentence extract per event, populated by the extractor.
- `events.tier` — `ALTER TABLE events ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'recent'`. Lifecycle tier (`recent` / `condensed` / `archived`).
- `events.condensed_summary` — `ALTER TABLE events ADD COLUMN IF NOT EXISTS condensed_summary TEXT`. Summary used after an event is condensed into longer-horizon storage.
- `events.embedding` — `ALTER TABLE events ADD COLUMN IF NOT EXISTS embedding vector(768)`. Backfilled by `backfill-multi-granularity-embeddings.js`.
- `memory_embeddings.context_prefix` — `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS context_prefix TEXT`. Anthropic-style contextual retrieval blurb prepended at embed time. Backfilled by `backfill-context-prefix.js`.
- `memory_embeddings.raw_text` — `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS raw_text TEXT`. Unprefixed original text.
- `memory_embeddings.tsv` — `ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`. Powers lexical search.
- `context_snapshots.embedding` — `ALTER TABLE context_snapshots ADD COLUMN IF NOT EXISTS embedding vector(768)`. Backfilled by `backfill-multi-granularity-embeddings.js`.
- `dialogue_quotes` — entire table added post-initial-schema via `CREATE TABLE IF NOT EXISTS` and its accompanying GIN `tsv` / GIN `trgm` indexes. No backfill: older chats remain without dialogue quotes until re-ingested.
- `items.chat_id` — `ALTER TABLE items ADD COLUMN IF NOT EXISTS chat_id TEXT`. Scopes `OWNS` / `LOCATED_AT` edges to a single chat. Content-addressed id now includes `chat_id` so the same-named item in two chats becomes two rows. Legacy NULL-chat rows are dropped from chat-scoped queries; re-ingest to populate.
- `knows.chat_id` — `ALTER TABLE knows ADD COLUMN IF NOT EXISTS chat_id TEXT`. Scopes `KNOWS` edges so a character can know a fact in chat A without leaking it into chat B. Unique constraint stays `(character_id, fact_id)`; `chat_id` is a metadata tag, first-write-wins via `COALESCE`. Legacy NULL-chat rows dropped under scoped reads.
- `present_at.chat_id` — `ALTER TABLE present_at ADD COLUMN IF NOT EXISTS chat_id TEXT`. Scopes character presence to a chat so extraction in chat A doesn't flip `is_current=FALSE` on rows from chat B.
- `traits.normalized_content` — generated `STORED` column that lowercases `content` and strips non-alphanumeric. Backed by a UNIQUE index on `(character_id, category, normalized_content)` so `upsertTrait` dedupes case/punctuation variants ("Awed" / "awed" / "Awe-struck" / "Awestruck") via `ON CONFLICT DO NOTHING`. One-time cleanup deletes pre-existing duplicates keeping the oldest row per normalized group.
- `traits.stemmed_content` — generated `STORED` column from `strip(to_tsvector('english', content))::text`. Runs the Postgres English stemmer so `charmed` / `charming` / `charms` all collapse to `'charm'`, `observant` / `observing` to `'observ'`, etc. `upsertTrait`'s fuzzy pre-check compares against this to catch morphological variants the exact-normalized index misses. Non-unique index (not UNIQUE) so legitimate multi-word traits with overlapping stems can coexist. One-time cleanup kept the longest content per `(character, category, stemmed_content)` group.
