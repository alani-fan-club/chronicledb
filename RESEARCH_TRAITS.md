# Character Trait Extraction & Representation: State of the Art

A research review for ChronicleDB. Focus: extracting persistent character attributes from long-form roleplay narratives, with embeddings as the primary lever.

## TL;DR

1. **Naive single-pass LLM extraction is the wrong shape of solution.** Every production memory system that actually works (Mem0, Zep/Graphiti, Cognee, EDC, Letta) does extraction in **at least two passes**: a generative extract pass, then a *resolve / canonicalize / merge* pass that uses embeddings + LLM verification to dedupe against existing rows. A public audit of Mem0 found **97.8% junk** in production after 32 days because it skipped this. That is exactly the failure mode you are seeing in ChronicleDB. ([mem0 audit issue #4573](https://github.com/mem0ai/mem0/issues/4573))
2. **Short-string embeddings are a known bad idea.** "stoic" alone is brittle — variance on 1–2 word inputs is high in every general-purpose encoder. The state-of-the-art fix is **contextual embeddings** ([Anthropic, 2024](https://www.anthropic.com/news/contextual-retrieval)): you embed `"Protagonist is stoic: he never shows fear in combat"`, not `"stoic"`. Anthropic measured a 35% drop in retrieval failure from this single change. For ChronicleDB this also doubles as a **dispositional vs transient discriminator** — the surrounding sentence usually disambiguates.
3. **The trait categories themselves should be canonicalized against a fixed ontology.** The lexical-hypothesis tradition gives you Goldberg's 100 / 50 / Mini-Marker adjective lists ([Goldberg 1990, 1992](https://projects.ori.org/lrg/PDFs_papers/Goldberg.Big-Five-FactorsStructure.JPSP.1990.pdf)) and Big Five factor anchors. That gives you ~50–100 *known persistent personality adjectives* you can match against — and a way to soft-cluster the rest. Combined with the NRC Emotion Lexicon as a *negative* set, you get a free dispositional/transient gate without an LLM call.
4. **The single highest-ROI change** is to replace the current "extract then INSERT" pipeline with **Extract → Define → Canonicalize (EDC)** ([Zhang & Soh, EMNLP 2024](https://arxiv.org/html/2404.03868v1)): extract candidates, generate a one-sentence semantic definition for each, embed the definition (not the trait word), look up nearest neighbors in pgvector, and let the LLM verify-and-merge against existing rows before inserting.
5. **Stop tuning prompts in isolation. Add a verifier loop.** Mem0's audit-fix recommendations and Cognee's benchmarks both converge on the same conclusion: a tiny "REJECT/UPDATE/KEEP" gate after extraction is worth more than any prompt rewrite ([Cognee evaluation, 2025](https://www.cognee.ai/blog/deep-dives/ai-memory-evals-0825)).

The five concrete implementation paths ranked by ROI are in section 5.

---

## 1. Extraction strategy

### How production memory systems actually do it

None of the serious systems use a single "extract traits" prompt the way ChronicleDB does. They all decompose the problem.

**Mem0** ([arxiv 2504.19413](https://arxiv.org/html/2504.19413v1)) uses a strict two-phase pipeline. Extraction emits "atomic facts" from the latest exchange + rolling summary + last N messages. Update compares each candidate against existing memories with vector similarity, then asks an LLM for one of `ADD / UPDATE / DELETE / NONE`. The post-audit fix adds a fifth action `REJECT`, twelve explicit exclusion rules, and negative few-shot examples ([mem0 issue #4573](https://github.com/mem0ai/mem0/issues/4573)).

Crucially: **the extractor is generative, the writer is discriminative.** ChronicleDB right now only has the generative half.

**Zep / Graphiti** ([Zep paper PDF, 2025](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf)) builds a three-tier knowledge graph (episode → semantic entity → community subgraph) with a bi-temporal model: every edge has `valid_from / valid_to`, so new extractions supersede rather than overwrite. Relevant for ChronicleDB because traits actually evolve in long roleplay (a character hardens, opens up, etc.) and the current schema cannot represent that.

**EDC (Extract / Define / Canonicalize)** ([Zhang & Soh, 2024](https://arxiv.org/html/2404.03868v1), [code](https://github.com/clear-nus/edc)) is the cleanest published recipe and maps most directly onto ChronicleDB: (1) extract open-info triples freely; (2) ask the LLM for a one-sentence semantic definition of each trait; (3) embed the definition, kNN against existing rows, and gate every merge through an LLM verification step. EDC explicitly avoids the "over-generalization of pure clustering."

Concretely, "Has a history of violence" and "Former enforcer" would each get a definition like *"A past involving organized violence or coercion"*, those definitions would land near each other in embedding space, and the LLM would confirm the merge.

**Cognee** ([eval, 2025](https://www.cognee.ai/blog/deep-dives/ai-memory-evals-0825)) outperformed Mem0, Graphiti, and LightRAG on multi-hop reasoning by layering chunks + entity types as separate node classes with explicit edges — multiple node *types* beat one flat trait table.

### Trait taxonomies / ontologies

The lexical-hypothesis line of personality psychology gives you exactly what you need: a small finite set of canonical persistent adjectives.

- **Goldberg's 100 unipolar Big-Five markers** ([Goldberg, 1992 Psych. Assess.](https://projects.ori.org/lrg/PDFs_papers/Goldberg.Big-Five-Markers-Psych.Assess.1992.pdf)) — 100 single English adjectives, 20 per Big Five factor. The whole list is dispositional by construction: "talkative," "withdrawn," "sympathetic," "cold," "organized," "careless," "moody," "calm," "imaginative," "unintellectual."
- **Goldberg 50 / IPIP-50 markers** ([Goldberg 50](https://projects.ori.org/lrg/PDFs_papers/Goldberg.Big-Five-FactorsStructure.JPSP.1990.pdf)) — same idea, 10 per factor. Easier to use as anchor seeds.
- **Saucier's Mini-Markers** ([Saucier, 1994](https://pubmed.ncbi.nlm.nih.gov/7844738/)) — a brief 40-adjective version, "an optimally robust subset" tested across 12 datasets.
- **Hierarchical Analysis of 1,710 personality-descriptive adjectives** ([Goldberg](https://projects.ori.org/lrg/pdfs_papers/english%20lexical%201,710.pdf)) — the maximalist version. Useful as a *whitelist* lookup ("is this candidate trait actually in the lexicon of personality-descriptive adjectives?").

For ChronicleDB the question isn't "do I want OCEAN as a top-level schema" — it's *"do I have a vetted list of words that are genuinely persistent attributes?"* Goldberg's lists are exactly that. You can store them as a `personality_adjectives` table and use them as both an anchor set for clustering and a positive whitelist during the dispositional/transient gate.

A 2025 *Scientific Data* paper, "A standardized personality lexicon for enhancing personalized human-machine interaction" ([Nature SciData](https://www.nature.com/articles/s41597-026-06783-6)) extends this with a vetted multilingual lexicon, but Goldberg is enough for English roleplay text.

### Granularity: per-message vs per-scene vs per-arc

*HaluMem* ([arxiv 2511.03506](https://arxiv.org/html/2511.03506)) and LangMem ([guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) both report that most memory systems perform worse on long contexts; Mem0 specifically extracts *fewer* memories on long inputs because the LLM loses the thread. The published consensus is **scene-level batches of ~1–4k tokens** as the sweet spot. Per-message gives shallow, redundant extractions; per-arc loses recall. ChronicleDB's per-batch ingest is roughly right — but you should buffer until you have a coherent scene before invoking the extractor.

### Dispositional vs transient separation

The Big-Five literature treats this implicitly: emotions and traits can be separated because lexicon overlap is small and asymmetric. The NRC Emotion Lexicon ([NRC](https://saifmohammad.com/WebPages/NRC-Emotion-Lexicon.htm)) labels ~14k English words by emotion association; its intersection with Goldberg's personality markers is small. The 2024 Springer review on emotion vs personality NLP ([Springer](https://link.springer.com/article/10.1007/s10462-023-10603-3)) frames the distinction as a *duration / stability* axis. A recent ScienceDirect paper ([SciDirect](https://www.sciencedirect.com/science/article/pii/S2949719124000530)) shows that contextual embeddings separate the two geometrically.

**Practical recipe**: (a) Goldberg whitelist for auto-accept, (b) NRC negative gate for auto-reject, (c) LLM gate for the ambiguous middle.

### Relevant papers on character attribute extraction from stories

- **PAED** ([ACL 2023](https://aclanthology.org/2023.acl-long.544/), [code](https://github.com/Cyn7hia/PAED)) — the most directly applicable persona corpus, with 105 relation types and 1,896 re-annotated triplets, and a contrastive-with-hard-negative-sampling approach.
- **NLI for persona extraction** ([arxiv 2401.06742](https://arxiv.org/html/2401.06742v1)) — uses off-the-shelf NLI as a quality filter, the same pattern as the REJECT gate.
- **LitBank / BookNLP** ([LitBank](https://github.com/dbamman/litbank), [BookNLP](https://github.com/booknlp/booknlp)) — Bamman's fiction NLP pipeline, targets "modifiers and possessions" linked to coreference chains. The modifier-attribution logic ports directly.
- **Austen Character Similarity Benchmark** ([arxiv 2408.16131](https://arxiv.org/html/2408.16131v1)) — useful as an evaluation harness for "is this the same character."
- **Fictional Character Embeddings for Quotation Attribution** ([arxiv 2406.11368](https://arxiv.org/html/2406.11368v1)) — constructs global per-character vectors by aggregating BookNLP local features. Same recipe as path 4 below.
- **BIG5-CHAT** ([ACL 2025](https://aclanthology.org/2025.acl-long.999.pdf)) — the inverse direction (training LLMs to express OCEAN profiles), but documents which signals robustly express which traits.

---

## 2. Embedding strategy

### Gemini embedding for short trait text

You're on `gemini-embedding-2-preview` at 768 dim with `SEMANTIC_SIMILARITY`. From the official sources ([Gemini API docs](https://ai.google.dev/gemini-api/docs/embeddings), [paper](https://arxiv.org/html/2503.07891v1), [Embedding 2 post](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-embedding-2/)):

- 768 dim is the recommended default — only 0.26% quality loss vs 3072, at 25% storage. Going higher will not fix the trait-dedup problem.
- **For dimensions other than 3072, embeddings must be normalized** before similarity. Confirm pgvector is doing this; if not, that's a silent bug.
- Gemini Embedding currently sits at the top of English MTEB (~68.32 avg, 67.71 retrieval per [Awesome Agents leaderboard](https://awesomeagents.ai/leaderboards/embedding-model-leaderboard-mteb-march-2026/)).
- It is task-conditional — confirm `SEMANTIC_SIMILARITY` and not `RETRIEVAL_DOCUMENT/QUERY` for trait dedup.

For 1–5 word inputs *every* general-purpose encoder (Gemini, Voyage-3, OpenAI v3, Cohere) has high variance because the training distribution is sentence-or-paragraph. The published fix is not to switch encoders, it's to **stop embedding 1–5 word inputs** — see Hybrid embeddings in §3.

### Specialized contrastive / persona embeddings

There are no production-grade off-the-shelf "trait embedding" models. The closest:

- **PAED's contrastive persona model** ([ACL 2023](https://aclanthology.org/2023.acl-long.544/)) — research artifact, contrastively trained on 105 persona relations with Meta-VAE hard-negative sampling. Could be fine-tuned on ChronicleDB logs.
- **Anthropic persona vectors** ([post](https://www.anthropic.com/research/persona-vectors), [arxiv 2507.21509](https://arxiv.org/abs/2507.21509)) — *internal* activation directions, not text embeddings, so not directly usable in pgvector. But the recipe (paired "you are X" / "you are not X" prompts + difference-of-means) is the cleanest demonstration that *contrastive* signal is what produces trait-discriminative representations.
- **LLM embeddings + linear probes for OCEAN** ([JMIR 2025](https://www.jmir.org/2025/1/e75347/PDF), [PMC12262148](https://pmc.ncbi.nlm.nih.gov/articles/PMC12262148/)) — embed whole user texts, run a linear probe per Big-Five trait. Confirms the right input shape is sentence-or-longer, not single adjective.

### Short-text embedding quality and dimensionality

Recent benchmarking ([Best Embedding Models 2025](https://dev.to/datastax/the-best-embedding-models-for-information-retrieval-in-2025-3dp5), [voyage-3-large blog](https://blog.voyageai.com/2025/01/07/voyage-3-large/)) puts Voyage-3-large slightly ahead of OpenAI v3-large (~9.7%) on document retrieval, with Gemini Embedding essentially tied. Switching encoders buys ~1–3%. **It will not fix the morphological/paraphrase problems.** The right intervention is upstream: change *what* you embed.

768 vs 1536 vs 3072: 768 is within 0.26% of 3072 per [Gemini docs](https://ai.google.dev/gemini-api/docs/embeddings). **Stay at 768.**

### Cosine similarity threshold for "same trait, different wording"

Published ranges:

- **NeMo SemDeDup** ([docs](https://docs.nvidia.com/nemo-framework/user-guide/latest/datacuration/semdedup.html)) — 0.85–0.95 for near-duplicate data.
- **EDC** ([2024](https://arxiv.org/html/2404.03868v1)) and **Cognee/KGGEN/LKD-KGC** ([eval](https://www.cognee.ai/blog/deep-dives/ai-memory-evals-0825)) — no fixed threshold; merges are LLM-verified.
- **GPTrace** ([arxiv 2512.01609](https://arxiv.org/html/2512.01609)) — high-dim embeddings cluster poorly with HDBSCAN; reduce dims to ~64 first.
- **Production agglomerative guidance** — ~0.9 for tight near-dup, 0.75–0.85 for "same concept, looser wording."

**For ChronicleDB on contextual embeddings, start with 0.88 auto-merge and 0.80 LLM-verify.** Calibrate by picking 50 known-equivalent and 50 known-distinct pairs from the existing Persona/Protagonist data, plotting both distributions, and choosing where they separate.

---

## 3. Representation + storage

### One embedding per trait vs per character

Three published patterns:

1. **One embedding per trait row** (current implicit ChronicleDB design). Best for retrieval-by-trait and easy fan-out, but suffers from the short-string variance problem.
2. **Aggregated per-character embedding** (used by [Yu et al., 2024 quotation attribution paper](https://arxiv.org/html/2406.11368v1)). Build one vector per character by mean-pooling the contextualized mentions. Good for "is this the same character" tasks and similarity search, but loses per-trait granularity.
3. **Both, layered.** Cognee's multi-layer graph and LangMem's hierarchical model both do this: per-attribute nodes for granular operations, plus a per-entity rollup vector for character-level retrieval.

For ChronicleDB the right answer is **(1) + (3)**: keep per-trait rows (you need them for category filtering and the existing UI), but additionally maintain a per-character `character_summary_embedding` derived from all dispositional traits + background. This lets you do "find a similar character" queries cheaply and gives you a rollup signal for context loading.

### Canonical row + variants pointing to it

This is the EDC / KGGEN pattern, and yes it's done in production:

- **EDC** ([2024](https://arxiv.org/html/2404.03868v1)) maintains a canonical schema and target-aligns extractions onto it.
- **LKD-KGC and KGGEN** ([survey 2025](https://arxiv.org/html/2510.20345v1)) merge equivalent entities through LLM-guided clustering, keeping a canonical representative per cluster.
- **Mem0** ([prompts.py](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)) implements this through its UPDATE action: when a new fact looks similar to an existing one, the existing row is rewritten to be more specific and the new one is dropped.

For ChronicleDB the schema change is small:

```sql
ALTER TABLE traits ADD COLUMN canonical_id BIGINT REFERENCES traits(id);
ALTER TABLE traits ADD COLUMN canonical_embedding vector(768);
ALTER TABLE traits ADD COLUMN aliases TEXT[] DEFAULT '{}';
```

A row whose `canonical_id IS NULL` is a canonical trait. Variants set `canonical_id` to point at it and append their original text to `aliases`. Retrieval queries `WHERE canonical_id IS NULL` and gets back deduped data, while still being able to follow back to the raw extraction provenance.

### Trait clustering at ingest time

HDBSCAN / agglomerative clustering on per-character traits:

- **Pros**: One-shot, no LLM cost. Works well for the "obvious near-duplicates" tier.
- **Cons**: HDBSCAN's published behavior on small clusters with high-dim embeddings is unstable across re-runs ([sklearn docs](https://scikit-learn.org/stable/modules/clustering.html), [HDBSCAN deep dive](https://arize.com/blog-course/understanding-hdbscan-a-deep-dive-into-hierarchical-density-based-clustering/)). For 30–100 traits per character it will be jumpy. The GPTrace paper explicitly warns about this and suggests dim reduction first.
- **Better recipe**: **Agglomerative clustering with cosine + a fixed distance threshold of ~0.12** (i.e. similarity 0.88) on contextual embeddings. Agglomerative is deterministic given the same inputs, supports cosine natively in sklearn, and doesn't require choosing `k`. Pick the medoid (closest to cluster centroid) as the canonical representative.
- **Stability across re-ingests**: only cluster *new* candidates against the existing canonical set, not the entire trait list. This is the same incremental-clustering pattern Zep uses for its semantic-entity layer ([Zep paper](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf)).

### Hybrid embeddings: trait + context

This is the single biggest lever in this report.

The Anthropic *Contextual Retrieval* result ([Anthropic Sept 2024](https://www.anthropic.com/news/contextual-retrieval)) is a 35% reduction in retrieval failure (5.7% → 3.7%) just from prepending 50–100 tokens of chunk-specific context before embedding. Their example: "The company's revenue grew by 3% over the previous quarter" becomes "This chunk is from an SEC filing on ACME Corp's Q2 2023 performance; the previous quarter's revenue was $314M. The company's revenue grew by 3% over the previous quarter."

For traits the analogue is:

- Bad: embed `"stoic"`
- Better: embed `"Protagonist is stoic"`
- Best: embed `"Protagonist is stoic — he never shows fear in combat and rarely reacts visibly to provocation."`

The third form gives the encoder enough lexical surface area that paraphrases like `"unflappable"` or `"keeps his composure under pressure"` land in the same neighborhood. It also disambiguates *transient* uses: if the LLM extracts `"awed"` from a scene, the contextualized form will read `"Persona is awed: when she first sees the cathedral she gasps"` — and that sentence will land near other transient emotional reactions, not near her dispositional traits.

The cost is real — Gemini embedding for 50–100 token strings is more expensive per call than for 1-token strings — but you're already paying the LLM extraction cost, and the contextual sentence is essentially free output from the same extraction call. Make the extractor emit `(trait, evidence_sentence)` pairs and embed the evidence sentence.

---

## 4. Dispositional vs transient classification

### Lexicon-first gate (cheap, do this first)

You already have a 120-word stem blocklist. Replace it with two lookups:

1. **Goldberg's 100 Big-Five markers** ([Goldberg 1992](https://projects.ori.org/lrg/PDFs_papers/Goldberg.Big-Five-Markers-Psych.Assess.1992.pdf)) as a **positive whitelist**. If a candidate (after stemming) matches a Goldberg marker, it's almost certainly dispositional. Auto-accept.
2. **NRC Emotion Lexicon** ([NRC](https://saifmohammad.com/WebPages/NRC-Emotion-Lexicon.htm)) as a **negative gate**. ~14,000 English words tagged for association with 8 emotions + valence/arousal. If a candidate is in NRC's emotion-associated set and *not* in Goldberg, it is probably a transient affect. Reject or downgrade to `context_snapshot.emotional_tone`.
3. **VAD lexicon** ([Mohammad NRC-VAD](https://saifmohammad.com/WebPages/nrc-vad.html)) gives 20,000 English words scored on Valence, Arousal, Dominance. Words with extreme arousal (>0.8) are almost always transient feelings; words with neutral arousal and any V/D are more likely traits. Useful as a soft filter.

Estimated coverage: this catches roughly 70–80% of the easy cases (your "adoring/amused/besotted/aroused/awestruck" examples are *all* in NRC) without any LLM call.

### LLM gate for the middle 20%

For the candidates that pass the lexicon gate but aren't on the Goldberg whitelist (paraphrases, multi-word phrases, faction labels), run a small dedicated classifier prompt. Mem0's audit-fix recommendation is to add a `REJECT` action and 12 explicit exclusion rules ([issue #4573](https://github.com/mem0ai/mem0/issues/4573)). The same shape works here:

```
You are filtering candidate character traits.
Reject the candidate if:
- It describes a momentary feeling tied to one scene
- It is narration ("bundle of light and energy")
- It restates plot ("had a fight with X")
- It is a transient state caused by an event
Accept if:
- It describes a stable disposition, skill, value, or background fact
Candidate: "{trait}"
Evidence: "{sentence_it_was_extracted_from}"
Answer: ACCEPT or REJECT, then one-sentence justification.
```

Estimated cost: ~50 tokens per candidate. With ~1100 traits across all chats and the lexicon catching 70%, you're at ~330 LLM calls total — small, and one-shot during backfill.

The PAED follow-up ([NLI for persona extraction, 2024](https://arxiv.org/html/2401.06742v1)) demonstrates that an off-the-shelf NLI model can play this role *without* an LLM call (`<character> is <trait>` as hypothesis, scene text as premise, accept on entailment, reject on contradiction). That's a cheaper alternative if the cost of even 330 LLM calls is a concern.

### Lexicon resources to actually grab

- Goldberg 100 unipolar markers: in [Goldberg 1992 Psych. Assess. PDF](https://projects.ori.org/lrg/PDFs_papers/Goldberg.Big-Five-Markers-Psych.Assess.1992.pdf), table 2.
- Saucier's 40-item Mini-Markers: [PubMed 7844738](https://pubmed.ncbi.nlm.nih.gov/7844738/).
- IPIP-50 (free, public domain, easy CSV): [IPIP](https://ipip.ori.org/).
- NRC Emotion Lexicon & NRC-VAD: [Mohammad's NRC page](https://saifmohammad.com/WebPages/NRC-Emotion-Lexicon.htm).
- DMIDI Trait Descriptive Adjectives list: [SJDM DMIDI](https://sjdm.org/dmidi/Trait_Descriptive_Adjectives.html).
- For a maximal personality-adjective wordlist see Goldberg's [hierarchical analysis of 1,710 adjectives PDF](https://projects.ori.org/lrg/pdfs_papers/english%20lexical%201,710.pdf).

These are all CSV-or-text and small enough to ship as a constant table inside the plugin.

---

## 5. Specific recommendations for ChronicleDB, ranked by ROI

Each recommendation is scoped to fit Gemini embeddings + pgvector + per-batch live ingest + one-shot backfill, and gives expected effort.

### Path 1 — Contextual embeddings + canonical-row dedup (highest ROI, ~1.5 days)

**What changes in the extractor**: have the extraction prompt emit `{ trait, category, evidence_sentence }` instead of `{ trait, category }`. The evidence sentence is one cleaned sentence from the input batch that justifies the trait. Cost: zero extra LLM calls, just more output tokens.

**What changes in the embedder**: embed `"<character_name> is <trait>: <evidence_sentence>"` instead of `"<trait>"`. Single-line code change. Use `SEMANTIC_SIMILARITY` task type and 768 dim, with normalization confirmed.

**What changes in the schema**:
```sql
ALTER TABLE traits ADD COLUMN evidence_sentence TEXT;
ALTER TABLE traits ADD COLUMN canonical_id BIGINT REFERENCES traits(id) ON DELETE SET NULL;
ALTER TABLE traits ADD COLUMN aliases TEXT[] DEFAULT '{}';
ALTER TABLE traits ADD COLUMN merged_count INT DEFAULT 1;
CREATE INDEX traits_canonical_idx ON traits (character_id, canonical_id);
```

**What changes at ingest time**: after embedding a new candidate, run an HNSW kNN against existing traits for the same character. If the top hit has cosine >= 0.88, set `canonical_id` to that hit's id and append the new text to its `aliases` (the new row is essentially dead). If 0.80–0.88, queue for an LLM verifier prompt (path 4). If < 0.80, insert as a new canonical row.

**What changes at retrieval time**: filter `WHERE canonical_id IS NULL`. Optionally use `aliases` array for full-text fallback.

**Expected impact**: Based on Anthropic's 35% retrieval-failure reduction and the EDC results, this should collapse the messy paraphrase clusters ("Has a history of violence" / "Former enforcer" etc.) automatically. Persona/Protagonist should drop from 500+ rows to ~80–150 distinct canonical traits each.

### Path 2 — Lexicon-first dispositional gate (highest ROI per hour, ~half a day)

**What changes**: ship Goldberg-100 + NRC Emotion + NRC-VAD as static JSON in the plugin. Add a small classifier function that runs *before* a candidate is embedded.

```ts
function classifyDisposition(candidate: string, evidence: string): 'accept' | 'reject' | 'verify' {
  const stem = englishStem(candidate.toLowerCase());
  if (GOLDBERG_100.has(stem)) return 'accept';
  if (NRC_EMOTION.has(stem) && !GOLDBERG_100.has(stem)) {
    // also check VAD arousal if available
    if (NRC_VAD[stem]?.arousal > 0.7) return 'reject';
    return 'verify';
  }
  return 'verify';
}
```

**Schema**: none.

**Retrieval**: none.

**Expected impact**: removes ~70% of transient-emotion noise without an LLM call. Catches *every* example in your bug report ("adoring," "amused," "besotted," "aroused," "awestruck," "annoyed at staff" — all in NRC, none in Goldberg).

**Why it's #2 not #1**: by itself it doesn't solve the paraphrase / morphological dedup. Path 1 does. They compose.

### Path 3 — LLM verifier loop (medium ROI, ~1 day, ongoing token cost)

**What changes**: when a candidate falls in the 0.80–0.88 cosine band against an existing trait, send both to a tiny verifier prompt that returns one of `MERGE / KEEP_DISTINCT / REJECT_NEW`. Apply the result.

This is the EDC canonicalization step, applied incrementally. Mem0's audit-fix recommendation is essentially the same thing ([issue #4573](https://github.com/mem0ai/mem0/issues/4573)).

**Schema**: `ALTER TABLE traits ADD COLUMN verified_at TIMESTAMPTZ;` so you only verify each pair once.

**Cost**: ~40 input + 20 output tokens per verification. With realistic ingest, maybe 5–20 verifications per chat batch. Trivial against the extraction cost itself.

**Expected impact**: catches the semantic paraphrases that Path 1's threshold misses ("Former 'dog' of Faction" / "Former enforcer" — these are close but might not clear 0.88).

### Path 4 — Per-character rollup embedding + similarity-aware retrieval (medium-low ROI, ~half a day)

**What changes**: maintain `characters.summary_embedding` as the mean-pool of all dispositional trait embeddings for that character (cheap to recompute on insert). Index with HNSW.

**Use cases unlocked**: "find similar characters across chats" (the closest analogue to BookNLP's global character vectors from [Yu 2024](https://arxiv.org/html/2406.11368v1)), "load context relevant to character archetype," and graph-level pruning queries.

**Cost**: zero extra LLM, one extra HNSW index, one trigger.

**Expected impact**: not directly relevant to the dedup problem but unblocks the next round of features and is essentially free to add.

### Path 5 — Batch-level extraction with explicit dispositional vs scene-emotional separation in the prompt (small, ongoing)

**What changes**: rewrite the extraction prompt so the LLM emits *two separate buckets per scene*: `persistent_traits` (dispositional, multi-scene) and `scene_state` (transient feelings, current mood). Document the distinction in the prompt with three positive and three negative examples.

This is what Mem0's post-audit fix does — explicit exclusion rules and negative few-shot examples ([issue #4573](https://github.com/mem0ai/mem0/issues/4573)).

You're already doing some of this. The change is to make the *output schema* enforce the distinction (two separate fields the model must populate), so the LLM has to decide before emission instead of after.

**Schema**: write the `scene_state` bucket into `context_snapshots.emotional_tone` (already exists per your description).

**Expected impact**: small additional reduction on transient leakage past the lexicon gate. This is the cheapest improvement to keep doing in parallel with the others.

---

### Suggested ordering

Day 1: Path 2 (lexicon gate) — fastest win, no infra change. Will visibly reduce noise on the next backfill pass.

Day 2: Path 5 (prompt split) — almost free, composes with everything.

Days 3–4: Path 1 (contextual embeddings + canonical rows) — the centerpiece. This is what actually fixes the paraphrase cluster problem. Run a one-shot backfill with the new embedder against existing traits; cluster aggressively; manually inspect one character (Persona or Protagonist) before applying to all.

Day 5: Path 3 (LLM verifier loop) — only after Path 1 is in. The verifier is what handles the semantic-paraphrase tier that pure cosine misses.

Later: Path 4 (rollup embeddings) when you next need cross-character features.

### What not to do

- **Don't switch embedding models.** Voyage / OpenAI / Cohere give 1–3% on MTEB. They will not solve your problem; the problem is input shape.
- **Don't move to 1536 or 3072 dim.** Google's own data: 0.26% gain at 4× storage. Stay at 768.
- **Don't pure-cluster without an LLM/NLI gate.** EDC's central warning: pure clustering over-generalizes.
- **Don't fine-tune a custom encoder yet.** PAED-style contrastive is real, but ROI is below Path 1.
- **Don't extract per-message.** Buffer to a coherent scene. HaluMem and Mem0 both show selective extraction beats greedy by ~10%.

---

## Sources

All citations are inline in the body. Key references:

- **Mem0**: [paper](https://arxiv.org/html/2504.19413v1), [audit issue](https://github.com/mem0ai/mem0/issues/4573), [prompts.py](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)
- **Zep / Graphiti**: [paper PDF](https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf), [Cognee benchmarks](https://www.cognee.ai/blog/deep-dives/ai-memory-evals-0825)
- **EDC** (Extract / Define / Canonicalize): [arxiv 2404.03868](https://arxiv.org/html/2404.03868v1), [code](https://github.com/clear-nus/edc)
- **PAED**: [ACL 2023](https://aclanthology.org/2023.acl-long.544/), [code](https://github.com/Cyn7hia/PAED), [NLI follow-up](https://arxiv.org/html/2401.06742v1)
- **LitBank / BookNLP**: [LitBank](https://github.com/dbamman/litbank), [BookNLP](https://github.com/booknlp/booknlp), [character embeddings paper](https://arxiv.org/html/2406.11368v1)
- **Goldberg lexicons**: [100 markers](https://projects.ori.org/lrg/PDFs_papers/Goldberg.Big-Five-Markers-Psych.Assess.1992.pdf), [Big-Five factors](https://projects.ori.org/lrg/PDFs_papers/Goldberg.Big-Five-FactorsStructure.JPSP.1990.pdf), [1,710 adjectives](https://projects.ori.org/lrg/pdfs_papers/english%20lexical%201,710.pdf), [Saucier Mini-Markers](https://pubmed.ncbi.nlm.nih.gov/7844738/)
- **NRC lexicons**: [NRC Emotion](https://saifmohammad.com/WebPages/NRC-Emotion-Lexicon.htm), [NRC-VAD](https://saifmohammad.com/WebPages/nrc-vad.html)
- **Embeddings & contextual retrieval**: [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval), [Gemini API docs](https://ai.google.dev/gemini-api/docs/embeddings), [Gemini Embedding paper](https://arxiv.org/html/2503.07891v1), [Voyage-3-large](https://blog.voyageai.com/2025/01/07/voyage-3-large/), [SimCSE](https://arxiv.org/abs/2104.08821)
- **Clustering / dedup**: [NeMo SemDeDup](https://docs.nvidia.com/nemo-framework/user-guide/latest/datacuration/semdedup.html), [GPTrace](https://arxiv.org/html/2512.01609), [HDBSCAN deep dive](https://arize.com/blog-course/understanding-hdbscan-a-deep-dive-into-hierarchical-density-based-clustering/)
- **Big-Five LLM eval / personality embeddings**: [JMIR 2025](https://www.jmir.org/2025/1/e75347/PDF), [PMC12262148](https://pmc.ncbi.nlm.nih.gov/articles/PMC12262148/), [BIG5-CHAT](https://aclanthology.org/2025.acl-long.999.pdf)
- **Anthropic persona vectors** (background): [post](https://www.anthropic.com/research/persona-vectors), [arxiv 2507.21509](https://arxiv.org/abs/2507.21509)
