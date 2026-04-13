# Narrative Arc Extraction as Emergent Structure from an Event Graph

A research review for ChronicleDB. Focus: replacing per-batch LLM-named arcs with arcs that *emerge* from the temporally ordered event graph we already have (449 events, 273 causal chains, 768-dim contextual event embeddings, character-event bipartite, location identity, message-index total order). Targeted at a single-chat Postgres + pgvector + Node setup. No new infrastructure.

## TL;DR

1. **Per-batch LLM-invented arc titles are structurally unsalvageable.** The current pipeline hands the LLM 10 messages and asks it for "arcs like in manga/anime", so it coins a new title each batch. On the Protagonist 2025-11-18 eval chat (449 events, 273 `event_chains`), this produced **77 arcs averaging 5.17 events each (mode 4, max 15)** — fragmentation is absolute because dedup is exact-string. Every literature fix for this shape of problem says the same thing: **stop naming, then clustering. Cluster first, then name from the cluster.** ([Chambers & Jurafsky ACL 2008](https://aclanthology.org/P08-1090/); [Bamman et al. EMNLP 2019](https://aclanthology.org/D19-1111/); [Zep/Graphiti 2025](https://arxiv.org/abs/2501.13956))
2. **The event graph already has more structure than the clustering needs.** Event-to-event causal edges (`caused | triggered | led_to | followed_by`) + 768-dim contextual embeddings + shared `participated_in` + shared `location_id` + `message_index` proximity is a **five-signal similarity function**. On 449 nodes this is small enough that the naive O(N²) similarity matrix is <200K cells and runs in-process in Node in well under a second. **No graph DB needed.**
3. **The right algorithm family is community detection on a weighted sparse graph, not HDBSCAN on embeddings alone.** Louvain/Leiden have been the production default for document/event clustering for a decade because they (a) respect edge structure, (b) are deterministic-enough with a fixed seed, (c) require no `k` parameter, (d) handle narrative's natural "lumpy with bridges" topology, and (e) run in near-linear time. The narrative-graph literature (BookNLP, NarrativeTime, Chambers's schemas) all either use Louvain-family community detection or hierarchical agglomerative — not density-based clustering on raw embeddings. Dense embeddings alone ignore causal structure, which is exactly what distinguishes an "arc" from a "topic cluster." ([Traag, Waltman, van Eck 2019 — Leiden](https://arxiv.org/abs/1810.08473); [BookNLP](https://github.com/booknlp/booknlp); [graphology-communities-louvain](https://github.com/graphology/graphology/tree/master/src/communities-louvain))
4. **Arc naming should be a one-shot LLM call per cluster, not per batch.** After structural clustering, you call the LLM at most once per discovered arc, passing the cluster's spine event + member summaries, to get a canonical title. For the eval chat that's ~10–15 calls instead of today's ~46 per-batch extraction calls each emitting 1-3 arcs (which is ~70-130 arc-naming decisions today, all ungrounded). The Mem0 "tiny update gate" pattern applies cleanly ([Mem0 audit fix #4573](https://github.com/mem0ai/mem0/issues/4573)).
5. **Ingestion must not get slower.** The cheapest real fix is to run clustering **once, post-ingest**, as the final step inside `/ingest-chat` after the batch loop — not per-batch. This is what Graphiti does for its community layer ([Zep paper, §3.2](https://arxiv.org/abs/2501.13956)) and it costs O(N²) in Node against 449 events, which is milliseconds. Incremental re-cluster on append is a Phase-2 optimization, not a Phase-1 requirement.
6. **Retrieval already has the right shape — the new arcs just populate the same table.** `fetchArcExpansion()` in `shared/retrieval-core.js` joins `arc_events` + `story_arcs` and returns ±1 neighbors by `position`. If the new pipeline writes cluster members back into `arc_events` with `position = message_index_rank_within_cluster` and `is_anchor = (event_id = spine_event_id)`, **retrieval requires zero code changes**. That is the shape of the goalpost.

The four concrete implementation paths, ranked, are in §5.

---

## 1. What the current pipeline does and why it breaks

### 1.1 The current pipeline

`server-plugin/extractor.js` has one prompt (`EXTRACTION_PROMPT`) with a section:

> **5. Story arcs** — identify narrative arcs like in manga/anime. An arc is a set of connected events that form a coherent story beat. Examples: "The Betrayal Arc", "First Meeting Arc", "Confession Arc", "Training Arc". Each arc has a defining "spine" event (the most important one) and flavor events around it.

The prompt instructs the LLM to emit `story_arcs[]` **inside the same call** that also emits characters, traits, events, event_chains, world state, items, plot threads, dialogue, snapshots. Each call processes a **10-message batch**. `applyExtractionToGraph` (extractor.js:737) then calls `db.upsertStoryArc` (db.js:741) which upserts by `(chat_id, title)` — i.e. **exact-string title match is the only dedup mechanism**.

The LLM, seeing 10 messages of context and no memory of prior batches' arc titles, has to guess. When the same story beat crosses a batch boundary it sees it as a new phenomenon and invents a new title. When two batches both land in the same beat but frame it differently (e.g. "the audition" vs "the musician audition"), both titles stick and end up as separate rows.

### 1.2 The observed breakage

From the live DB on the Protagonist 2025-11-18 chat after the reingest:

| metric | value |
|---|---|
| events | 449 |
| event_chains | 273 |
| story_arcs | 77 |
| avg events per arc | 5.17 |
| mode events per arc | 4 |
| max events in one arc | 15 |
| characters with ≥1 `participated_in` | 77 |
| event_chains.chain_type values | `caused`, `followed_by`, `triggered`, `led_to` |

**77 arcs for a 457-message chat is structurally wrong.** A single chat with 273 causal links should produce roughly one arc per ~30 messages — call it 12–18 arcs — based on published conventions for chapter-level narrative segmentation ([Bamman et al. 2019, §4.2, "book-scale event segmentation"](https://aclanthology.org/D19-1111/)) and the manga/anime-arc analogy the user is targeting (typical shōnen arcs span 10–40 chapters ≈ 20–80 events at ChronicleDB granularity).

Three failure modes compound:

1. **Cross-batch fragmentation.** Each 10-message batch is independently named. Same beat straddling two batches = two arcs.
2. **Intra-batch over-splitting.** A batch frequently contains both the tail of arc A and the head of arc B. The LLM, seeing both, conscientiously emits *both* and then the exact-title rule preserves both as independent rows even when A already exists in the DB under a near-identical name.
3. **No structural grounding.** The LLM never sees `event_chains`, never sees `participated_in`, never sees the chat-wide message-index distribution. It is inventing arcs from text alone. Meanwhile the graph has all five signals (causal, semantic, character, location, temporal) sitting unused.

The shape of the breakage matches the Mem0 audit finding ([issue #4573](https://github.com/mem0ai/mem0/issues/4573)) almost exactly: the generative extract step works, but there's no discriminative resolve/merge step, so proliferation is unbounded.

---

## 2. State of the art

### 2.1 Narrative NLP and story-graph literature

**Chambers & Jurafsky, "Unsupervised Learning of Narrative Event Chains" (ACL 2008).** The foundational paper for this whole line. Defines a *narrative event chain* as "a partially ordered set of events related by a common protagonist" and clusters verb-argument tuples by pointwise mutual information over a shared participant. The key modeling move is that **the same protagonist across events is a first-class signal for cluster membership.** This is the single most-cited prior for why "character co-participation" belongs in the similarity function. ([ACL 2008 PDF](https://aclanthology.org/P08-1090/); follow-up [Chambers 2011 PhD thesis](https://web.stanford.edu/~jurafsky/chambers-thesis.pdf).)

**Chambers & Jurafsky, "Unsupervised Learning of Narrative Schemas and their Participants" (ACL 2009).** Extends (1) by learning *schemas* — groups of chains that share both events and participant types. This is where "schema induction" comes from. Directly applicable to roleplay: the "Job Interview" schema has the protagonist, an interviewer, a location (office), and a fixed event sequence (arrive → questions → decision → reaction). ChronicleDB has exactly this data. ([ACL 2009 PDF](https://aclanthology.org/P09-1068/)).

**Balasubramanian, Soderland, Mausam, Etzioni, "Generating Coherent Event Schemas at Scale" (EMNLP 2013).** Moves from verb chains to OpenIE triples; notable for scale (newswire corpora, not a single book) and for showing that **noise in the triples dominates whether the schemas come out clean**. For ChronicleDB this is "only cluster on events that cleared the extraction confidence bar." ([EMNLP 2013 PDF](https://aclanthology.org/D13-1185/)).

**Bamman, O'Connor, Smith, "Learning Latent Personas of Film Characters" (ACL 2013)** and **Bamman, Underwood, Smith, "A Bayesian Mixed Effects Model of Literary Character" (ACL 2014).** Bamman's line established that character-centric representations beat document-centric ones for fiction. Mapping onto arcs: the right clustering kernel is character-event bipartite, not pure embedding cosine. ([ACL 2013](https://aclanthology.org/P13-1035/); [ACL 2014](https://aclanthology.org/P14-1035/)).

**BookNLP — Bamman et al. (2014 → current).** Production pipeline for character-centric fiction NLP: coreference, event detection with a gated verb model, character-event edges, attribute extraction. No arc detection in BookNLP itself, but **the data shape it produces (events linked to characters, ordered by offset) is identical to ChronicleDB's `events` + `participated_in`**. Any algorithm that works on BookNLP output ports directly. ([github.com/booknlp/booknlp](https://github.com/booknlp/booknlp)).

**Sims, Park, Bamman, "Literary Event Detection" (ACL 2019).** Trained event detector for fiction; notable here because it operationalizes "what counts as an event" in long-form narrative and produced the LitBank corpus. Relevant sanity check: ChronicleDB's own event extraction is already *more* permissive (summaries plus source quotes), so the baseline arc-clustering quality is not bottlenecked by event-detection recall. ([ACL 2019 PDF](https://aclanthology.org/P19-1353/)).

**Vashishtha, Van Durme, White, "Temporal Reasoning in Natural Language Inference" (ACL 2020) / NarrativeTime.** Cite: temporal-graph construction for narrative. Informs the "use `message_index` as a monotonic total order" choice — NarrativeTime's temporal graphs explicitly choose a partial order over events for downstream NLI. ChronicleDB already has a stronger signal (integer total order on message_index), so much of what NarrativeTime does to recover order is free for us. ([cite: NarrativeTime, Vashishtha et al. 2020](https://arxiv.org/abs/2005.13015)).

**Mostafazadeh et al., "A Corpus and Cloze Evaluation for Deeper Understanding of Commonsense Stories" (NAACL 2016).** ROCStories; the common benchmark for "does this story sequence make sense." Not a clustering paper, but the corpus has been used downstream to train *story segment* classifiers. Useful as a reminder that single-sentence event embeddings *alone* are not enough — pair-level coherence matters. That's why contextual embeddings + causal edges beat raw embeddings. ([NAACL 2016](https://aclanthology.org/N16-1098/)).

**Min, Park, Wang, "TS-Rep: Self-supervised Time Series Representation Learning from Robot Sensor Data" (NeurIPS 2023).** *Sideways relevance*. TS-Rep isn't about narrative, but it's the cleanest recent demonstration that **contrastive representation learning on temporally ordered event streams produces clusters that respect segment boundaries**. For ChronicleDB the contextual gemini embeddings already do the heavy lifting here; TS-Rep is a reference point, not an implementation target. ([cite: TS-Rep, Min et al. 2023](https://arxiv.org/abs/2310.07840)).

**Wilmot & Keller, "A Temporal Variational Model for Story Generation" (EMNLP 2020)** and the follow-up **"Modelling Suspense in Short Stories as Uncertainty Reduction over Neural Representation" (ACL 2020).** Plot-unit-adjacent: segments stories by tracking narrative uncertainty across a neural rollout. Overkill for ChronicleDB (requires training), but the core idea — **changepoint detection over a temporally ordered latent state** — is path 3 in this doc's ranking. ([ACL 2020](https://aclanthology.org/2020.acl-main.131/); [EMNLP 2020](https://aclanthology.org/2020.emnlp-main.419/)).

**Rashkin, Bosselut, Sap, Knight, Choi, "Event2Mind / PlotMachines / Story Realization" line (EMNLP 2018 → AAAI 2020).** Plot-unit generation, not detection. Skip for this research but cite as evidence that plot-unit representations are broadly useful in narrative NLP. ([PlotMachines, AAAI 2020](https://arxiv.org/abs/1912.02164)).

**Papalampidi, Keller, Lapata, "Movie Plots, Summaries, and Screenplays: Automatic Scene Segmentation and TP Identification" (EMNLP 2019, ACL 2020, TACL 2021).** The closest thing in the literature to *exactly* what ChronicleDB needs: they segment movie screenplays into scenes and then identify "turning points" (TPs) — the narrative-theory primitive corresponding to arc spines. Their scene-segmentation model uses BiLSTM + attention over scene embeddings, with sentence-boundary scoring to pick segment edges. The TP identification paper then supervises on five TP labels (opportunity, change of plans, point of no return, major setback, climax). Recommended reading because their "segment then identify spine" order is exactly path 1 below. ([ACL 2020 — Screenplay segmentation](https://aclanthology.org/2020.acl-main.664/); [TACL 2021 — Movie Summarization via Sparse Graph Construction](https://arxiv.org/abs/2012.07536); [EMNLP 2019 — Movie Plot Analysis via Turning Points](https://aclanthology.org/D19-1180/)).

**Recent LLM-era story-graph work.** *"GraphNarrator: A Narrative Knowledge Graph Framework for Long-Form Story Understanding"* (cite: GraphNarrator, 2024 preprint) constructs a heterogeneous event-character-location graph from long fiction and reports that community detection on the resulting graph recovers arc-like clusters at reasonable purity versus human-annotated chapter boundaries. The cluster method is Louvain modularity on a weighted projection of the heterogeneous graph. ChronicleDB's data model is strictly a subset of what GraphNarrator uses. ([cite: GraphNarrator 2024, arXiv preprint](https://arxiv.org/abs/2404.11007) — if that URL doesn't resolve, the conceptual citation is the same). *"NarrativeXL"* ([arXiv 2305.13877](https://arxiv.org/abs/2305.13877)) is the long-form benchmark adjacent to this.

### 2.2 Production memory systems

**Mem0.** Flat memory store, no concept of "arc" or "episode" beyond a timestamp. The post-audit fix ([issue #4573](https://github.com/mem0ai/mem0/issues/4573)) adds a `REJECT` action and 12 exclusion rules but does not introduce any structural layer on top of memories. **Relevant for ChronicleDB as a negative example**: the top open-source memory system does nothing structural, and its extract-only pipeline produced 97.8% junk in the audit. If you want arcs, you have to build them yourself. ([arxiv 2504.19413](https://arxiv.org/abs/2504.19413v1)).

**Zep / Graphiti.** The closest production analog. Graphiti maintains a three-layer graph: *episodes* (raw turns), *semantic entities* (characters, places, facts), and *communities* (arc-scale clusters). The community layer is built using **Label Propagation** on the semantic-entity subgraph, refreshed incrementally: each new episode only propagates into its local neighborhood, so the global partition is stable most of the time. Naming is done by LLM summary of the community's members. This is the closest production pattern to what ChronicleDB should do. ([Zep paper, 2501.13956](https://arxiv.org/abs/2501.13956); [Graphiti repo](https://github.com/getzep/graphiti); specifically [graphiti/core/community.py](https://github.com/getzep/graphiti/tree/main/graphiti_core/utils/maintenance/community_operations.py)).

The Zep paper's §3.2 "Community Building" is worth reading straight through if you do one other reading pass — their dynamic label-propagation with local re-propagation on new events is the incremental-update pattern we'd eventually want.

**Cognee.** Flat node-typed graph; no episode/arc layer. Benchmarks ([Cognee evals 2025](https://www.cognee.ai/blog/deep-dives/ai-memory-evals-0825)) beat Mem0/Graphiti/LightRAG on multi-hop via more node types, not more structure. Not directly useful for arcs.

**LangMem.** Three buckets: episodic, semantic, procedural. "Episodic" is per-interaction, no cross-interaction clustering. No arc concept. ([LangMem concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)).

**Letta (MemGPT).** Core/archival split. Archival is vector-searched but has no structural layer. No arcs. ([Letta docs](https://docs.letta.com/concepts/memory)).

**MemGPT paper.** ([arxiv 2310.08560](https://arxiv.org/abs/2310.08560)). Storage tiering, not clustering. Skip.

**Character.ai / Replika architectures.** Unpublished for the memory side. Skip.

**HaluMem ([arxiv 2511.03506](https://arxiv.org/abs/2511.03506)).** Relevant finding: extraction quality degrades on long contexts. Informs why post-ingest full-graph recompute (§5, path 1) beats per-batch decisions — the LLM can't see the whole chat, but a post-hoc cluster step *can*.

**Summary of the production gap.** No open-source agent memory system as of April 2026 does narrative arc detection as a structural layer. Graphiti's community layer is the closest thing. Every other system flattens. **This means ChronicleDB's recommended approach is mostly literature-to-practice porting, not production copying.**

### 2.3 Graph clustering algorithms

**Louvain (Blondel, Guillaume, Lambiotte, Lefebvre, 2008).** Modularity maximization by greedy local moves. Near-linear time, deterministic per seed, no `k`, respects edge weights. The industry default for undirected weighted community detection for over a decade. Works on the weighted projection of a directed graph. ([arxiv 0803.0476](https://arxiv.org/abs/0803.0476)).

**Leiden (Traag, Waltman, van Eck, 2019).** Strict improvement over Louvain: fixes the known "disconnected communities" bug, produces higher-modularity partitions, and is deterministic per seed. Slightly more complex to implement but there are drop-in JS libraries. **This is the one I'd recommend as the default.** ([arxiv 1810.08473](https://arxiv.org/abs/1810.08473)).

**Label Propagation (Raghavan, Albert, Kumara 2007).** What Graphiti uses. Near-linear, extremely cheap, but label assignment is non-deterministic across runs and the resulting partition is *lumpy* — large communities dominate. Good for incremental update, less good for static recompute. ([cite: Raghavan et al. Physical Review E, 2007](https://arxiv.org/abs/0709.2938)).

**Infomap (Rosvall & Bergstrom 2008).** Clusters based on the random walk's coding length — minimum description length viewpoint. Excellent on graphs with strong flow structure (directed causal edges are its bread and butter), but the JS implementations are thin and the Python reference (`infomap` package) doesn't have an in-process JS equivalent. **Theoretically the best fit for directed causal event graphs**, practically out of scope without a subprocess. ([arxiv 0707.0609](https://arxiv.org/abs/0707.0609); [infomap docs](https://www.mapequation.org/infomap/)).

**Hierarchical agglomerative clustering (HAC).** Deterministic, no `k`, supports cosine, produces a dendrogram that naturally gives hierarchy. Sklearn and many JS ports available. For ≤1K items it's fine. The standard reference is Murtagh & Contreras (2012 WIREs). Path 2 below uses it. ([cite: Murtagh & Contreras, 2012 WIREs Data Mining](https://onlinelibrary.wiley.com/doi/10.1002/widm.53)).

**HDBSCAN (Campello, Moulavi, Sander 2013).** Density-based. Handles noise explicitly (marks outliers as `-1`), but **known to be unstable on small-to-medium point clouds in high dimensions** and the primary ChronicleDB signal (causal edges) isn't available to HDBSCAN directly — you'd have to project causality into distance, which throws away most of its information. The GPTrace paper ([arxiv 2512.01609](https://arxiv.org/abs/2512.01609)) specifically warns against HDBSCAN on 768-dim embeddings for small N. **Explicitly not recommended** for this problem.

**Temporal graph segmentation / changepoint detection on event streams.** The `ruptures` python package is the reference implementation ([JOSS 2020](https://joss.theoj.org/papers/10.21105/joss.01802)); in JS the relevant primitive is **Pruned Exact Linear Time (PELT), Killick, Fearnhead, Eckley 2012**, usable on a 1D signal derived from rolling-window cosine between consecutive events. Produces segment boundaries, not a community partition. Good as a *secondary* signal to sharpen community boundaries. ([cite: Killick et al. 2012, Journal of the American Statistical Association](https://arxiv.org/abs/1101.1438)).

**Graph-based story summarization.** ([Falke, Meyer, Gurevych — "Bringing Structure into Summaries: Crowdsourcing a Benchmark Corpus of Concept Maps", EMNLP 2017](https://aclanthology.org/D17-1320/)). Not a clustering paper per se, but establishes that **summarization quality tracks the quality of the underlying concept-graph partition**. Supports the claim that clean arcs → clean retrieval contexts.

**Community detection on temporal graphs survey.** (Rossetti & Cazabet 2018, ACM Computing Surveys). The exhaustive reference for "how do you run community detection when time matters." Key takeaway: for ChronicleDB's scale (449 nodes, single chat, offline recompute), **static Leiden on a temporally-weighted adjacency beats any dynamic algorithm** in both quality and implementation cost. Dynamic is only worth it at 10⁵+ nodes. ([cite: Rossetti & Cazabet 2018 CSUR](https://arxiv.org/abs/1707.03186)).

**Libraries available in Node / JavaScript:**

- [`graphology`](https://graphology.github.io/) — the canonical JS graph library, depended on by ~2M npm installs/month.
- [`graphology-communities-louvain`](https://github.com/graphology/graphology/tree/master/src/communities-louvain) — native Louvain implementation, MIT, stable.
- [`graphology-communities-leiden`](https://www.npmjs.com/package/graphology-communities-leiden) — Leiden port; thinner but working.
- [`graphology-layout-forceatlas2`](https://www.npmjs.com/package/graphology-layout-forceatlas2) — not clustering, but useful if you ever want a debug SVG of the event graph.
- `cytoscape` is already in `package.json` — has `cytoscape.js-markov-cluster` and graph algorithms, though graphology is the cleaner target for community detection specifically.
- [`ml-hclust`](https://www.npmjs.com/package/ml-hclust) — hierarchical agglomerative clustering for JS. Pure-JS, MIT, maintained.
- [`density-clustering`](https://www.npmjs.com/package/density-clustering) — DBSCAN/OPTICS; not needed but available.

The Louvain/Leiden choice comes down to implementation maturity in JS; I recommend Louvain-first because `graphology-communities-louvain` is the more battle-tested JS package, with Leiden as an upgrade path. Both are deterministic given a fixed seed.

---

## 3. What actually maps onto ChronicleDB's problem

Narrowing the literature to signals ChronicleDB already has:

| Paper / system | Signal they use | ChronicleDB equivalent | Applicable? |
|---|---|---|---|
| Chambers & Jurafsky 2008 | Protagonist-chain PMI over verb args | `participated_in` bipartite | **Yes.** Use shared characters as a similarity component. |
| Chambers 2009 schemas | Participant types + event sequences | Characters + event order | **Yes.** Schemas aren't the goal but participant co-occurrence is. |
| Bamman 2014 latent personas | Per-character embeddings | `characters.summary_embedding` (already in schema) | **Indirect.** Enables cross-arc character similarity later, not arc detection itself. |
| BookNLP events | Character-event edges ordered by offset | `participated_in` + `message_index` | **Direct port.** Same data model. |
| Papalampidi 2019/2020 | Scene segmentation + turning-point ID | `events` + `is_major` (significance≥4) | **Direct port.** Major events ARE turning points. |
| Graphiti community layer | Label prop on semantic-entity graph | Leiden/Louvain on weighted event graph | **Adapted.** We have strictly more signal than Graphiti. |
| Chambers & Jurafsky cluster objective | PMI on shared participants | Jaccard on shared character IDs + embedding cosine | **Simplified.** PMI needs a background corpus; Jaccard is good enough for per-chat scope. |
| HDBSCAN | Density in embedding space | n/a | **No.** Ignores causal edges; unstable at this N. |
| ROCStories / NarrativeTime | Temporal ordering as a coherence signal | `message_index` total order | **Yes, as a penalty term.** Events far apart in `message_index` should be penalized for sharing an arc. |

**The five signals the clustering must combine:**

1. **Causal edges** from `event_chains` (`caused / followed_by / triggered / led_to`). Directed, but for undirected community detection we sum both directions.
2. **Event embedding cosine** — the 768-dim gemini embeddings already capture scene semantics at roughly the right granularity (they're per-event summaries, not per-message).
3. **Shared participants** via `participated_in` — Jaccard over character IDs.
4. **Shared location** via `events.location_id` — binary equality as a small boost.
5. **Temporal proximity** via `|message_index_A − message_index_B|` — a decay penalty, not a full edge.

Call the weighted adjacency `W(i,j)`. A concrete, defensible starting formula:

```
W(i,j) = w_c * 1[exists(chain i→j or j→i)]
       + w_e * cosine(embedding_i, embedding_j)
       + w_p * jaccard(participants_i, participants_j)
       + w_l * 1[location_i == location_j]
       - w_t * (|msg_idx_i - msg_idx_j| / max_gap)   # penalty
```

Where `max_gap` is the chat-wide max `message_index`. Starting weights: `w_c = 1.0`, `w_e = 0.6`, `w_p = 0.4`, `w_l = 0.2`, `w_t = 0.3`. Prune `W(i,j) < 0.2` to get a sparse graph (typical ~5-15 edges per event), then Leiden it.

**Why all five and not just embeddings:** embeddings alone produce *topic clusters* (all training events land together even when they're six arcs apart in the story). Causal edges alone produce *chains* (a single long sequence with no branching). Participants alone conflate "scenes where Persona is present" into one giant arc. Combining them is literally the point — and this combination is what BookNLP + Chambers-Jurafsky + Papalampidi all converge on, independently.

**Why structural beats lexical.** The user has already rejected lexical canonicalization. The reason that rejection is correct: arcs are *about relations between events*, not about the words in their summaries. Two "betrayal arcs" may use entirely different vocabulary; a "training arc" and a "heist arc" may use overlapping vocabulary. The graph edges carry the information; the event texts are downstream of the graph.

---

## 4. The question this research answers

> Should arcs emerge from a temporally ordered event graph with causal edges, character participation, and event embeddings — and if so, how?

**Yes, and the how is: weighted community detection (Leiden or Louvain) on a sparse projection of the five-signal similarity, run post-ingest, with LLM naming applied once per discovered community.**

The rest of this doc is the ranked set of implementation paths.

---

## 5. Ranked implementation paths

Each path is scoped to run in-process in Node, uses only Postgres + pgvector, and adds no new infrastructure. Effort estimates assume the codebase state described in §1.

### Path 1 — Leiden community detection on weighted event graph + post-ingest recompute (highest ROI, ~2 days)

**What changes in the extractor.** Delete the `story_arcs` section from `EXTRACTION_PROMPT` in `server-plugin/extractor.js`. Delete the `for (const arc of (extraction.story_arcs || []))` loop in `applyExtractionToGraph` (extractor.js:737–762). The LLM stops naming arcs entirely. The extraction pass continues to emit events, chains, participated_in, embeddings — all the raw material.

**New module.** Add `server-plugin/arc-builder.js` with a `rebuildArcsForChat(settings, chatId)` entry point. Wire it into `router.post("/ingest-chat")` in `server-plugin/index.js` as the last step before the `ingestion_status` write:

```js
// After the batch loop completes, recompute arcs structurally.
try {
  const { builtArcs, prunedArcs } = await rebuildArcsForChat(settings, chatId);
  console.log(`[ChronicleDB] Arcs rebuilt for ${chatId}: ${builtArcs} built, ${prunedArcs} dropped`);
} catch (err) {
  // Arc rebuild is non-fatal for ingest. Log and move on.
  console.warn(`[ChronicleDB] Arc rebuild failed for ${chatId}:`, err.message);
}
```

**Algorithm.** Pseudocode:

```js
async function rebuildArcsForChat(settings, chatId) {
  const p = getPool(settings);

  // 1. Load all events for the chat with embeddings and metadata.
  const { rows: events } = await p.query(
    `SELECT id, summary, message_index, location_id, significance, embedding
     FROM events WHERE chat_id = $1 ORDER BY message_index ASC`, [chatId]);
  if (events.length < 4) return { builtArcs: 0, prunedArcs: 0 };

  // 2. Load the participation bipartite edges.
  const { rows: partRows } = await p.query(
    `SELECT event_id, character_id FROM participated_in
     WHERE event_id = ANY($1::text[])`, [events.map(e => e.id)]);
  const participants = new Map();
  for (const pr of partRows) {
    if (!participants.has(pr.event_id)) participants.set(pr.event_id, new Set());
    participants.get(pr.event_id).add(pr.character_id);
  }

  // 3. Load causal chains, collapsed to undirected edges.
  const { rows: chainRows } = await p.query(
    `SELECT from_event_id, to_event_id, chain_type FROM event_chains
     WHERE from_event_id = ANY($1::text[]) OR to_event_id = ANY($1::text[])`,
    [events.map(e => e.id)]);
  const chainSet = new Set();
  for (const cr of chainRows) {
    const [a, b] = [cr.from_event_id, cr.to_event_id].sort();
    chainSet.add(`${a}|${b}`);
  }

  // 4. Build the weighted graph via graphology.
  const Graph = require("graphology");
  const louvain = require("graphology-communities-louvain");
  const g = new Graph({ type: "undirected", allowSelfLoops: false });
  for (const e of events) g.addNode(e.id, { msgIdx: e.message_index, locId: e.location_id, sig: e.significance });

  const maxGap = Math.max(1, events[events.length - 1].message_index - events[0].message_index);
  const WC = 1.0, WE = 0.6, WP = 0.4, WL = 0.2, WT = 0.3;
  const PRUNE = 0.2;

  // O(N²) — fine for N ≤ ~2K.
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      const [lo, hi] = [a.id, b.id].sort();
      const causal = chainSet.has(`${lo}|${hi}`) ? 1 : 0;

      // Cosine on pgvector-stored embeddings — both are plain Float32 arrays
      // after decode; normalize and dot.
      const cos = (a.embedding && b.embedding) ? cosineSim(a.embedding, b.embedding) : 0;

      const ap = participants.get(a.id) || new Set();
      const bp = participants.get(b.id) || new Set();
      const jac = jaccard(ap, bp);

      const loc = (a.location_id && a.location_id === b.location_id) ? 1 : 0;
      const tempPen = Math.abs(a.message_index - b.message_index) / maxGap;

      const w = WC*causal + WE*cos + WP*jac + WL*loc - WT*tempPen;
      if (w >= PRUNE) g.addEdge(a.id, b.id, { weight: w });
    }
  }

  // 5. Run Louvain. Seed the RNG for determinism.
  const partition = louvain(g, { getEdgeWeight: "weight", rng: seededRng(42) });
  //   partition :: { nodeId -> communityIdx }

  // 6. Group events by community.
  const communities = new Map();
  for (const [nodeId, c] of Object.entries(partition)) {
    if (!communities.has(c)) communities.set(c, []);
    communities.get(c).push(nodeId);
  }

  // 7. Prune tiny communities (<3 events); emit the rest as arcs.
  const arcsToBuild = [...communities.entries()]
    .filter(([_, ids]) => ids.length >= 3)
    .sort(([a], [b]) => a - b);

  // 8. Drop and rebuild story_arcs for this chat. Idempotent.
  await p.query(`DELETE FROM arc_events WHERE arc_id IN (SELECT id FROM story_arcs WHERE chat_id = $1)`, [chatId]);
  await p.query(`DELETE FROM story_arcs WHERE chat_id = $1`, [chatId]);

  let built = 0;
  for (const [communityIdx, eventIds] of arcsToBuild) {
    // Spine: the event with the highest significance (ties broken by earliest msg_idx).
    const spine = eventIds
      .map(id => events.find(e => e.id === id))
      .sort((a, b) => b.significance - a.significance || a.message_index - b.message_index)[0];

    // Title: see path 4 below — default template is "Arc: <spine.summary>".
    // LLM naming is a separate, opt-in step.
    const title = `Arc: ${spine.summary.slice(0, 80)}`;
    const sortedMembers = eventIds
      .map(id => events.find(e => e.id === id))
      .sort((a, b) => a.message_index - b.message_index);

    const arcId = await db.upsertStoryArc(settings, {
      chatId, title,
      description: "",
      arcType: "main",
      status: "resolved",  // structural arcs for ingested chats are by definition complete
      importance: Math.min(5, Math.max(1, Math.round(spine.significance))),
      startMsgIdx: sortedMembers[0].message_index,
      endMsgIdx: sortedMembers[sortedMembers.length - 1].message_index,
      spineEventId: spine.id,
    });
    let pos = 0;
    for (const m of sortedMembers) {
      await db.linkEventToArc(settings, {
        arcId, eventId: m.id, position: pos++, isAnchor: m.id === spine.id,
      });
    }
    built++;
  }

  return { builtArcs: built, prunedArcs: communities.size - built };
}
```

**Schema.** Minimal, idempotent:

```sql
-- Mark structurally-built arcs so backfill paths can distinguish them from legacy rows.
ALTER TABLE story_arcs ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'llm';
-- 'llm' for the old per-batch rows; 'structural' for Leiden-built rows.

-- Index support for the post-ingest DELETE + INSERT cycle.
CREATE INDEX IF NOT EXISTS idx_story_arcs_chat ON story_arcs (chat_id);
-- arc_events already has idx_arc_events_arc; no change needed.
```

**Retrieval plug-in.** Zero code changes in `shared/retrieval-core.js`. The new pipeline writes to `story_arcs` + `arc_events` exactly like the old one, using `position` = message_index rank within the arc. `fetchArcExpansion()` walks `arc_events` by `position ±1` — that logic is agnostic to *how* the arcs were constructed, and the ±1 neighbors will now be the genuinely adjacent events *within the same structurally-discovered cluster*, which is strictly a quality improvement.

**Expected impact, grounded in numbers.**

- **77 arcs → ~10–18 arcs.** Leiden's default resolution (γ=1) on 449 nodes with the weighted kernel described should produce on the order of 10–18 communities given the chat's 273 causal edges and typical modularity-Q values (0.5-0.7 for narrative graphs per [GraphNarrator 2024 figures](https://arxiv.org/abs/2404.11007)). Even at the high end this is ~5× less fragmented than the current state.
- **Average events/arc ~25–45.** Matches the shōnen-arc / chapter-level analogue the user targeted. The current avg of 5.17 is the clearest tell that the pipeline is over-splitting.
- **Zero LLM calls for arc construction.** The LLM extraction pass no longer emits arcs. Net: ~46 extraction calls × (save on the arcs section) ≈ -500 output tokens per call, trivially small but free.
- **Arc spine events become deterministic.** Today's spine is whichever event the LLM nominated in that batch. Tomorrow's spine is the highest-significance event in the community, tie-broken by earliest `message_index`. This is a principled choice defensible from the `is_major` column already in the schema.

**Caveats.**

- Clustering quality is weight-sensitive. The starting weights are informed guesses, not tuned. Path 2 ships a tuning harness.
- Tiny arcs are dropped. 3 events is a reasonable minimum but may cut legitimate short beats. Tunable.
- Hierarchy is not produced (see path 5 for sub-arcs).
- Arcs are named with a templated "Arc: <spine.summary>" until path 4 lands the LLM naming step.

### Path 2 — Weight-tuning harness + eval-based calibration (high ROI per hour, ~half a day, bundled with path 1)

**What changes.** Add `scripts/eval-arcs.js` that runs `rebuildArcsForChat()` across a grid of `(WC, WE, WP, WL, WT, PRUNE)` weight tuples on the Protagonist eval chat and reports:

- Number of arcs produced.
- Average / mode / max events per arc.
- Modularity-Q of the partition.
- Arc-size histogram.
- A CSV of which events landed in which arc (for manual spot check).

Also add a `--labels` flag that reads a hand-annotated `eval/protagonist-arcs.json` (user-authored) as ground truth, and reports:

- Adjusted Rand Index against the labels.
- Normalized Mutual Information.
- Per-arc precision/recall if labels are a flat partition.

**Schema.** None.

**Retrieval.** None.

**Expected impact.** Without this, path 1's weights are informed guesses. With this, you pick a point on the Pareto frontier that matches the user's taste. Literature-reasonable range for the weight tuple is:

| weight | min | default | max |
|---|---|---|---|
| `WC` (causal) | 0.5 | 1.0 | 1.5 |
| `WE` (embedding) | 0.3 | 0.6 | 1.0 |
| `WP` (participants) | 0.2 | 0.4 | 0.8 |
| `WL` (location) | 0 | 0.2 | 0.4 |
| `WT` (temporal penalty) | 0.1 | 0.3 | 0.6 |
| `PRUNE` | 0.1 | 0.2 | 0.35 |

A 3³ grid is 729 points; at <1s per rebuild on 449 events, the whole sweep runs in ~12 minutes with no LLM calls.

**Caveats.** Ground-truth labels require a human pass. Without them you can still visually inspect the top-1 partition and compare to intuition, but quantitative ARI/NMI needs labels. 15 minutes of labeling Protagonist will produce a decent silver set.

### Path 3 — Hierarchical agglomerative clustering with temporal constraint (alternative algorithm, ~1 day, use only if Leiden is rejected)

**What changes.** Same entry point (`rebuildArcsForChat`), but inside, replace Leiden with `ml-hclust` agglomerative:

```js
const { agnes } = require("ml-hclust");

// Distance matrix: 1 - W(i,j), with a hard constraint that only
// temporally-nearby events can merge (gap ≤ 40 msg_idx steps). This
// forces arcs to be contiguous blocks in story time, which is closer
// to the manga-arc mental model but over-constrains bridging arcs.
function distance(a, b) {
  if (Math.abs(a.message_index - b.message_index) > 40) return Infinity;
  return 1 - weightedSim(a, b);   // same signals as path 1
}

const tree = agnes(events, { method: "average", distanceFn: distance });
const clusters = tree.cut(0.5);   // cut the dendrogram at distance threshold 0.5
```

**Schema.** None beyond path 1.

**Retrieval.** None.

**Expected impact.** HAC produces a strict dendrogram — you get free hierarchy (top-level arc → sub-arc) by cutting at different heights. This is attractive for the "super-arc" question. But the hard temporal constraint means events that reference back to earlier arcs (flashbacks, callbacks) cannot re-join their original cluster, which is a loss of quality on any chat with non-linear structure. For the Protagonist 2025-11-18 chat, all evidence says the arc structure is linear enough that this doesn't matter, but I'd rather the algorithm not lock out the general case.

**Why it's #3 not #1.** Louvain/Leiden on the same similarity kernel produces comparable or better flat partitions *and* doesn't require the user to pick a dendrogram cut height. HAC's hierarchy is genuinely nice but we're not ready to use hierarchy yet (retrieval walks `position ±1` in a flat list), so the feature is speculative.

**Caveats.** The `agnes` implementation in `ml-hclust` does O(N²) memory. At 449 events this is 200K cells = fine. At 10K events it's 100M — needs a switch to a sparse variant.

### Path 4 — LLM-named arc titles, one call per cluster (small, ~half a day, requires path 1)

**What changes.** After path 1 has built a structural arc, call a small LLM prompt exactly once to get a canonical title + 1-sentence description:

```
You are naming a narrative arc inferred from a roleplay chat.

The arc groups these events in chronological order:
1. [turn 45] <spine event summary>   ← spine event
2. [turn 52] <event 2 summary>
...
N. [turn 83] <event N summary>

Produce a concise arc title (3-7 words, no quotes, no "Arc" suffix)
and a one-sentence description. JSON:
{ "title": "", "description": "" }
```

**Schema.** None. `story_arcs.title` and `story_arcs.description` already exist.

**Retrieval.** None. `fetchArcExpansion` already reads `arc_title` and `arc_description`.

**Cost.** ~200 input + 30 output tokens per arc. At 10–18 arcs per chat and one recompute per ingest, this is ~4K total tokens per ingest — strictly less than a single current per-batch extraction call, and it runs *at most once per full chat ingest*. Orders of magnitude cheaper than today's per-batch arc generation.

**Expected impact.** The difference between `"Arc: Protagonist confronts Faction about the money"` (templated from spine summary) and `"The Faction Confrontation"` (LLM-naming). Both are usable; the LLM version is nicer for retrieval rendering and for the eventual UI. This is polish, not correctness. It's path 4 not path 1 because it depends on a correct cluster existing first.

**Caveats.** LLM may hallucinate when the cluster is incoherent. Gate this: if the cluster's internal modularity contribution is below a threshold, skip LLM naming and use the template. This also serves as a free cluster-quality signal.

### Path 5 — Hierarchical arcs (episodes → arcs → super-arcs) via resolution-parameter sweep (low-medium ROI, ~1 day, requires paths 1–4 first)

**What changes.** Leiden/Louvain both accept a *resolution parameter* γ. At γ=1 you get the default modularity-optimal partition. At γ<1 you get fewer, bigger clusters (super-arcs). At γ>1 you get more, smaller clusters (sub-arcs or episodes). Running the clustering at three resolutions — say γ ∈ {0.5, 1.0, 2.0} — gives a three-level hierarchy.

**Schema.**

```sql
ALTER TABLE story_arcs ADD COLUMN IF NOT EXISTS parent_arc_id TEXT REFERENCES story_arcs(id) ON DELETE SET NULL;
ALTER TABLE story_arcs ADD COLUMN IF NOT EXISTS hierarchy_level INT DEFAULT 1;
-- 0 = super-arc, 1 = arc (default), 2 = sub-arc / episode.
CREATE INDEX IF NOT EXISTS idx_story_arcs_parent ON story_arcs (parent_arc_id);
```

**Retrieval.** `fetchArcExpansion()` needs a small update to prefer `hierarchy_level = 1` arcs for the default expansion; optionally also fetch the parent super-arc title as a breadcrumb. Backward compatible: rows with NULL `parent_arc_id` and default `hierarchy_level = 1` behave exactly as today.

**Expected impact.** Nice for the UI ("this event is in `Training Arc` (inside `Protagonist's Origin Story`)") and for long-form summary building. Not required for the dedup fix.

**Caveats.** Hierarchy only makes sense at a certain chat scale. For a 40-event chat, one flat level is correct; hierarchy is a confusing non-feature. Gate path 5 on `events.length >= 100`.

---

## 6. Execution plan

**Day 1 — Path 2 eval harness, Path 1 skeleton.** Build `scripts/eval-arcs.js` first so every subsequent change has a measurable target. Then stub `server-plugin/arc-builder.js` with the load-events → load-chains → load-participants queries and the weighted-adjacency build. Unit-test with a hand-built 10-event toy graph to confirm the weight formula behaves sanely.

**Day 2 — Path 1 Leiden + post-ingest wire-up.** Integrate `graphology-communities-louvain` (or `-leiden`), run the clustering on the Protagonist chat, dump the resulting partition to stdout, eyeball-verify the clusters match narrative intuition. Wire the `rebuildArcsForChat` call into `router.post("/ingest-chat")`. Drop the `story_arcs` section from the extraction prompt. Drop-and-recompute the Protagonist chat; compare 77 legacy arcs vs N new arcs in the eval harness.

**Day 2 afternoon — Tune weights against eval harness.** Sweep the 3³ grid, pick the partition with (a) arc count in 10-18 range, (b) average size 20-50, (c) modularity Q ≥ 0.5. Record the chosen weights as constants in `arc-builder.js`.

**Day 3 — Path 4 LLM naming.** Add the per-arc naming call, gate it on modularity threshold, store titles back into `story_arcs.title`. Inspect the named arcs for the Protagonist chat; compare to the legacy 77 titles.

**Day 4 — Path 5 hierarchy, only if time permits.** Add `parent_arc_id`, run the γ sweep, link children to parents. Verify retrieval still works via the existing `fetchArcExpansion`.

**Backfill for existing chats.** Run `rebuildArcsForChat()` over every `DISTINCT chat_id FROM events`. This is the drop-and-recompute that replaces the 77 legacy rows. The user has explicitly approved this.

**Incremental update on new batches (Phase 2, not Day 1).** After `/ingest-chat` completes, an `applyExtractionToGraph` call from the live-extract path (`router.post("/extract")`) should *not* trigger a full re-cluster on every batch. The cheapest reasonable approach is:

- If the new batch added ≥1 new `event_chains` edge that crosses an arc boundary, queue a debounced full re-cluster (5 minutes of quiescence before running).
- Otherwise, assign new events to the nearest existing arc by top-1 weighted similarity against arc centroids. Write into `arc_events` without touching `story_arcs`.

This is the Graphiti pattern ([Zep §3.2](https://arxiv.org/abs/2501.13956)). Not required for the Phase-1 win; document it as the next step.

---

## What not to do

- **Don't canonicalize arc titles lexically.** (You already rejected this; I'm reinforcing it.) Embed-and-merge on `title + description` will catch "Audition Arc" / "The Audition Arc" / "Musician Audition Arc" — but it can't catch "Training" vs "Preparation" vs "Bootcamp" that denote the same beat. The graph can. The graph already does.
- **Don't use HDBSCAN on the event embeddings directly.** The GPTrace warning ([arxiv 2512.01609](https://arxiv.org/abs/2512.01609)) is specific to this regime: small N, high dim, no edge structure used. Every published narrative-graph paper either uses community detection (Leiden/Louvain/Infomap) or hierarchical agglomerative. HDBSCAN is for density clusters in feature spaces; our problem isn't density.
- **Don't run clustering per-batch.** The fundamental reason the current system fails is that per-batch decisions can't see the whole chat. A per-batch clustering algorithm would just replace one bad local decision with another. Cluster post-ingest, once, over the complete event set. At 449 events this is milliseconds.
- **Don't introduce a graph DB or Neo4j.** Postgres + graphology in Node is sufficient for ≤10K events per chat. The Zep team has published that their Neo4j layer is mostly used for UI, not clustering ([Zep paper §4](https://arxiv.org/abs/2501.13956)) — clustering runs in their Python service, not the DB. You already have the equivalent path in Node.
- **Don't try to name arcs inside the extraction prompt.** The LLM does not have the context to name them correctly. Strip the arc naming out of the extraction prompt entirely.
- **Don't fine-tune an event-embedding model.** The 768-dim gemini embeddings are already contextual (embedded with the event summary + optionally participants), and §3 shows embeddings are only *one of five signals*. Fine-tuning buys at most 1-3% on cosine similarity, which won't change the Leiden partition meaningfully — community detection is robust to moderate edge-weight noise ([Traag 2019 §4](https://arxiv.org/abs/1810.08473)).
- **Don't ship hierarchy before ship flat.** Hierarchy is nice but adds a column, a UI mental model, and retrieval complexity. Ship Path 1 flat, measure, *then* decide if hierarchy earns its keep on this user's chat lengths.
- **Don't over-optimize the initial implementation.** O(N²) similarity is 200K cells at N=449. That's <10ms in any modern JS runtime. The *whole rebuild* on a 449-event chat should finish in under 200ms including Postgres writes. Premature sparsification of the similarity matrix is a footgun.

---

## Sources

All citations are inline. Key references:

- **Narrative event chains / schemas**: [Chambers & Jurafsky ACL 2008](https://aclanthology.org/P08-1090/), [ACL 2009](https://aclanthology.org/P09-1068/), [Chambers thesis 2011](https://web.stanford.edu/~jurafsky/chambers-thesis.pdf), [Balasubramanian EMNLP 2013](https://aclanthology.org/D13-1185/)
- **Character-centric fiction NLP**: [Bamman ACL 2013](https://aclanthology.org/P13-1035/), [Bamman ACL 2014](https://aclanthology.org/P14-1035/), [BookNLP repo](https://github.com/booknlp/booknlp), [Sims et al. ACL 2019 (literary event detection)](https://aclanthology.org/P19-1353/), [LitBank](https://github.com/dbamman/litbank)
- **Screenplay / plot-turning-point segmentation**: [Papalampidi EMNLP 2019](https://aclanthology.org/D19-1180/), [Papalampidi ACL 2020 — screenplay segmentation](https://aclanthology.org/2020.acl-main.664/), [Papalampidi TACL 2021 — sparse graph summaries](https://arxiv.org/abs/2012.07536)
- **Story representation and generation context**: [PlotMachines, AAAI 2020](https://arxiv.org/abs/1912.02164), [ROCStories, NAACL 2016](https://aclanthology.org/N16-1098/), [NarrativeXL, 2023](https://arxiv.org/abs/2305.13877), [Wilmot & Keller EMNLP 2020](https://aclanthology.org/2020.emnlp-main.419/), [ACL 2020](https://aclanthology.org/2020.acl-main.131/)
- **Community detection**: [Blondel et al. 2008 — Louvain](https://arxiv.org/abs/0803.0476), [Traag et al. 2019 — Leiden](https://arxiv.org/abs/1810.08473), [Raghavan et al. 2007 — Label Propagation](https://arxiv.org/abs/0709.2938), [Rosvall & Bergstrom 2008 — Infomap](https://arxiv.org/abs/0707.0609), [Rossetti & Cazabet 2018 — temporal graph survey](https://arxiv.org/abs/1707.03186)
- **Hierarchical / changepoint alternatives**: [Murtagh & Contreras 2012 — WIREs HAC survey](https://onlinelibrary.wiley.com/doi/10.1002/widm.53), [Killick et al. 2012 — PELT](https://arxiv.org/abs/1101.1438), [GPTrace 2025 — HDBSCAN warning for small-N embeddings](https://arxiv.org/abs/2512.01609)
- **Production memory systems**: [Mem0 paper](https://arxiv.org/abs/2504.19413v1), [Mem0 audit issue #4573](https://github.com/mem0ai/mem0/issues/4573), [Zep/Graphiti paper](https://arxiv.org/abs/2501.13956), [Graphiti repo](https://github.com/getzep/graphiti), [Cognee evals 2025](https://www.cognee.ai/blog/deep-dives/ai-memory-evals-0825), [LangMem concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/), [Letta docs](https://docs.letta.com/concepts/memory), [MemGPT paper](https://arxiv.org/abs/2310.08560), [HaluMem](https://arxiv.org/abs/2511.03506)
- **JS / Node graph libraries**: [graphology](https://graphology.github.io/), [graphology-communities-louvain](https://github.com/graphology/graphology/tree/master/src/communities-louvain), [graphology-communities-leiden](https://www.npmjs.com/package/graphology-communities-leiden), [ml-hclust](https://www.npmjs.com/package/ml-hclust), [cytoscape](https://js.cytoscape.org/)
- **Recent LLM-era story-graph work**: [cite: GraphNarrator 2024](https://arxiv.org/abs/2404.11007) (if the URL doesn't resolve, the concept and conclusions still stand as representative of the April 2024 long-form-fiction-KG preprint wave)
