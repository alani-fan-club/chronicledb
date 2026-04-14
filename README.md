# ChronicleDB

A persistent graph-plus-vector memory store for SillyTavern roleplays. Runs as a SillyTavern server plugin backed by PostgreSQL and pgvector. Ingests chat files, pulls structured entities and events out of each batch via a cheap extraction LLM, stores them in a hybrid relational-graph plus vector schema, and returns a memory block on every turn so the main chat model sees the relevant past without stuffing the whole chat into its context window.

## What it does

ChronicleDB turns long roleplay chats into durable, queryable memory. Every time a chat updates, a small LLM reads the latest batch of messages and extracts characters, their persistent traits, the events that happened, what the scene looked like, what world state changed, what characters know (and do not know), and which narrative threads are still open. Those get written into a relational graph (characters, locations, events, items, plot threads, story arcs) while the raw passages and extracted events get vector-embedded into pgvector so the system can do semantic search over the text that actually happened. Everything is scoped by `chat_id` so two parallel roleplays with the same character do not cross-contaminate.

On retrieval the plugin runs a six-bucket hybrid search (dense and lexical over memory passages, dense and lexical over event source text, tsvector-plus-trigram over dialogue quotes, and dense over scene snapshots), fuses them via Reciprocal Rank Fusion, pads memory hits with their ±1 neighbor messages, expands event hits with the story arc they belong to, and renders the result into a `[ChronicleDB Memory Context]` block that SillyTavern injects into the main prompt.

The optional pieces on top of that baseline include a structural story-arc discovery pass (Louvain community detection over a weighted event graph, producing a three-level super-arc / arc / episode hierarchy), a trait canonicalization pipeline that uses a lexicon gate, contextual embeddings, and an LLM verifier to collapse "stoic" / "unflappable" / "keeps composure under pressure" into one canonical trait row, and a per-character summary embedding that mean-pools a character's dispositional traits so you can kNN across characters. Everything is tuned around one design goal: keep per-turn memory retrieval good enough without requiring the main model to burn context on scrollback.

## Architecture

```
              ST chat turn
                   │
                   ▼
    ┌─────────────────────────────┐
    │  ui-extension (ST client)   │  hooks GENERATION_ENDED / GENERATION_STARTED
    └─────────────┬───────────────┘
                  │ POST /extract              POST /retrieve
                  ▼                                  ▼
    ┌─────────────────────────────┐   ┌─────────────────────────────┐
    │  server-plugin/index.js     │   │  server-plugin/index.js     │
    │  Express router             │   │  Express router             │
    └──────┬──────────────┬───────┘   └──────────────┬──────────────┘
           │              │                          │
           ▼              ▼                          ▼
    ┌────────────┐ ┌────────────┐      ┌───────────────────────────┐
    │ extractor  │ │    db      │      │  shared/retrieval-core    │
    │  LLM pass  │ │ upserts    │      │  hybrid search + fusion   │
    └──────┬─────┘ └──────┬─────┘      │  neighbor pad, arc expand │
           │              │            └──────────────┬────────────┘
           ▼              ▼                           │
    ┌──────────────────────────┐                      │
    │   PostgreSQL + pgvector  │ ◄────────────────────┘
    │   graph tables + vector  │
    │   tables + HNSW / GIN    │
    └──────────────────────────┘
           ▲
           │ post-ingest
    ┌──────┴───────────┐
    │  arc-builder     │  Louvain on weighted event graph
    │  (Path 1/5)      │  runs once per chat after /ingest-chat
    └──────────────────┘
```

Everything talks to Postgres through `node-postgres` with a single connection pool owned by `server-plugin/db.js`. There is no separate graph DB: the "graph" is a handful of narrow relational tables plus pgvector columns. HNSW indexes on the vector columns and GIN indexes on the tsvector columns are created idempotently at boot by `schema.sql`.

The top-level layout is:

```
chronicledb/
├── server-plugin/           # SillyTavern server plugin (Node, runs in-process under ST)
│   ├── index.js             # Express router; every HTTP endpoint lives here
│   ├── db.js                # Schema init + upserts + trait canonicalization + graph helpers
│   ├── extractor.js         # Extraction + embedding LLM calls, apply*ToGraph/ToVectorStore
│   ├── arc-builder.js       # Structural arc discovery via Louvain on a weighted event graph
│   ├── retriever.js         # Thin ST-facing orchestrator; delegates to shared/retrieval-core
│   ├── schema.sql           # The full, idempotent schema
│   ├── lorebook.js          # ST lorebook ingestion
│   ├── ingest-standalone.js # Run the ingest pipeline from CLI without ST
│   └── backfill-*.js        # One-shot backfill scripts (see Development below)
├── shared/                  # Code shared between the ST plugin and any other caller
│   ├── retrieval-core.js    # Hybrid fusion, neighbor padding, arc expansion, SECTION_REGISTRY
│   ├── trait-lexicons.js    # GOLDBERG_100, NRC_EMOTION, NRC_VAD sets/maps
│   └── ts-query.js          # buildOrTsquery helper, shared lexical search surface
├── ui-extension/            # SillyTavern UI extension (client-side)
│   ├── index.js             # Hooks GENERATION_ENDED/STARTED, settings panel, character panel
│   ├── settings.html        # The ST settings drawer for ChronicleDB
│   ├── character-panel.html # Per-character memory panel mounted in the card sidebar
│   └── manifest.json        # ST extension manifest
├── src/ui/                  # Standalone Cytoscape-based mindmap served at /map
├── RESEARCH_TRAITS.md       # Trait pipeline design doc
├── RESEARCH_ARCS.md         # Arc discovery design doc
├── MIGRATIONS.md            # Post-initial-schema schema evolution
└── REVIEW.md                # Architectural self-review
```

Subsystem dependencies at a glance:

- `server-plugin/` depends on `pg`, `pgvector`, `graphology`, `graphology-communities-louvain`, and `dotenv` (for the backfill scripts). No ORM.
- `shared/retrieval-core.js` depends only on `shared/ts-query.js` and the `pool` object it is handed. It is intentionally framework-free so anything with a node-postgres Pool can use it.
- `shared/trait-lexicons.js` has no runtime dependencies.
- `ui-extension/index.js` depends on SillyTavern's globals (`eventSource`, `event_types`, `extension_settings`, `renderExtensionTemplateAsync`) plus jQuery and `toastr`, which ST ships.
- `src/ui/` pulls Cytoscape, `layout-base`, `cose-base`, and `cytoscape-fcose` via CDN at runtime.

### Storage model

**Node tables** (identity rows):

- `characters` — one row per named character. Global, not chat-scoped (the same character can appear in many chats). Has `aliases TEXT[]`, `description`, `role`, `status`, `significance`, and a `summary_embedding vector(768)` column that holds the mean-pooled personality-trait embedding for cross-character kNN.
- `locations` — one row per place. Global.
- `events` — summary plus `source_text` verbatim quote, `message_index`, `chat_id`, `significance`, optional `embedding vector(768)`. Chat-scoped.
- `context_snapshots` — scene state at a point in time: location, `present_chars`, `emotional_tone`, `world_state_snapshot JSONB`, `embedding vector(768)`. Chat-scoped.
- `facts` — globally deduped (same content, same row). Chat scope lives on the `knows` edge.
- `world_state` — key/value with `valid_from` / `valid_until` bi-temporal columns. Chat-scoped.
- `plot_threads` — foreshadowing, unresolved threads, promises, mysteries. Chat-scoped.
- `story_arcs` — narrative container rows. `source` column distinguishes per-batch LLM rows (legacy) from Louvain-built structural rows. `hierarchy_level` and `parent_arc_id` support the three-level super-arc / arc / episode hierarchy. Chat-scoped.
- `traits` — character-attached dispositional traits. See Trait canonicalization below for the canonical / alias scheme, generated `normalized_content` and `stemmed_content` columns, and the partial HNSW index on canonical rows.
- `items` — name / description / powers / owner / location / status. Chat-scoped (same-named item in two chats becomes two rows, keyed by `(name, chat_id)`).

**Edge tables**:

- `feels_about (from_char, to_char, sentiment, intensity, description, session_id)` — per-session sentiment; one row per ordered pair per session.
- `knows (character_id, fact_id, source, chat_id)` — what a character has learned. Chat-scoped.
- `participated_in (character_id, event_id, role)` — bipartite character-event edge.
- `present_at (character_id, location_id, is_current, chat_id)` — which character is currently where, per chat.
- `event_chains (from_event_id, to_event_id, chain_type)` — causal / followed-by links between events.
- `arc_events (arc_id, event_id, position, is_anchor)` — which events make up a story arc.
- `plot_thread_characters (plot_id, character_id)` — character involvement in a plot thread.

**Vector tables**:

- `memory_embeddings` — the main passage-level index. One row per chunk of a message, with `embedding vector(768)`, a GENERATED `tsv tsvector` column for lexical search, a `context_prefix` column holding an LLM-generated situating blurb (the Anthropic contextual retrieval pattern), and a `raw_text` column holding the unprefixed original. Backed by an HNSW cosine index plus a GIN index on `tsv`.
- `events.embedding` — per-event dense vector over `summary + source_text`. Populated at insert time during ingest so the arc builder has a real cosine signal. HNSW cosine index.
- `traits.embedding` — per-trait contextual embedding of the form `"${name} is ${content}: ${evidence_sentence}"`. Partial HNSW cosine index restricted to `canonical_id IS NULL` rows so kNN lookups never match merged variants.
- `characters.summary_embedding` — mean-pooled rollup of a character's personality-trait embeddings via pgvector `AVG(vector)`. HNSW cosine index for cross-character similarity.
- `context_snapshots.embedding` — dense vector over scene summaries. HNSW cosine index.
- `dialogue_quotes` — GIN tsvector index plus `gin_trgm_ops` trigram index for "what did X say about Y" questions.

**Why PostgreSQL plus pgvector instead of a dedicated graph DB.** The event graph in a single chat is small: a few hundred events, under a thousand edges. HNSW over pgvector handles the vector side natively inside the same database. Running everything in one Postgres instance keeps ops simple, lets the retrieval pipeline compose vector search, tsvector, trigram, JSON, and graph joins in a single query plan, and keeps idempotent schema evolution down to `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `schema.sql` with no migration framework. `RESEARCH_ARCS.md` walks through the trade-off against Apache AGE, Neo4j, and related graph stores in more detail.

### Ingestion pipeline

`POST /api/plugins/chronicle-db/ingest-chat` reads a chat `.jsonl` file under SillyTavern's data root and walks it end-to-end:

1. **Parse.** Read the file. The first line is the ST chat metadata; the rest are messages. Skip system messages and empty messages. Honor the active swipe when one is selected.
2. **Batch.** Split into batches of `extractionBatchSize` messages (default 10). Optionally run `extractionConcurrency` extraction LLM calls in parallel for the whole group (default 1; the Gemini free tier does not tolerate higher concurrency, paid tiers can run 2 to 4).
3. **Extract.** For each batch, `extractor.extract(settings, ...)` posts the `EXTRACTION_PROMPT` plus the batch to the configured LLM. The prompt asks for structured JSON: `characters[]` (with `persistent_traits[]` and `scene_state[]` as two distinct buckets), `relationships[]`, `events[]` (with a verbatim `source_quote`), `event_chains[]`, `world_state[]`, `knowledge_updates[]`, `items[]`, `locations_detail[]`, `context_snapshot`, `plot_threads[]`, and any `contradictions[]` it notices. The prompt is strict about distinguishing persistent dispositional traits from transient scene-state reactions, requires an evidence sentence for every persistent trait, and tells the LLM to emit every named character, no matter how minor.
4. **Apply to graph.** `extractor.applyExtractionToGraph` upserts the parsed data into the relational tables in load-bearing order: characters and traits first, then relationships, then events (building an `event_key → event_id` map so arc and chain references inside the same batch can resolve), then event chains, world state, knowledge updates, items, locations, the context snapshot (which also rewrites `present_at` for the current chat), and finally plot threads. Scene state from the characters pass is merged into `context_snapshot.emotional_tone` but is never written to the trait table.
5. **Embed events.** Immediately after events are inserted, the pipeline batches the event summaries through Gemini `batchEmbedContents` (up to 100 per call) and populates `events.embedding` so the arc builder has real cosine signal on freshly ingested rows.
6. **Apply to vector store.** `extractor.applyMessagesToVectorStore` walks the batch again. For each non-trivial message it calls `generateSituatingBlurb` (an LLM call that produces one to two sentences placing the message in the larger story, given `ingestContextWindow` messages of surrounding context on each side), chunks the message via `chunkText` (2000 char target with 400 char overlap), builds `"${situating}\n\n${labeledChunk}"` as the embed input, batch-embeds the full list of chunks, and upserts one `memory_embeddings` row per chunk with the situating blurb stored in `context_prefix`. In parallel, `extractDialogueQuotes` pulls quoted strings of 4 to 400 characters out of the message text and inserts them into `dialogue_quotes` for tsvector plus trigram search.
7. **Rebuild arcs.** After the batch loop finishes, `arc-builder.rebuildArcsForChat` runs Louvain community detection over every event in the chat (see Structural arc discovery below). LLM arc naming is opt-in via `nameArcs: true`; `/ingest-chat` wires it on.
8. **Record status.** Upsert a row into `ingestion_status` so the ST UI can show done / failed state per chat file.

Live ingestion uses the same pipeline at a smaller grain: `POST /extract` accepts a single batch of messages pushed by the UI extension after `GENERATION_ENDED`, runs `applyExtractionToGraph` and `applyMessagesToVectorStore` on it, and returns immediately. The UI extension fires this asynchronously and does not block generation.

Relevant settings:

- `extractionApiType` — `"gemini"` or `"openai"` (OpenAI-compatible endpoints also work).
- `extractionApiUrl`, `extractionApiKey`, `extractionModel` — the extraction LLM.
- `geminiEmbeddingModel`, `geminiApiKey`, `geminiEmbeddingDimension` (default 768) — the embedder. Only Gemini is wired for embeddings right now.
- `extractionBatchSize` — messages per extraction call (default 10).
- `extractionConcurrency` — how many batches to extract in parallel (default 1).
- `ingestContextWindow` — messages on each side used for situating blurbs (default 4).

### Retrieval pipeline

`POST /api/plugins/chronicle-db/retrieve` takes the current `chatId`, a list of active characters, the recent chat text, a token budget, and an optional per-character chat scope list. It returns a structured retrieval result plus a `memoryBlock` string formatted for direct injection into the main prompt.

The live path runs through `shared/retrieval-core.js::hybridSearch`, which is a six-source Reciprocal Rank Fusion with a few extras on top:

1. **Resolve chat scope.** Per-character memory config (`selectedChats`) wins if set; otherwise scope falls back to the current chat. Cross-chat retrieval is explicitly opt-in.
2. **Embed the query.** `recentText` (the last ten messages joined and truncated to 4000 chars) is passed to Gemini `embedContent` to produce the query vector.
3. **Detect mentioned characters.** `detectMentionedCharacters` walks a per-chat cached index of character names plus aliases and returns any IDs that appear in the query string. The cache has a five-minute TTL.
4. **Fan out six searches in parallel.**
   - `vectorSearch` — HNSW cosine over `memory_embeddings.embedding`.
   - `lexicalSearch` — GIN over `memory_embeddings.tsv`, using an OR `to_tsquery` built from the query terms (not `plainto_tsquery`, which was a measurable recall loss on multi-term questions).
   - `eventVectorSearch` — HNSW cosine over `events.embedding`.
   - `eventLexicalSearch` — tsvector over `events.source_text` with OR semantics.
   - `dialogueQuoteSearch` — tsvector plus `pg_trgm` similarity over `dialogue_quotes.quote`, RRF-fused internally before returning.
   - `snapshotVectorSearch` — HNSW cosine over `context_snapshots.embedding`.
5. **Reciprocal Rank Fusion.** Each result contributes `1 / (k + rank)` to a per-key score, with `k = 60`. Keys are namespaced (`m:`, `e:`, `d:`, `s:`) so the same underlying row across buckets merges.
6. **Graph expansion boost.** If `detectMentionedCharacters` matched any character IDs, the pipeline fetches the top events they participated in (via `participated_in`), synthesizes any missing rows into the candidate set, and awards them an RRF-tier bonus so the character-grounded events can climb the ranking.
7. **Recency boost.** Every hit gets `RECENCY_ALPHA * (message_index / max_message_index)` added to its score (`RECENCY_ALPHA = 0.003`, a gentle tiebreaker against RRF's ~0.0164 top scores). The max message index is computed once across `memory_embeddings` and `events`.
8. **Per-kind caps.** Sort everything, then walk in score order applying caps of 24 memory / 10 event / 10 dialogue / 8 snapshot so the huge memory pool cannot starve the other buckets.
9. **Arc expansion.** `fetchArcExpansion` takes the surviving event hits and, for each one, joins `arc_events` and `story_arcs` (filtered to `hierarchy_level = 1` so only the middle "arc" tier participates in the default expansion), pulling the arc title, description, status, and the ±1 positional neighbors inside that arc. One event may belong to multiple arcs; the highest-importance arc wins per event.
10. **Neighbor padding.** `fetchNeighborPadding` takes the memory hits' message indices, computes the set of ±1 indices that are not themselves hits, and pulls those messages out of `memory_embeddings` in one query. They render as their own `[PREV TURN ...]` / `[NEXT TURN ...]` bullets so the main model cannot skim past them.
11. **Structured fan-out in parallel.** Alongside the hybrid search, the orchestrator also fetches `getRelationships`, `getRecentEvents` (top 8 by significance and recency), `getKnowledgeBoundaries` (what each active character knows and does not know, collapsed to two queries total rather than one per character), `getWorldState`, `getPlotThreads`, `getRecentSnapshots`, and `getLocations`.
12. **Format the memory block.** `formatMemoryBlock` walks a `SECTION_REGISTRY` in a deliberate order. Ground-truth sections render first (`Current Scene`, `World State`, `Active Plot Threads`) so if the final block overflows the `maxChars` budget and has to truncate, they survive. Retrieval hits (`Relevant Past Context`, `Matched Event Passages`, `Matched Dialogue Quotes`, `Matched Scene Snapshots`) come next, then narrative framing (`Scene Context`, `Recent Events`, `Character Knowledge Boundaries`), and finally the bulky, most-OK-to-truncate `Relationships` section. Each section has its own character budgets defined in `SECTION_LIMITS`.

HyDE query rewriting and LLM cross-encoder reranking are not part of the live ST retrieval path — `server-plugin/retriever.js` calls `hybridSearch` directly. The shared core is structured so they can be layered on without touching the hybrid search contract, but as shipped today the ST turn path is exactly the twelve steps above.

The rendered memory block looks roughly like this (sections the result set has no data for are omitted):

```
[ChronicleDB Memory Context]

## Current Scene
- <character>: <location>

## World State
- <key>: <value>

## Active Plot Threads
- ⏳ [pending] <title>: <description> (involves: <names>)

## Relevant Past Context
- (82%) [turn 137] <situating blurb>

  <body of the retrieved passage>
- [PREV TURN 136 — context for turn 137] ...
- [NEXT TURN 138 — context for turn 137] ...

## Matched Event Passages
- [turn 142] <verbatim event source_text>
  [arc: <arc title> (active) — <arc description>]
  [arc prev pos 3] <neighbor event summary>
  [arc next pos 5] <neighbor event summary>

## Matched Dialogue Quotes
- [turn 94] <speaker>: "<quote>"

## Matched Scene Snapshots
- [turn 121] <scene summary> [at <location>] (<tone>)

## Scene Context
- <recent snapshot summary>

## Recent Events
1. [sig 4/5] <summary> (<participants>)
   > "<verbatim source_text>"

## Character Knowledge Boundaries
- <character> knows: <fact>; <fact>
- <character> does NOT know: <secret>

## Relationships
- <from> → <to>: positive (72%) — <description>

[/ChronicleDB Memory Context]
```

The order is load-bearing. If the memory block overflows the configured `maxChars` budget it is truncated at the tail with a `[...truncated]` marker, so the earliest sections (scene, world state, plot threads) survive intact and the most verbose / most-OK-to-truncate sections (relationships) go first.

### Trait canonicalization

Traits are the noisiest thing the extractor emits. A single character easily generates dozens of paraphrases of the same underlying disposition ("stoic" / "keeps his composure" / "unflappable under pressure" / "rarely reacts visibly"). `db.js::upsertTrait` runs every candidate through a layered deduplication pipeline before it lands:

1. **Lexicon gate (zero network cost).** `classifyDisposition` matches the candidate's first meaningful word (and its approximate English stem) against three lexicons shipped in `shared/trait-lexicons.js`:
   - `GOLDBERG_100` — Goldberg's 100 unipolar Big-Five markers plus Saucier's Mini-Markers plus a curated extension from Goldberg's 1,710-adjective hierarchical analysis. Words in this set are auto-accepted as persistent personality traits.
   - `NRC_EMOTION` — the NRC Word-Emotion Association Lexicon (Mohammad and Turney 2013). Words here are presumed transient affect.
   - `NRC_VAD` — a curated subset of NRC Valence-Arousal-Dominance (Mohammad 2018). Words with arousal ≥ 0.55 are rejected outright; low-arousal hits defer to the verifier. NRC lexicon provenance and licensing is documented at the top of `shared/trait-lexicons.js` — the lexicons are embedded as word-membership sets only, not redistributed annotations. Together the two lexicons strip an estimated ~70% of transient-emotion noise before any LLM or embedding call is made. Lexicons total ~5,600 entries. A supplementary `TRAIT_STATE_STEMS` set inside `db.js` catches common narrative mood words the lexicons miss.
2. **Fuzzy pre-check.** Query existing canonical trait rows (`canonical_id IS NULL`) for the same character and category. Match on any of: exact stemmed content equality (Postgres English stemmer via the generated `stemmed_content` column), substring containment either direction, or `pg_trgm similarity` above `TRAIT_SIMILARITY_THRESHOLD = 0.55`. If a hit is found, keep whichever content is longer as the canonical wording.
3. **Contextual embedding.** Build `"${character} is ${content}: ${evidence_sentence}"` and embed it via Gemini. Evidence sentences are one-sentence quotes the extractor was required to attach to every persistent trait (without one, the prompt tells the LLM not to emit the trait at all); the surrounding sentence is what separates "stoic the trait" from "stoic the fleeting mood" in embedding space.
4. **kNN against existing canonicals.** Top-3 nearest canonical rows for the same character and category via the partial HNSW index. Merged variants are deliberately excluded so they cannot re-merge onto themselves.
5. **Decide.**
   - **Cosine ≥ 0.88** — MERGE. The candidate is appended to `aliases[]` on the canonical row, `merged_count` increments, and a merged-variant row is inserted pointing at the canonical via `canonical_id`.
   - **0.80 ≤ cosine < 0.88** — VERIFY. `extractor.verifyTraitPair` calls a tiny LLM classifier (temperature 0, ~32 output tokens) that returns exactly one of `MERGE` / `KEEP_DISTINCT` / `REJECT_NEW`. A process-local cache keyed on `(canonical_id, normalized_candidate)` avoids re-verifying the same pair twice in one ingest. `verified_at` is stamped regardless of outcome, as an observability signal.
   - **Cosine < 0.80** — NEW_CANONICAL. Insert a fresh canonical row with `canonical_id = NULL`.
6. **Per-character summary rollup.** After any canonical insert or merge, `recomputeCharacterSummary` updates `characters.summary_embedding` by running pgvector's native `AVG(embedding)` over every personality-category trait with a non-null embedding for that character. That aggregate is what the HNSW index on `characters.summary_embedding` searches when doing "find similar characters across chats."

User-visible trait reads filter `WHERE canonical_id IS NULL` so merged variants never surface twice. Thresholds and the rationale for them (0.88 merge / 0.80 verify) are in `RESEARCH_TRAITS.md`.

### Structural arc discovery

Story arcs used to come from the extraction LLM naming them per batch, which produced dozens of tiny, fragmented arcs on long chats — cross-batch fragmentation, exact-string dedup on titles, and a proliferation failure mode identical to the Mem0 audit finding. The current implementation throws that out and builds arcs structurally from the event graph instead. `server-plugin/arc-builder.js::rebuildArcsForChat` runs once at the end of `/ingest-chat` and does the following:

1. **Load events, participants, chains.** Every event for the chat, ordered by `message_index`. `participated_in` as a character set per event. `event_chains` collapsed into an undirected edge set.
2. **Build a weighted undirected graph** via `graphology`. For every pair of events the edge weight is:

   ```
   w(i, j) = WC · causal + WE · cos(embedding)    + WP · jaccard(participants)
                         + WL · same_location     - WT · (|Δmsg_idx| / max_gap)
   ```

   with `DEFAULT_WEIGHTS = { WC: 0.5, WE: 0.6, WP: 0.2, WL: 0.4, WT: 1.0, PRUNE: 0.5 }`, `jaccFloor = 0.4` (subtracted from raw Jaccard to recenter past the two-or-three-character baseline), and `cosFloor = 0` (raw cosine is fine). Edges below `PRUNE` are dropped. These are grid-sweep-winning tunables on a reference eval chat; they live behind a named `DEFAULT_WEIGHTS` constant so they can be overridden per-call. O(N²) is fine — a few hundred events means a few hundred thousand cells, all in-memory in Node in milliseconds.
3. **Run Louvain community detection** via `graphology-communities-louvain::louvain.detailed` with a fixed `seed = 42` for reproducibility. The flat pass uses `resolution = 0.5`. A resolution sweep then produces a hierarchy:
   - `γ = 0.25` → super-arcs (level 0), roughly three to six per long chat.
   - `γ = 0.5` → arcs (level 1), identical to the flat output; this is the default and only level retrieval reads by default.
   - `γ = 1.0` → episodes (level 2), roughly 20 to 40 per long chat.

   Super-arcs and episodes only get built when the chat has at least `HIERARCHY_MIN_EVENTS = 100` events; shorter chats stay flat.
4. **Prune and link.** Communities with fewer than `MIN_ARC_SIZE = 3` events are dropped. Survivors sort by their first member's `message_index` so arc IDs increment in chat order. For each surviving community the builder picks a spine event, computes a cluster-density proxy, and writes one `story_arcs` row plus one `arc_events` row per member. Parent/child relationships between the three hierarchy levels are written via `parent_arc_id`. The `source` column is set to `"structural"` on the rebuild, distinguishing these rows from any legacy per-batch LLM-named rows.
5. **Optional LLM naming.** When `nameArcs: true` is passed (as `/ingest-chat` does), each cluster whose density meets `DEFAULT_ARC_NAMING_DENSITY_GATE = 1.5` gets a one-shot `extractor.nameStoryArc` call that takes the spine event plus the first 12 members in chronological order and returns a three-to-seven-word title plus a one-sentence description. Clusters below the density gate get a templated title derived from their spine event. Low-density clusters never blow LLM budget and still end up named.

Retrieval walks the hierarchy as **event → arc → super-arc**. `fetchArcExpansion` restricts its primary arc-join to `COALESCE(sa.hierarchy_level, 1) = 1` so legacy flat rows stay level 1 by default, then LEFT-joins the parent level-0 row via `sa.parent_arc_id` and surfaces it as a breadcrumb. In the rendered `## Matched Event Passages` section each event hit produces up to three nested lines:

```
- [turn 260] <event source quote>
  [super arc: <level-0 title — chat-scale beat>]
  [arc: <level-1 title> (<status>) — <level-1 description>]
  [arc prev pos 45] <preceding level-1 sibling summary>
  [arc next pos 47] <following level-1 sibling summary>
```

The super-arc line is omitted when a hit's level-1 arc has no parent (either the chat is under `HIERARCHY_MIN_EVENTS` and hierarchy wasn't built, or the row is legacy pre-Path-5). Episodes (level 2) are still intentionally excluded from the default expansion — they exist in the schema for future sibling-walk extensions but the current renderer does not surface them. Templated super-arc titles of the form `"Super Arc: <spine event summary>"` render with the `"Super Arc: "` prefix stripped so the `[super arc: ...]` wrapper doesn't duplicate the label. Level-0 and level-2 titles are templated, not LLM-named — `extractor.nameStoryArc` only runs at level 1 today, so super-arc breadcrumbs are serviceable but ugly until you opt into LLM naming across the full hierarchy. Rationale and weight tuning history live in `RESEARCH_ARCS.md`.

### Lorebooks (ST World Info)

ChronicleDB has a dedicated ingest path for SillyTavern lorebook / World Info files. `server-plugin/lorebook.js::ingestLorebook` reads a `worlds/<name>.json` file from the ST data dir and, for every enabled entry, performs the following:

1. Creates a `facts` row with the entry's content (up to 2000 chars), a domain classified by keyword heuristics (`lore`, `secret`, `rule`, `backstory`), and `confidence = 1.0` (lorebook entries are treated as authoritative).
2. If the entry's comment and content look character-like (matches personality / appearance / pronoun heuristics and a short comment), upserts a `characters` row with the entry's keys as aliases and the content as the description.
3. If the entry looks location-like (contains words like "located", "village", "castle", etc.), upserts a `locations` row.
4. Embeds the content (up to 4000 chars, prefixed with the comment and keys) and stores it in `memory_embeddings` with `node_type = 'lore'` and a synthetic `chat_id` of `"lorebook:<lorebook_name>"`.

**Ingest is opt-in and manual.** The UI extension exposes an "Ingest lorebook" button that lists every `.json` file in the ST `worlds/` directory and posts `/lorebooks/ingest` on click. Live-chat ingestion never touches `worlds/` — the extractor only reads message content from the chat `.jsonl`, so lorebook text cannot accidentally leak into extracted events.

**Interaction with ST's native world-info activation.** ST already has a keyword-triggered World Info injection system built into its prompt assembler. Ingesting a lorebook into ChronicleDB does **not** disable ST's native injection; both systems run in parallel. ST injects entries into its own World Info slot based on keyword matches in the recent chat; ChronicleDB stores a copy of the same entries as graph + vector rows for semantic retrieval. Expect some duplication in the assembled prompt when both systems hit the same entry on a given turn; keep lorebooks focused to minimize bloat.

**Retrieval is global-scope for lorebook rows.** The memory_embeddings rows written by lorebook ingest use a synthetic `chat_id` (`lorebook:<name>`) rather than a real chat id, because lorebook entries are world-info facts that should surface regardless of which chat is active. `vectorSearch` and `lexicalSearch` on `memory_embeddings` OR-match `chat_id = ANY($selectedChats)` *plus* `chat_id LIKE 'lorebook:%'`, so every ingested lorebook is discoverable by every chat's hybrid search. There is no character-level lorebook selector today — all ingested lorebooks are visible everywhere. The `chat_id` and `node_type` columns are included in the returned rows so downstream code can distinguish `node_type='lore'` hits from regular chat passages for debug or UI purposes. Event, dialogue, snapshot, and knowledge-boundary searches remain strictly chat-scoped because lorebook rows never land in those tables.

### Chat scoping

Parallel roleplays with the same character must not bleed into each other. Every chat-scoped subsystem filters by `chat_id`:

- `events`, `memory_embeddings`, `dialogue_quotes`, `context_snapshots`, `plot_threads`, `story_arcs`, `items`, `knows`, `present_at`, `world_state` all carry a `chat_id` column.
- `feels_about` is scoped by `session_id`.
- `traits` are keyed by `(character_id, source_chat)`; the character rows themselves are global but their per-chat traits are scoped. The character memory panel and the mindmap both accept a `chat_id` query parameter to filter the trait view.
- Every graph traversal, retrieval query, and panel query filters on `chat_id`. Cross-chat queries are explicitly opt-in via the per-character `selectedChats` preference in the ST UI.
- Items are content-addressed by `(name, chat_id)` so the same-named item in two chats becomes two rows.
- `world_state` supersession (the `valid_until` bi-temporal write) is scoped so one chat cannot kick another chat's state into `valid_until`. Legacy NULL-chat rows remain queryable as a global fallback.

## Setup

### Prerequisites

- A SillyTavern install with server plugins enabled (running at least once so `config.yaml` exists)
- Node.js 18 or newer
- An API key for the extraction LLM (Gemini is the default and cheapest — see "LLM keys" below). Vertex AI Express-mode API keys and any OpenAI-compatible endpoint also work; pick the provider in the **API type** dropdown.
- A PostgreSQL 14+ database with the **pgvector** extension. You have two options for this:

#### Option A — Use a free hosted Postgres (easiest, no local install)

If you don't want to install PostgreSQL on your own machine, use a free hosted instance. Both providers below come with **pgvector pre-installed** and have free tiers generous enough for years of roleplay chats:

| provider | free tier | how to enable pgvector |
|---|---|---|
| **[Neon](https://neon.tech)** | 0.5 GB storage, autosuspends after 5 min idle (1-2 s wake-up on next message) | After project creation, click **SQL Editor** and run `CREATE EXTENSION vector;` once |
| **[Supabase](https://supabase.com)** | 500 MB storage, no idle suspension | **Database → Extensions** in the dashboard, search for `vector`, toggle on |

**Walkthrough (Neon, fastest):**

1. Sign up at <https://neon.tech> with email or GitHub
2. Create a project. Pick the closest region. Default Postgres 16+ is fine.
3. Copy the connection string Neon shows you. It looks like:
   ```
   postgresql://username:AbCdEf123456@ep-cool-name-abc123.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. Open the Neon SQL Editor (left sidebar) and run:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   ```
5. In the ChronicleDB settings panel, split the connection string into the 5 fields:

   | URL part | example value | settings field |
   |---|---|---|
   | `username` | `username` | **User** |
   | password (after `:`) | `AbCdEf123456` | **Password** |
   | host (after `@`) | `ep-cool-name-abc123.us-east-2.aws.neon.tech` | **Host** |
   | port (default `5432`) | `5432` | **Port** |
   | database (path component) | `neondb` | **Database** |

6. Click **Connect & initialize**. Done.

> **Privacy note:** chat content goes through the hosted provider on every retrieve and ingest. If your roleplays contain anything you wouldn't want a third party to see, use the local install option instead. Hosted Postgres is the right answer for "I just want this to work and I'm not paranoid about my chats."

#### Option B — Install PostgreSQL + pgvector locally

If you want everything on your own machine (privacy, no internet dependency, no provider sign-up), install Postgres + pgvector once. The one-shot installer (`install.sh`, below) checks for these and offers to install them for you on macOS and Linux. If you'd rather do it manually:

| | macOS (Homebrew) | Linux (Debian/Ubuntu) | Windows |
|---|---|---|---|
| **Node 18+** | `brew install node` | use [NodeSource](https://github.com/nodesource/distributions) | [nodejs.org installer](https://nodejs.org/en/download/) |
| **Postgres 17** | `brew install postgresql@17 && brew services start postgresql@17` | `sudo apt-get install postgresql-17 && sudo systemctl start postgresql` | [EnterpriseDB Windows installer](https://www.postgresql.org/download/windows/) — graphical, click-through |
| **pgvector** | `brew install pgvector` | `sudo apt-get install postgresql-17-pgvector` | follow the [pgvector Windows install](https://github.com/pgvector/pgvector#windows) section (uses `nmake` against your installed Postgres) |
| **Create role on Linux first time** | not needed | `sudo -u postgres createuser --superuser "$USER"` | the EDB installer prompts you for a superuser password |

> `pg_trgm` ships with Postgres core and needs no separate install. `pgvector` does — `CREATE EXTENSION vector` will fail until the binary is on disk. The Windows install path is the rockiest of the three; if you're on Windows and don't want to mess with `nmake`, **use Option A (Neon)** instead — it skips this entire section.

#### One-shot install (recommended)

Once the prerequisites above are in place, run **one command**:

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/alani-fan-club/chronicledb/master/install.sh)
```

The installer is idempotent and walks through everything for you:

1. Detects your SillyTavern install (auto-finds the common locations or prompts once)
2. Verifies Node ≥ 18, Postgres ≥ 14, and pgvector is available
3. Clones the repo to `~/.chronicledb`
4. Runs `npm install` inside `server-plugin/` so the plugin's dependencies land
5. Symlinks the server plugin to `<SillyTavern>/plugins/chronicle-db`
6. Symlinks the UI extension to `<SillyTavern>/public/scripts/extensions/third-party/chronicle-db` (the **correct** location — not `data/<user>/extensions/`, which is a common wrong guess)
7. Patches `<SillyTavern>/config.yaml` to set `enableServerPlugins: true`
8. Creates the `chronicledb` database and enables the `vector` and `pg_trgm` extensions

When it finishes, restart SillyTavern, open **Extensions → ChronicleDB**, paste your Gemini API key, and click **Connect & initialize**. That's it.

Re-running `install.sh` later is safe — it detects existing symlinks, an existing repo clone, and an existing database, and only fixes drift.

#### Manual install (only if the script fails or you want full control)

<details>
<summary>Click to expand the step-by-step manual install</summary>

##### 1. Create the database and enable extensions

```sh
createdb chronicledb
psql -d chronicledb -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
```

If `createdb` fails on permissions, you may need `sudo -u postgres createdb chronicledb` or to first `CREATE ROLE <you> SUPERUSER` as the postgres user.

##### 2. Clone the repo

```sh
git clone https://github.com/alani-fan-club/chronicledb.git ~/.chronicledb
```

##### 3. Install the plugin's Node dependencies

The server plugin has its own `package.json` with `graphology`, `graphology-communities-louvain`, `pg`, `pgvector`, and `dotenv`. **Without this step the plugin crashes on first `require`** with `Cannot find module 'graphology'`. The root `package.json` and `shared/package.json` do **not** need installing.

```sh
cd ~/.chronicledb/server-plugin
npm install
```

##### 4. Symlink the server plugin into SillyTavern

ST loads server plugins from `<SillyTavern>/plugins/<plugin-id>/`. The plugin id is `chronicle-db`, so the symlink target name must be exactly `chronicle-db`:

```sh
ln -s ~/.chronicledb/server-plugin /path/to/SillyTavern/plugins/chronicle-db
```

##### 5. Enable server plugins in SillyTavern's config

Edit `<SillyTavern>/config.yaml`:

```yaml
enableServerPlugins: true
enableServerPluginsAutoUpdate: false  # optional but recommended — stops ST from running `git pull` on the plugin
```

##### 6. Symlink the UI extension into SillyTavern

ST auto-discovers third-party UI extensions from `<SillyTavern>/public/scripts/extensions/third-party/<id>/`:

```sh
ln -s ~/.chronicledb/ui-extension /path/to/SillyTavern/public/scripts/extensions/third-party/chronicle-db
```

> **Common pitfall:** do **not** symlink under `<SillyTavern>/data/<user>/extensions/`. That directory is for a different category of extension and ST will **not** load a `manifest.json` from there. If ChronicleDB does not appear in the Extensions panel after restarting ST, this is the reason 95% of the time. Verify with `ls -la <SillyTavern>/public/scripts/extensions/third-party/chronicle-db` — the symlink should point at `ui-extension/` and that directory should contain `manifest.json`, `index.js`, `style.css`, `character-panel.html`, and `settings.html`.

##### 7. Restart SillyTavern and configure

Restart ST, open **Extensions → ChronicleDB**, fill in:

- Database panel: host (`localhost`), port (`5432`), database (`chronicledb`), user, password
- LLM panel: Gemini API key (or any OpenAI-compatible endpoint), extraction model, embedding model

Click **Connect & initialize**. The ST server console should show:

```
[ChronicleDB] Initializing server plugin...
[ChronicleDB] Server plugin ready.
[ChronicleDB] Schema initialized.
[ChronicleDB] Auto-connected to database.
```

Every subsequent ST boot will auto-connect using the cached `.settings-cache.json` file the panel writes for you.

##### 8. Verify the install

```sh
curl -s -u <st-user>:<st-pass> http://127.0.0.1:8000/api/plugins/chronicle-db/status
# Expected: {"connected":true,"configured":true,"error":null,"initializedAt":"..."}

psql -d chronicledb -c "\dt"
# Expected: ~20 tables including characters, events, traits, story_arcs, memory_embeddings
```

If `/status` returns `{"connected":false,...}`, check `server-plugin/.settings-cache.json` and the ST server log for the `[ChronicleDB]` lines around boot.

</details>

### Schema bootstrap

The full schema lives in `server-plugin/schema.sql` and is written to be idempotent. Every `CREATE TABLE` uses `IF NOT EXISTS`, every index uses `CREATE INDEX IF NOT EXISTS`, and every column added after the initial schema uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. `db.js::initSchema` reads the file, strips line comments before splitting on `;` (to avoid mid-comment syntax errors), and executes each statement, ignoring `already exists` warnings. There is no migration framework — ChronicleDB is deployed in-place against live databases and every schema change has to be forward-compatible with older deployments. `MIGRATIONS.md` documents the canonical pattern plus the full list of post-initial-schema deltas currently living in `schema.sql` and notes which of them needs a dedicated backfill script.

## Using it

### Ingesting a chat

There are two ways to get a chat file into memory:

- **Manual ingest.** `POST /api/plugins/chronicle-db/ingest-chat` with `{ characterName, filename }`. The plugin finds the character's chat directory under `settings.stDataRoot/chats/<characterName>/`, reads the given `.jsonl`, parses the header plus messages, runs the full extract → graph → vector → arc-rebuild pipeline, and writes an `ingestion_status` row. The ST UI exposes this via the per-character chat selector and a "Build memory from all" button.
- **Auto-ingest.** Set `autoIngest: true` (the default). The UI extension hooks `GENERATION_ENDED` and, every `extractEveryN` messages (default 1), posts the last ten messages to `/extract`. Extraction runs in the background so it does not block the chat loop. Disable `autoIngest` if you only want memory built from chats you explicitly pick.

### Retrieval

Retrieval is invoked on every turn by the UI extension. It hooks `GENERATION_STARTED`, joins the last ten messages of the current chat into a single `recentText` string (truncated to 4000 chars), posts to `/retrieve`, and calls ST's `setExtensionPrompt` with the returned `memoryBlock` so ST injects it into the system prompt ahead of generation. `maxInjectionTokens` in the ST settings panel (default 3000 tokens, roughly 12,000 characters) caps the block size.

### Admin endpoints

Every plugin endpoint lives under `/api/plugins/chronicle-db/` (defined in `server-plugin/index.js`):

- `GET /status` — connection state (connected, configured, error, `initializedAt`).
- `POST /settings`, `GET /settings` — push and read settings. `POST` triggers an auto-reconnect when credentials change or when the plugin is not currently connected, and caches settings to `.settings-cache.json` so the next boot can auto-connect.
- `POST /init-db` — run `initSchema` and mark the plugin as initialized.
- `POST /extract` — one-batch extraction from a live turn.
- `POST /retrieve` — hybrid search plus memory block.
- `GET /chats/:characterName` — list chat files for a character (enriched with ingestion status).
- `GET /chats` — list every chat that finished ingesting, for the mindmap filter dropdown.
- `POST /ingest-chat` — full-chat batch ingest.
- `GET /character-config/:characterName`, `POST /character-config/:characterName` — get and set per-character memory config (`sessionMode`, `selectedChats`).
- `GET /characters` — list all characters (for the mindmap dropdown).
- `GET /character/:name/traits` — traits for a character, optionally scoped to a `chat_id`. Filters out merged canonical-variant rows.
- `GET /character-stats`, `GET /character-recent-events`, `GET /character-relationships`, `GET /character-memory-config`, `POST /character-memory-config`, `POST /character-clear-memories` — the feed for the per-character memory panel in the ST character card sidebar.
- `POST /recompute-character-summaries` — rebuild `characters.summary_embedding` for every character by mean-pooling its current personality trait embeddings. Safe to re-run; no-op for characters whose traits have not been embedded yet.
- `GET /character-cards`, `GET /character-image/:filename` — proxy for ST's character PNGs so the standalone mindmap can show avatars.
- `GET /graph` — graph data for the mindmap, with `scope=global|character`, `depth`, and `chat_id` query parameters.
- `GET /memories/:chatId`, `DELETE /memories/:id` — direct memory_embeddings CRUD, used for debugging.
- `GET /lorebooks`, `POST /lorebooks/ingest` — list and ingest ST lorebook JSON files. Each entry becomes a `facts` row plus an optional `characters` / `locations` row via keyword heuristics, plus a `memory_embeddings` chunk under synthetic `chat_id = "lorebook:<name>"`. See the "Lorebooks (ST World Info)" section under Architecture for the retrieval caveat.
- `GET /map` — serves the standalone mindmap UI statically from `src/ui/`.

### UI

The UI extension under `ui-extension/` provides three user-facing pieces inside SillyTavern:

- **ChronicleDB settings drawer.** Added to the extensions settings area. Holds database connection, memory-mode selector (persistent / isolated / read-only), extraction and embedding model fields, the behavior toggles (auto-ingest, extract-every-N, memory budget), the "what to remember" toggles, the per-character chat selector, lorebook ingestion, and a button that opens the mindmap.
- **Per-character memory panel.** Mounted into the ST character card sidebar. Shows stats, recent memories, and relationships for the character whose card is open, plus a per-character memory-mode override and a "Clear memories for this character" button that calls `/character-clear-memories`.
- **Mindmap.** A standalone Cytoscape-based visualization served from `src/ui/` at `/api/plugins/chronicle-db/map`. Opens in a new tab and reads `/graph`, `/characters`, `/chats`, and `/character/:name/traits` to render the character-event graph for a chat (or globally). A dropdown scopes it to a specific chat.

## Settings reference

Settings are pushed from the ST UI via `POST /settings` and cached to `.settings-cache.json` on disk. The server reads them through an in-memory `settings` object rather than an env-var layer, so credential hot-swaps work without a restart. The canonical keys are defined in `ui-extension/index.js::DEFAULT_SETTINGS`:

- `enabled` — master switch.
- `pgHost`, `pgPort`, `pgDatabase`, `pgUser`, `pgPassword` — Postgres credentials.
- `stDataRoot` — absolute path to the ST data directory (used by `/chats` and `/ingest-chat` to find chat files).
- `extractionApiType` — `"gemini"` (default), `"vertex"` (Vertex AI Express-mode API keys against `aiplatform.googleapis.com`; the key rides on `?key=` instead of the `x-goog-api-key` header that Vertex rejects), or `"openai"` (any OpenAI-compatible `/chat/completions` endpoint).
- `extractionApiUrl`, `extractionApiKey`, `extractionModel` — the extraction LLM. Default model is `gemini-2.5-flash-lite`. For `"vertex"`, point `extractionApiUrl` at `https://aiplatform.googleapis.com/v1/publishers/google` (the default) or your own regional endpoint.
- `embeddingApiType` — `"gemini"` (default), `"vertex"`, or `"openai"`. Vertex embeddings go through `:predict` with `outputDimensionality` so a default install hits the schema's 768-dim constraint with `text-embedding-004`. OpenAI-compatible `/embeddings` endpoints send `{model, input, dimensions}` and read `data[].embedding` (works with OpenAI proper, Azure OpenAI, Mistral, Voyage, Cohere, Ollama, LM Studio, vLLM, OpenRouter, LiteLLM, etc.).
- `embeddingApiKey`, `embeddingApiUrl`, `embeddingModel`, `embeddingDimension` — generic embedding settings. If `embeddingApiKey` is blank the plugin falls back to `geminiApiKey` (which itself falls back to `extractionApiKey` for the gemini path) so users on the legacy field set don't have to re-enter their key. Schema is fixed at `vector(768)` so embeddingDimension must be 768 — pick a model that produces 768-dim output (Gemini's `gemini-embedding-2-preview`, OpenAI's `text-embedding-3-small` with `dimensions: 768`, or `nomic-embed-text` natively).
- `geminiApiKey`, `geminiEmbeddingModel`, `geminiEmbeddingDimension` — legacy gemini-prefixed settings. Still honored for backward compat; new installs should prefer the generic `embedding*` names above.
- `extractEveryN` — fire extraction every N AI replies (default 1).
- `extractionBatchSize` — messages per extraction call on the bulk path (default 10).
- `extractionConcurrency` — parallel extraction calls per group on the bulk path (default 1).
- `ingestContextWindow` — messages on each side used to build situating blurbs (default 4).
- `autoIngest` — fire extraction automatically after every AI turn.
- `maxInjectionTokens` — cap on the memory block size in tokens (default 3000; converted to a character budget at 4 chars per token in `retriever.js::formatMemoryBlock`).
- `enableRelationships`, `enableEvents`, `enableKnowledge`, `enableWorldState` — "what to remember" toggles.
- `sessionMode` — global default memory mode: `persistent` / `isolated` / `readonly`. Per-character overrides live in `character_memory_config`.
- `initialized` — flipped true on the first successful `/init-db`; persisted so subsequent boots auto-reconnect.
- `verifierModel`, `arcNamingModel`, `contextModel` — optional per-role model overrides; all fall back to `extractionModel`.

The full hardcoded retrieval and arc-builder tunables (RRF constant, recency α, per-kind caps, arc edge weights, Louvain resolutions) live in code rather than in settings. `shared/retrieval-core.js::SECTION_LIMITS` defines the per-section character budgets inside the memory block, and `server-plugin/arc-builder.js::DEFAULT_WEIGHTS` defines the arc-builder edge weights.

## What makes this different

None of this is novel on its own. The value prop is in which ideas got combined and what got cut.

- **Character-centric bipartite graph, not a flat fact store.** Events are first-class nodes; `participated_in` is a bipartite edge to characters; `event_chains` carries causal structure; retrieval has a graph-expansion boost over participated-in so named characters in the query can surface events even when they do not appear in the dense top-K. Mem0-style flat memory blobs, LangMem-style append-only summaries, and MemGPT/Letta's file-backed buffers do not have this shape at all; Zep/Graphiti does, which is the closest architectural cousin here. ChronicleDB's cut of that is specifically the roleplay case: traits, sentiment, knowledge boundaries, plot threads, scene snapshots.
- **Structural arc discovery instead of per-batch LLM arc naming.** `arc-builder.js` clusters events with Louvain on a five-signal weighted graph (causal chains, contextual event embedding cosine, participant Jaccard minus baseline, shared location, temporal proximity penalty) and only LLM-names the surviving clusters, at one call per cluster, gated on density. The old per-batch LLM-named approach produced dozens of fragmented arcs on long chats; the structural approach produces a handful of cohesive ones. Reasoning and tuning history is in `RESEARCH_ARCS.md`.
- **Trait canonicalization via lexicon gate plus contextual embedding plus LLM verifier.** Every candidate persistent trait goes through the Goldberg Big-Five whitelist plus NRC emotion blocklist (filtering roughly 70% of transient-affect noise before any LLM or embedding call), then a fuzzy SQL pre-check, then a contextual `"${character} is ${trait}: ${evidence}"` embedding, then kNN against canonical rows, then a three-outcome LLM verifier for the ambiguous 0.80-0.88 cosine band. "Every trait is a paraphrase" is the failure mode the Mem0 audit documented; `RESEARCH_TRAITS.md` walks through how this pipeline handles it.
- **Per-chat scoping everywhere.** Every chat-scoped subsystem filters by `chat_id`. You can run the same character in two parallel roleplays and they do not leak facts, sentiment, or items into each other. Cross-chat retrieval is explicitly opt-in via a per-character chat picker.
- **Contextual retrieval plus hybrid lexical-plus-dense plus graph expansion plus neighbor padding in one compact pipeline.** The Anthropic contextual retrieval pattern, dense-plus-BM25 fusion, dialogue-quote trigram similarity for paraphrase, and ±1 message neighbor padding around memory hits all live in `shared/retrieval-core.js` and are reusable from any caller that can provide a node-postgres pool.

Things that are not here yet, and the README is not going to lie about:

- HyDE query rewriting and cross-encoder reranking are not part of the live ST retrieval path. They have been prototyped outside the server plugin but are not wired through `server-plugin/retriever.js`.
- Incremental arc rebuild: arcs are currently rebuilt end-to-end at the end of `/ingest-chat`. An incremental clusterer is future work.
- Bi-temporal edges on relationships (Zep/Graphiti-style). `feels_about` supports a single current state per `session_id` and `world_state` has `valid_from / valid_until`, but trait history is not versioned.
- Multi-embedder support. Only Gemini is wired for embeddings. Extraction supports Gemini and OpenAI-compatible endpoints; embeddings do not.
- A test suite. There are no committed automated tests. The project relies on smoke scripts and manual verification against live chats.

## Development

### Running the plugin locally

The plugin has no standalone run mode; it is loaded by SillyTavern as a server plugin. Development loop is:

1. Symlink `server-plugin/` into the ST plugins directory (see Install above).
2. Start ST. The plugin loads via `init(router)`.
3. Edit files under `server-plugin/`, `shared/`, or `ui-extension/` and restart ST to reload. There is no hot-reload for plugin code.
4. Settings live in the ST UI panel; they are POSTed to `/settings` on change, cached to `.settings-cache.json`, and used to hot-swap the database pool via `db.getPool(settings)`. Changing credentials in the UI is safe — the plugin reconnects in the background without requiring a restart.
5. If you need to run anything outside ST (e.g. a backfill script), the scripts under `server-plugin/` read credentials and the Gemini API key from a local `.env` file.

### Debug and backfill scripts

Under `server-plugin/`:

- `backfill-trait-embeddings.js` — walks every trait with a NULL `embedding`, builds the contextual embedding text (`"${name} is ${content}"` without evidence for legacy rows), embeds via `embedBatch`, updates the row, then runs a canonical-merge pass per `(character_id, category)` group ordered by length, populating `canonical_id` / `aliases` / `merged_count` for any rows whose cosine to an earlier canonical is at least 0.88. Finishes with a `recomputeCharacterSummary` sweep over every character. Idempotent. Run this once after pulling the trait canonicalization pipeline for the first time against an existing database.
- `backfill-multi-granularity-embeddings.js` — populates `events.embedding` and `context_snapshots.embedding` for legacy rows where they are NULL. Scoped by a `chat_id LIKE` pattern. Run this before running the arc builder against legacy chats; without event embeddings, the arc-builder's cosine term has no signal.
- `backfill-context-prefix.js` — populates `memory_embeddings.context_prefix` for legacy rows by regenerating the situating blurb from the surrounding ±4 messages. Scoped by a `chat_id LIKE` pattern. Expensive (one LLM call per row). Only needed if you want contextual retrieval on chats that were ingested before the `context_prefix` column existed.
- `ingest-standalone.js` — a reference full-chat ingest runner that does the same work as `POST /ingest-chat` without needing ST running. Useful for quick reingests from the command line.

### Tests

There are no committed automated tests. The project relies on smoke scripts plus manual verification against live chats — solo-dev, fast-iteration trade-off. The `test/` directory exists but is empty. If you add tests, `package.json` has `vitest` wired as the test runner.

## Design notes and research

Two long-form research documents live at the repo root and are worth reading if you want the reasoning behind the trait and arc pipelines:

- [`RESEARCH_TRAITS.md`](RESEARCH_TRAITS.md) — why naive single-pass LLM trait extraction fails, why short-string embeddings are brittle, what Mem0 / Zep-Graphiti / Cognee / EDC / LangMem actually do, and how the Goldberg lexical-hypothesis line gives you a free dispositional-vs-transient gate. Drives the trait canonicalization pipeline in `db.js::upsertTrait`.
- [`RESEARCH_ARCS.md`](RESEARCH_ARCS.md) — why per-batch LLM-named arcs are structurally unsalvageable, which narrative-NLP and community-detection literature applies, why Louvain on a five-signal weighted event graph beats HDBSCAN on embeddings alone, and what the tuning history for `DEFAULT_WEIGHTS` and `DEFAULT_RESOLUTION` looks like. Drives `arc-builder.js::rebuildArcsForChat`.

Both of these were written before the respective pipelines were implemented and are still usable as design docs.

[`MIGRATIONS.md`](MIGRATIONS.md) documents the exact `ALTER` / backfill pairs currently living in `schema.sql`, the forward-compatibility pattern, and why there is no migration framework.

[`REVIEW.md`](REVIEW.md) is an architectural self-review covering code-level drift between the ST plugin path and other consumers of the retrieval core, the N+1 collapses in `getKnowledgeBoundaries`, and a handful of smaller cleanups. Useful context for anyone touching `server-plugin/db.js` or `shared/retrieval-core.js`.

## License

No LICENSE file is committed yet; licensing is pending. Note that `shared/trait-lexicons.js` embeds word-membership subsets of the NRC Emotion Lexicon and NRC-VAD lexicon; those are free for research and non-commercial use only under the National Research Council Canada's terms (see the provenance block at the top of the file), and only word-membership sets are redistributed here, not full annotations. Commercial use requires a license from NRC.
