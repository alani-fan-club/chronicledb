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
