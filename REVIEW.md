# ChronicleDB Architectural Review

## 1. Overview

ChronicleDB is a SillyTavern (ST) plugin layering persistent graph+vector memory over RP chats. The codebase sits in four concentric rings:

1. **Schema + DB helpers** — `server-plugin/schema.sql` (330 lines) + `server-plugin/db.js` (1064 lines) define 20+ tables and all write-side CRUD. Most stable ring.
2. **Extractor + ingest** — `server-plugin/extractor.js` sends message batches to Gemini with a large JSON prompt; three call sites (`index.js` `/extract`, `index.js` `/ingest-chat`, `ingest-standalone.js`) walk the parsed result and upsert into the graph/vector store. The standalone runner is richest; the in-process routes are degraded reimplementations.
3. **Retrieval** — Two parallel implementations. `eval/lib/cdb-client.ts` (1157 lines) is direct-PG, 6-source hybrid, with HyDE, cross-encoder rerank, neighbor padding, graph + arc expansion. `server-plugin/retriever.js` (382 lines) is a thinner variant via `db.hybridSearch`; arc expansion present, HyDE/rerank/graph/padding/event-vector/snapshot-vector absent.
4. **UI surfaces** — `ui-extension/index.js` (627 lines, HTTP client into the plugin) and `src/ui/mindmap.js` (1037 lines, standalone graph viewer). Both are leaves.

Live data flow: UI ext posts to `/retrieve` → `retriever.js` → `db.hybridSearch` + graph helpers → format block → response. Ingest flow: extractor → `db.upsert*` calls → embeddings in `memory_embeddings` / `events.embedding` / `context_snapshots.embedding`. Most accidental complexity lives in ring 3 — it grew by accretion and then forked when the eval-side TS variant raced ahead during the recent iteration.

## 2. Duplication / drift

### 2a. Retrieval (biggest, most load-bearing)

`eval/lib/cdb-client.ts` and `retriever.js` + the helpers in `db.js` implement conceptually the same retrieval pipeline. They have drifted:

| Feature | `cdb-client.ts` | `retriever.js`/`db.js` |
|---|---|---|
| Memory vector | yes (L266) | yes via `db.vectorSearch`/`vectorSearchScoped` |
| Memory lexical | yes — **OR** tsquery (L311) | yes — **AND** `plainto_tsquery` (`db.js` L441) |
| Event vector | yes (L337) | **missing** |
| Event lexical | yes (L390) | yes (`retriever.js` L35) |
| Dialogue quote ts+trgm RRF | yes (L418) | yes (`retriever.js` L113) — verbatim dup |
| Snapshot vector | yes (L362) | **missing** |
| HyDE query rewriting | yes (L808) | skipped (comment at L10-12) |
| Cross-encoder rerank | yes (L819) | skipped |
| Graph expansion boost | yes (L716) | **missing** |
| Arc expansion ±1 | yes (L557) | yes (L54) — verbatim dup |
| Neighbor padding ±1 | yes (L618) | **missing** |
| `LEXICAL_STOP` (21 terms) | L283 | L14 — verbatim dup |
| `buildOrTsquery` | L301 | L24 — verbatim dup |
| `getMaxMessageIndex` | L480 | L103 — near dup |
| `formatMemoryBlock` | L889, ~165 lines | L256, ~125 lines — near dup |

Roughly **40–50% of `cdb-client.ts` (450–550 lines) is a type-annotated rewrite of `retriever.js`/`db.js`**. The genuinely unique logic on top — HyDE+`geminiGenerate` (~50), rerank (~35), neighbor padding (~40), graph expansion + char cache (~80), snapshot vector (~28), event vector (~25), `embedText` (~28) — totals ~290 lines sitting on a duplicated core.

What's stopping consolidation is concrete: `retriever.js` is CJS with a `settings`-threaded convention (so `db.getPool(settings)` can hot-swap credentials); `cdb-client.ts` is ESM TypeScript with a module-level pool pinned to env vars. A shared module has to choose a pool-ownership model. Least-invasive path: extract a `shared/retrieval-core.js` (CJS, importable from both sides) taking a `pool` argument instead of `settings`. HyDE and rerank stay eval-only until ST latency budget allows them.

Concrete drift risks already causing behavior deltas:
- **AND vs OR tsquery.** `db.js::lexicalSearch` (L441) uses `plainto_tsquery` (AND); `cdb-client.ts::lexicalSearch` uses the OR tokenizer. A query like "what did X say about Y" recalls more in eval than in ST. Eval numbers overstate live behavior.
- **`db.js::getActivePlotThreads` (L332) has no LIMIT** while `cdb-client.ts::getPlotThreads` caps at 10. A chatty extraction can blow the memory block budget in ST but not in eval.
- `db.js::getRecentEvents` defaults to limit=5; `cdb-client.ts::getRecentEvents` defaults to 8. Harmless now, a trap later.

### 2b. Ingest pipelines

Three implementations of the same extraction-to-graph loop:

1. `index.js` `/extract` (L166–366) — live path from UI ext. Does **not** chunk messages, **not** generate situating blurbs, **not** extract dialogue quotes, **not** use `upsertMemoryEmbedding`'s dedupe. Oldest and most degraded.
2. `index.js` `/ingest-chat` (L498–784) — whole-chat backfill. Also no chunking / blurbs / dialogue quotes; does per-message embeds via `storeEmbedding` (append-only, not deduping).
3. `ingest-standalone.js` — richest. `chunkText` + `generateSituatingBlurb` + `extractDialogueQuotes` + `upsertMemoryEmbedding` with context prefix.

The extraction-JSON-to-DB-writes body (characters/relationships/events/chains/arcs/world_state/knowledge/items/context_snapshot/plot_threads loops) is **triplicated** across these three call sites. The `/extract` variant is a drifted older subset — memory built live is strictly inferior to memory built via ingest.

Single source of truth: `extractor.js` should export `applyExtractionToGraph(settings, { extraction, chatId, charName, userName, messageIndex, batchSize })`. A second helper `applyMessagesToVectorStore(settings, { messages, chatId, ctxWindow })` would unify chunking + blurb + quote + per-msg embed. Collapses ~200 lines of duplicated for-loops in `index.js` plus ~80 in `ingest-standalone.js`.

### 2c. Eval scripts

Four files — `build_full_bundle.ts`, `build_test_bundle.ts`, `spot_test.ts`, `run_eval.ts` — contain **verbatim copies of the same 20-line `buildContext(rawChat, totalTokens, memoryBlock)` function**. Belongs in `eval/lib/corpus.ts` (already exports `PREAMBLE`). Ten-minute fix, no risk.

`run_eval_gemini.ts` reads pre-built bundles from `/tmp/haiku-bundle/`; it's an implicit downstream of `build_full_bundle.ts` with no shared constant for the path. Document the coupling or pull a `BUNDLE_DIR` constant into a shared file. The two bundle builders differ only in output shape — leave them (consolidation payoff is small). `smoke_retrieve.ts` and `gemini_spot.ts` are throwaway diagnostics; leave them minimal.

## 3. Complexity hotspots

Top functions by line count in `cdb-client.ts`:

| Lines | Function | Verdict |
|---|---|---|
| 169 | `formatMemoryBlock` (L889) | too big, see §3b |
| 117 | `hybridSearch` (L658) | borderline, coherent |
| 94 | `retrieve` (L1058) | too big, see §3a |
| 61 | `fetchArcExpansion` (L557) | fine (one SQL + collation) |
| 61 | `dialogueQuoteSearch` (L418) | fine (two queries + RRF) |

### 3a. `retrieve` should become a named-stage pipeline

L1058–1150 interleaves ten distinct stages in 92 lines: parallel structured fetch, HyDE, entity detection, embed, hybrid search, per-kind split, selective rerank of memory bucket, reassemble, neighbor padding + arc expansion in parallel, format. Three separate `try { ... } catch (err) { console.warn ... }` blocks (HyDE L1085, embed L1097, rerank L1116) repeat the same pattern.

Refactor: turn it into a `RetrievalPipeline` object with stages `fetchStructured`, `rewriteQuery`, `detectEntities`, `embed`, `fuseSources`, `rerankSelective`, `expandNeighbors`, `format`. Gives ~30-line orchestrator, makes each stage individually mockable from eval scripts (ablation studies by flag instead of commenting out lines), and lets a `tryOrWarn(stage, fallback)` helper replace the three try/catches.

### 3b. `formatMemoryBlock` should dispatch to section builders

L889–1054 builds ~10 markdown sections via inline string concat, with per-section slicing budgets scattered through the body (200, 300, 600, 700, 1200, 1800, 2000, 2500 chars). Section ordering is load-bearing: ground-truth sections go first so truncation at `maxChars` can't eat them (comment at L899). But that ordering is encoded in code order, not data.

Refactor: a `SECTIONS: Array<{ name, budget, build(result) }>` registry plus a single render loop. Moves per-section limits into one auditable `SECTION_LIMITS` constant, makes each builder unit-testable without a DB, makes A/B-ing section presence trivial. Low risk — spot_test before/after will confirm byte-identical output.

### 3c. `hybridSearch` is pipeline-shaped and borderline OK

L658–773: six searches in parallel → RRF merge → optional graph boost → recency boost → per-kind cap → return. Each phase is 10–20 lines and coherent. Factoring the per-kind cap (L760–772) into `capPerKind(sorted, caps, limit)` would turn the function into a five-step linear story and trim it to ~70 lines. Not urgent.

### 3d. Repeated retry/backoff and nested loops

Three hand-rolled exponential-backoff implementations for conceptually one operation:
- `extractor.js::callWithRetry` closure (L135–148)
- `extractor.js::generateSituatingBlurb` inlined for-loop (L262–290)
- `run_eval_gemini.ts::gemini` (L55–88)

All retry on 429/5xx, all double a 1s baseline, all cap at 4 attempts. Extract a `withExponentialBackoff(fn, { retries, baseDelay, isRetriable })` helper.

`index.js::/ingest-chat` L579–759 nests 5 levels deep (`for g → for k → try → for char → for trait`). The `applyExtractionToGraph` refactor (§2b) collapses this to 3.

`db.js::traverseFromCharacter` L630–875 is a 250-line function containing a recursive CTE plus N hydration queries. Only called by the mindmap — off hot path — so leave it unless perf pressure forces revisit.

## 4. Schema observations

### 4a. Weight per table

Hot (read on every retrieve): `memory_embeddings` (hnsw + GIN tsv + chat_id), `events` + `participated_in`, `context_snapshots`, `dialogue_quotes`, `feels_about`, `world_state`, `plot_threads`, `present_at`, `locations`, `characters`. Appropriate weight.

Written during ingest but **never read by retrieval**:
- **`event_chains`** — extracted and written, only read by `getGraphData`/`traverseFromCharacter` for the mindmap. The `retrieve` path does not look at them.
- **`traits`** — written per character, exposed via `/character/:name/traits` for the mindmap. `retrieve` never surfaces them to the LLM. Could be surfaced as a "Character Traits" section in the memory block; right now they're a write-only sink from retrieval's view.
- **`items`** — written by ingest, read only by the mindmap. The LLM never sees them.
- **`plot_thread_characters`** — populated by `upsertPlotThread`, read only by `traverseFromCharacter`. `getActivePlotThreads` doesn't join it.

Pattern: ~4 tables get populated per extraction purely so the mindmap has edges to draw, with no retrieval benefit. Not wrong, but extraction cost exceeds retrieval gain there. If ingest cost becomes a problem, gate traits/items/chains behind a `settings.enableVisualizationData` flag.

### 4b. `events.source_text` vs `dialogue_quotes.quote` overlap

Both index verbatim RP text, but purposefully:
- `events.source_text` is the LLM-chosen "most distinctive 1–2 sentences" per event (extractor.js L30–34). Single row per event, narration-or-dialogue.
- `dialogue_quotes.quote` is every regex match of curly/straight double quotes (extractor.js L313). Many rows per message, speaker-attributed, has GIN tsv *and* trgm for fuzzy phrasing matches.

They overlap when an event's source quote is also spoken dialogue, but the separation is defensible: dialogue quotes are orders-of-magnitude more numerous and benefit from trgm, and are speaker-attributed (events aren't). Merging would regress trgm performance on a much larger mixed table. No collapse opportunity without losing the event-centric vs quote-centric axis.

### 4c. Organic growth areas

- **`chronicle_sessions`** (schema.sql L316) — declared but **never written or read anywhere outside schema.sql**. Fully vestigial.
- **`idx_events_major`** (L49, partial index on `is_major = true`) — no query uses `is_major`. Vestigial.
- **`idx_dialogue_quotes_chat_speaker`** (L311) — no query filters by speaker. Vestigial.
- **`idx_events_embed_hnsw`** — used only by `cdb-client.ts`; `retriever.js` doesn't do event vector search. Write overhead now, read benefit only once retrieval is consolidated.
- **`world_state.chat_id`** was added via `ALTER TABLE` with legacy NULL rows treated as global (`db.js` L183–196, `cdb-client.ts` L172–179). Both retrieval implementations carry a NULL-is-global branch forever. Once data is backfilled, a one-shot migration to drop the NULL branch simplifies both sides.
- `context_snapshots.embedding` and `events.embedding` also added via `ALTER`; `backfill-multi-granularity-embeddings.js` exists to populate them. Standard pattern, fine, but a `MIGRATIONS.md` would beat scattered `ALTER`s at the bottom of `schema.sql`.
- **`ingestion_status.chat_file`** names a PK string while every other table uses `chat_id` (= filename without `.jsonl`). Minor naming inconsistency for the same identity. Not worth migrating, worth a comment.

## 5. Efficiency gains

### 5a. N+1 on knowledge boundaries (both retrieval impls)

`cdb-client.ts::getKnowledgeBoundaries` L136–169 and `db.js::getKnowledgeBoundaries` L540–580 loop over `characters` and run **two queries per character**: `known` facts and `doesNotKnow` facts. For N characters that's 2N round-trips per `/retrieve`. Collapses to 2 total via `WHERE character_id = ANY($1::text[])` + JS grouping. Live-traffic win, not just eval.

### 5b. Per-embed HTTP call in ingest (highest-leverage perf)

`ingest-standalone.js` L260 and `index.js` L739 do `await embed(settings, text)` inside a per-message loop, no batching. Every message = one HTTP call to Gemini's `embedContent`. Gemini supports `batchEmbedContents` (up to 100 inputs/call). For a 500-message chat with situating blurbs, that's ~500 sequential calls instead of ~5. Even batching within a 10-message batch gives 10× fewer round-trips.

`extractor.js::embed` is single-input. Adding `embedBatch(settings, texts: string[])` and accumulating across the ingest per-message loop before dispatch is the single biggest ingest perf win available. Eval-side embed calls are 1/retrieve (HyDE or recentText) so nothing to batch there.

### 5c. `getMaxMessageIndex` per-request aggregation

Every `/retrieve` does `SELECT GREATEST(max(msg_index) from memory_embeddings, max(msg_index) from events)`. The max changes only on ingest. Cache per-chat with a short TTL (or invalidate on insert) — free instead of a double-aggregate scan. Cheap on eval-scale, noticeable on long chats with 50k+ embed rows.

### 5d. Overfetch ratio in hybrid retrieval

`cdb-client.ts::hybridSearch` L666 overfetches each source at `Math.max(limit, 8) * 3` = 120 rows per source at `limit=40`. Six sources = 720 candidate rows. Per-kind caps (L762) trim to 52 max; `formatMemoryBlock` L925–928 renders only 3/4/4/3 = 14. Overfetch ratio is ~50:1 from DB → rendered block.

Most of this is free (pgvector/tsv), but:
- **`dialogueQuoteSearch`** runs two queries at `fetchSize*3 = 120` each with trgm similarity — the most expensive op in the batch. Cutting to `limit*2 = 20` almost certainly won't hurt recall (trgm is already doing fuzzy expansion) and saves measurable time.
- **`eventLexicalSearch`** fetches 120 events when at most 4–10 are rendered. Cutting to 30 is safe.

### 5e. Graph-expansion character cache scope

`cdb-client.ts::characterIndexCache` (L510) is a module variable keyed by `chatId`. Correct for eval (one chat per process). If graph expansion is ported to `retriever.js`, the ST plugin's long-lived process needs a `Map<chatId, { entries, expiresAt }>` with a 5-minute TTL so chat-switching doesn't re-query per turn.

### 5f. Ingest concurrency deliberately 1

`index.js::/ingest-chat` L540: `const concurrency = 1 // Gemini free tier chokes`. On a paid tier, 2–4 concurrent extraction calls meaningfully cuts ingest time. Expose as `settings.extractionConcurrency` (default 1).

## 6. Quick wins (< 1h each)

- **Pull `buildContext` into `eval/lib/corpus.ts`** (10 min). Delete 4 verbatim copies across `build_full_bundle.ts`, `build_test_bundle.ts`, `spot_test.ts`, `run_eval.ts`. Zero risk.
- **Collapse `getKnowledgeBoundaries` N+1 into 2 queries** (30 min × 2 sides). Use `= ANY($1::text[])` + group-in-JS. Live-traffic latency cut every `/retrieve`.
- **Add `LIMIT 20` to `db.js::getActivePlotThreads`** (2 min). Matches `cdb-client.ts::getPlotThreads`. Fixes silent token-budget runaway.
- **Delete `chronicle_sessions` table + `idx_events_major` + `idx_dialogue_quotes_chat_speaker`** (5 min). Write-only with zero readers.
- **Extract `LEXICAL_STOP` + `buildOrTsquery` into `shared/ts-query.js`** (20 min). Both sides have identical bodies (`retriever.js` L14–33, `cdb-client.ts` L283–309). Pure function, no pool concerns. CJS file, importable from TS via Node interop.
- **Align lexical search on OR semantics** (15 min). Change `db.js::lexicalSearch` to use `buildOrTsquery` from the shared module so ST retrieval recall matches eval. This alone closes the biggest behavior delta.
- **Factor `withExponentialBackoff` into `extractor.js`** (30 min). Replace `callWithRetry` closure (L135–147), `generateSituatingBlurb` loop (L262–290), and `run_eval_gemini.ts::gemini` retry (L55–88) with one shared helper.
- **Reduce `dialogueQuoteSearch` / `eventLexicalSearch` overfetch** (5 min each copy). `limit*3 → limit*2` for dialogue, `120 → 30` for events. Measurable latency cut, near-zero recall risk.
- **Add `applyExtractionToGraph(settings, extractionData, ctx)` helper** (45 min) and make `/extract`, `/ingest-chat`, `ingest-standalone.js` call it. Drops ~200 lines from `index.js` and ~80 from `ingest-standalone.js`. Medium risk (upsert ordering matters) — snap a fixture extraction object and assert final DB state as a quick guard.

## 7. Larger refactors (high effort, real payoff)

### 7a. Consolidate retrieval into `shared/retrieval-core.js`

**Effort:** 4–6 hours. **Payoff:** Eliminates the drift that makes eval non-representative of ST. Every retrieval change made once. **Risk:** Medium — `settings`-threaded `db.js` vs module-pooled `cdb-client.ts` needs a `PoolAdapter` abstraction without breaking credential hot-swap in ST.

Plan:
1. `shared/retrieval-core.js` as plain CJS (both ESM TS and CJS plugin import it fine).
2. Move `LEXICAL_STOP`, `buildOrTsquery`, `RECENCY_ALPHA`, `RRF_K=60` constants.
3. Move the source-specific queries (`fetchArcExpansion`, `getMaxMessageIndex`, `dialogueQuoteSearch`, `eventLexicalSearch`, `eventVectorSearch`, `snapshotVectorSearch`, `vectorSearch`, `lexicalSearch`) taking a `{ pool }` argument instead of `settings`.
4. Move `hybridSearch` (6-source fusion + graph boost + recency + per-kind caps).
5. Move the inner core of `formatMemoryBlock` parameterized by section registry.
6. `cdb-client.ts` shrinks to: pool singleton, HyDE, rerank, neighbor padding, `retrieve` orchestrator — ~400 lines instead of 1157.
7. `retriever.js` shrinks to: pool adapter + graph helpers in `db.js` + thin `retrieve` orchestrator — ~150 lines instead of 382.
8. HyDE and rerank become opt-in flags on the shared `retrieve`, so ST can enable them when latency budget allows. Deletes the L10–12 comment as a bonus.

### 7b. Extract extraction-to-graph writes as `applyExtractionToGraph`

**Effort:** 2–3 hours. **Payoff:** ~300 lines of triplication gone, `/extract` automatically gets `/ingest-chat`'s features, new extraction outputs go in one place. **Risk:** Low (straight-line DB writes; one fixture test catches regressions).

### 7c. Data-driven section renderer for `formatMemoryBlock`

**Effort:** 2–3 hours. **Payoff:** 169-line monster → render loop over `SECTION_REGISTRY`. Ordering/visibility/budgets become one data structure, unit-testable. **Risk:** Very low; spot_test before/after verifies byte equivalence.

### 7d. `retrieve` pipeline refactor

**Effort:** 2 hours. **Payoff:** 10 named stages, eval ablations by flag instead of code edits, each stage mockable. **Risk:** Very low — purely structural refactor of an already-linear function.

### 7e. `embedBatch` + rewired ingest loops

**Effort:** 1–2 hours. **Payoff:** 10–50× ingest speedup on embed-bound batches (the single biggest ingest perf win). **Risk:** Medium — Gemini batch endpoint has size/token caps and partial-failure semantics.

Plan: add `embedBatch(settings, texts)` in `extractor.js` wrapping `batchEmbedContents`; refactor per-message embed loops to accumulate `{ messageIndex, text, contextPrefix }` tuples, call `embedBatch` in chunks of ~50, then insert. Keep `embed(text)` as a 1-item wrapper for retrieval.

## 8. Things that are good as-is

- **`schema.sql` structure.** 20+ tables each with a clear role; most indexes load-bearing; `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration pattern is the right one for a plugin redeployed against existing DBs. The vestigial tables/indexes called out above are rounding error.
- **`db.js` upsert helpers** (L59–398). Deterministic content-addressed IDs via `contentId()`, idempotent upserts, `settings` threading for credential hot-swap. Well-factored; don't touch except to add new tables.
- **`eval/lib/corpus.ts`** — reads gitignored `.local-corpus.json`, no PII in repo, seeded chunk picker for reproducibility. Exactly how eval corpus handling should look.
- **`eval/lib/proxy.ts`** — 92 lines, single-purpose, exponential backoff, environment-driven. Don't touch.
- **`extractor.js::EXTRACTION_PROMPT`** (L6–110). Verbose but load-bearing and well-commented. Any tweak risks breaking extraction quality in surprising ways. Leave alone.
- **`lorebook.js`** — 173 lines, small and focused; the heuristic classifiers are cheap and correct-enough.
- **`src/ui/mindmap.js`** — 1037 lines is large but visualization code is always line-heavy, and this is off hot path.
- **`db.js::traverseFromCharacter`** recursive CTE — painful to read, correct, off hot path. Cost to refactor exceeds benefit unless you're actively working on the mindmap.
- **The per-chat scoping plumbing** — `character_memory_config.selected_chats`, `chatIds` threading, `chat_id IS NULL` legacy fallback in `world_state`. Clearly a recent pain point (3–4 apology comments), but the resolved state is coherent. Don't re-plumb just to clean.
- **RRF `k=60`, `RECENCY_ALPHA=0.003`, per-kind caps in `hybridSearch`**. Comments explain why these were picked after tuning, and the per-kind cap fixes a real starvation bug. Don't "clean up" by removing comments or rounding constants.
- **`.local-corpus.json` + `.env` gitignore hygiene.** The eval harness is careful not to leak user PII into the repo.
- **`settings-cache.json` auto-reconnect pattern** in `index.js` L21–63. Persists init state so ST boots reconnect without UI interaction. Thoughtful.

---

**Summary**: Highest-value refactor is consolidating retrieval (§7a) — biggest duplication, biggest drift risk, ongoing tax every edit. After that, extracting the ingest write loop (§7b) and batching embeds (§7e) are clear wins. The complexity hotspots in `cdb-client.ts` (§3a–c) are real but manageable. Schema is mostly fine with a handful of vestigial items to prune. Most of the codebase is in surprisingly good shape given the rate of recent iteration — the parts that need work are concentrated in the retrieval ring and can be addressed without touching ingest or schema.
