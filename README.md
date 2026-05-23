# ChronicleDB

Persistent graph + vector memory for SillyTavern roleplays. Drops in as a server plugin, extracts characters / events / relationships / world state / dialogue / scene snapshots from each chat batch, and injects a relevant memory block on every turn so the model sees the past without re-stuffing scrollback into context.

## Install

→ **https://alanifan.club/projects/chronicledb/install.html**

The install page covers both paths:
- **Zip install (recommended)** — embedded PGlite (pure-JS Postgres + pgvector + pg_trgm), no system install required.
- **Git + Postgres** — for self-hosted Postgres or cloud DB (Neon, Supabase) users who want master-branch updates.

After install, configure in SillyTavern's extensions panel:
- Storage backend (embedded PGlite or external Postgres)
- Extraction LLM — Gemini, Vertex AI (Express key), or any OpenAI-compatible endpoint (OpenAI, Mistral, Ollama, LM Studio, vLLM, OpenRouter, LiteLLM, ...). A cheap fast model is fine. Default suggestion: `gemini-3.1-flash-lite-preview`.
- Embedding model — same three provider types. The schema is fixed at 768 dimensions, so pick a native 768-dim model or one that honors a `dimensions` parameter (OpenAI `text-embedding-3-small` / `3-large`, Vertex `text-embedding-004` / `005`, Gemini `gemini-embedding-2-preview`).
- Per-character session mode: persistent / isolated / read-only
- Token budget and memory-type toggles

## What you get

Every chat update calls `/extract`. A cheap LLM reads the latest batch and emits structured entities — characters, events, traits, dialogue quotes, world-state deltas, plot threads — which the plugin upserts into a relational graph with pgvector embeddings. On every generation, `/retrieve` runs a six-source hybrid search (dense + lexical over memory passages, dense + lexical over event source text, tsvector + trigram over dialogue, dense over scene snapshots), fuses via Reciprocal Rank Fusion, boosts events where mentioned characters participated, expands top hits with their story arc, pads memory hits with their ±1 neighbor messages, and renders a `[ChronicleDB Memory Context]` block that SillyTavern injects into the prompt.

```
ST chat turn ──▶ /extract  ──▶ extractor LLM  ──▶ Postgres (graph + vector)
ST chat turn ──▶ /retrieve ──▶ hybrid search  ──▶ [ChronicleDB Memory Context]
```

## What makes this different

None of this is novel on its own — the value is in which ideas got combined.

- **Character-centric bipartite graph, not a flat fact store.** Events are first-class nodes; `participated_in` is a bipartite edge to characters; retrieval has a graph-expansion boost so named characters in the current message can surface their events even when those events do not appear in the dense top-K. Closest architectural cousin is Zep/Graphiti; the roleplay-specific cut adds traits, sentiment, knowledge boundaries, plot threads, and scene snapshots.
- **Structural arc discovery instead of per-batch LLM naming.** Louvain community detection over a five-signal weighted event graph (causal chains, contextual event-embedding cosine, participant Jaccard, shared location, temporal proximity) clusters events into super-arc / arc / episode tiers and only LLM-names the surviving clusters — one call per cluster, density-gated. Produces a handful of cohesive arcs on long chats instead of the fragmented dozens the per-batch approach generated.
- **Trait canonicalization via lexicon gate + contextual embedding + LLM verifier.** Candidate persistent traits pass through a Big-Five whitelist + NRC-emotion blocklist (filters ~70% of transient-affect noise before any embedding call), a fuzzy SQL pre-check, a `"${character} is ${trait}: ${evidence}"` contextual embedding, kNN against existing canonicals, and a three-outcome LLM verifier in the 0.80–0.88 cosine band. "Stoic" / "unflappable" / "keeps composure under pressure" collapse into one canonical row.
- **Per-chat scoping everywhere.** Every chat-scoped subsystem filters by `chat_id`. Parallel roleplays with the same character do not leak facts, sentiment, or items into each other. Cross-chat retrieval is explicit opt-in via a per-character chat picker.
- **Global persona pool for the user.** AI characters stay chat-scoped, but the user persona accumulates traits across every chat they appear in. A fresh roleplay sees the persona's established dispositions immediately.

## Backends

Embedded PGlite is the default and requires nothing beyond `npm install` — `@electric-sql/pglite` bundles a pure-JS Postgres with pgvector, pg_trgm, and btree_gin. Storage lives at `~/.chronicledb/pgdata`.

External Postgres works against any pg-compatible server. Tested on local Postgres 17, Neon, and Supabase. Set `dbBackend: "external"` in settings and fill in the connection fields; the plugin reconnects without a restart.

## License

No LICENSE file committed; licensing is pending.

`shared/trait-lexicons.js` embeds word-membership subsets of the NRC Emotion Lexicon and NRC-VAD lexicon. Those are free for research and non-commercial use only under the National Research Council Canada's terms (see the provenance block at the top of the file). Only word-membership sets are redistributed here, not full annotations. Commercial use requires a license from NRC.
