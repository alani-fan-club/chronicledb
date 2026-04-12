# ChronicleDB Critical + Important Tasks

From CODE_REVIEW.md — parallelized across 5 sub-agents.

## Agent assignments

### Agent A — Schema sync, indexes, dead code removal
**Branch**: `fix/schema-cleanup`
- [ ] Add `plot_thread_characters` CREATE TABLE to `server-plugin/schema.sql` (currently referenced but not declared)
- [ ] Add missing indexes: `events.chat_id`, `feels_about(session_id)`, `participated_in.event_id`, `knows.fact_id`, `items.owner_id`, `items.location_id`
- [ ] Delete dead TypeScript code: `src/db/`, `src/extraction/`, `src/retrieval/`, `src/backfill/`, `src/index.ts`, `src/config.ts`, `src/types.ts`
- [ ] Delete `scripts/` (migration + backfill CLI — unused now that everything runs through the ST plugin)
- [ ] Keep `src/ui/` (mind map is served from there)
- [ ] Update `package.json` to remove references to deleted scripts

### Agent B — Idempotent inserts (C3)
**Branch**: `fix/idempotent-inserts`
- [ ] In `server-plugin/db.js`, rewrite these functions to use **content-addressed IDs** (hash of name/content/summary) so re-ingesting the same chat dedups instead of duplicating:
  - `upsertFact` — ID = hash(content + domain)
  - `insertEvent` → rename to `upsertEvent`, ID = hash(summary + chat_id + message_index)
  - Item insertion in `/ingest-chat` route — ID = hash(name + chat_id)
  - `upsertPlotThread` — already uses `(chat_id, title)` unique check, verify it works
- [ ] Use a simple hash like `crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)` prefixed with the type (`fact-`, `evt-`, `item-`)
- [ ] Update all callers in `server-plugin/index.js` to match
- [ ] Do NOT touch retrieval functions — Agent C owns those

### Agent C — Per-chat retrieval isolation (C1)
**Branch**: `fix/chat-scoped-retrieval`
- [ ] Rewrite `getRelationships`, `getRecentEvents`, `getKnowledgeBoundaries`, `getWorldState` in `server-plugin/db.js` to accept `chatIds: string[]` parameter and filter by it
- [ ] Update `server-plugin/retriever.js` `retrieve()` to pass through `chatIds` derived from character config's `selected_chats`
- [ ] Update `server-plugin/index.js` `/retrieve` route to fetch `selected_chats` from `character_memory_config` and pass to `retrieve()`
- [ ] Fix `feels_about` unique constraint in `schema.sql`: change `UNIQUE(from_char, to_char)` to `UNIQUE(from_char, to_char, session_id)` so per-chat relationship history is possible
- [ ] Migrate existing data in a migration SQL file if needed
- [ ] Do NOT touch insert functions — Agent B owns those

### Agent D — UI fixes
**Branch**: `fix/ui-settings-and-colors`
- [ ] In `ui-extension/index.js`, wire up the 8 dropped settings fields that `settings.html` declares but `index.js` never reads: `chronicle_extractionApiUrl`, `chronicle_extractionApiKey`, `chronicle_extractionApiType`, `chronicle_embeddingApiUrl`, `chronicle_embeddingApiKey`, `chronicle_embeddingApiType`, `chronicle_embeddingModel`, `chronicle_embeddingDimension`
- [ ] In `src/ui/mindmap.js`, fix references to `COLORS.tier1`–`tier4` which don't exist — either restore them or update the selectors to use the current color names (`character`, `event`, `location`, etc.)
- [ ] Verify that changing extraction model in the ST settings UI actually updates the server plugin's settings

### Agent E — Lorebook domain + present_at writes + unify new_facts
**Branch**: `fix/lore-knowledge-and-present-at`
- [ ] In `server-plugin/lorebook.js`, change the lorebook fact insertion so entries don't pollute every character's knowledge boundary. Either:
  - Use a new domain like `worldbuilding` that `getKnowledgeBoundaries` ignores, OR
  - Mark lorebook facts as globally known (link to all characters via `knows`)
- [ ] In `server-plugin/db.js::getKnowledgeBoundaries`, exclude facts with `domain IN ('worldbuilding', 'lorebook')` from the "does NOT know" query
- [ ] In `server-plugin/index.js`, add `present_at` writes when processing `context_snapshot.present_characters` during ingestion — so the "Current Scene" retrieval section actually populates
- [ ] Unify `/extract` and `/ingest-chat` routes: both should route `new_facts` into `traits` table (not `facts`). Make them share a helper function `ingestCharacterBatch`

## Merge plan

Agents use git worktrees so they work in parallel on isolated copies. When they finish:
1. Agent A merges first (schema + cleanup is foundational)
2. Agent B merges second (idempotent IDs affect table structure)
3. Agent C merges third (retrieval filters, requires Agent A's schema fixes)
4. Agent D merges in parallel with anything (UI only)
5. Agent E merges last (cross-cutting fixes)

Conflicts likely in:
- `server-plugin/index.js` — Agents B, C, E all touch it
- `server-plugin/db.js` — Agents B, C touch different function groups (should be clean)
- `schema.sql` — Agents A, C touch different sections (indexes vs unique constraints)
