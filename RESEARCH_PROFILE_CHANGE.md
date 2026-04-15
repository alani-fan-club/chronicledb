# Mutable Character State Over Long Roleplay Arcs

A design research doc for ChronicleDB. How should the schema and trait pipeline represent the fact that characters *change* across a long chat, when the existing `traits` table treats every observation as accumulated evidence and nothing in the pipeline can invalidate an earlier row?

## 1. Problem statement

`traits` is append-mostly. `upsertTrait` (db.js:484) merges a candidate onto an existing canonical via the Path 1 kNN + Path 3 verifier or inserts a new canonical — but the canonical itself is immutable. `content`/`evidence_sentence`/`embedding` are written once (the db.js:550 rewrite only upgrades to a longer synonym). `canonical_id` tracks alias provenance, not succession. No `valid_from`/`valid_to`, no supersession edge, no temporal ordering. `created_at` exists but `getTraitsForCharacter` (db.js:773) doesn't read it.

Alice is extracted as `cheerful`/`brave` in chapters 1–3. By chapter 12 the extractor emits `jaded`/`cowardly` from her post-trauma arc. Neither is cosine-close to the old canonicals — opposites cluster far apart — so both land as *new* canonicals. The mindmap panel and `/character/:name/traits` (index.js:1001) return `{cheerful, brave, jaded, cowardly}` as a flat set. `recomputeCharacterSummary` (db.js:801) averages all four embeddings into `characters.summary_embedding`, producing a vector between two contradictory affects that then pollutes cross-chat character-similarity kNN. Nothing can say "`cheerful` stopped being true at turn 420."

**Crucial scoping finding** from `shared/retrieval-core.js`: **traits are not injected into the generation prompt at all.** SECTION_REGISTRY (retrieval-core.js:966–1181) has Current Scene, World State, Plot Threads, matched hits, Recent Events, Knowledge Boundaries, Relationships — no trait section. Today's contradiction failure manifests in UI panels and `characters.summary_embedding` (cross-chat similarity), **not** in what the model sees at generation time. That reshapes the ROI math in §3.

## 2. Options survey

**(a) Mutate canonicals in place (AGARS).** `UPDATE traits SET content=$new, embedding=$new WHERE id=$old`.
Catastrophic Path 1/3 interaction: the kNN lookup (db.js:591) is spatial on the *new* embedding, so a later chapter briefly revisiting the old disposition finds no close canonical and inserts a third, ping-ponging forever. `aliases`/`merged_count` stop meaning anything (accumulated against a different semantic center). `evidence_sentence` — the load-bearing disambiguator in the Path 1 contextual embedding text — is erased for every prior merge. Zero history. *Effort: low write, high cleanup. Breaks Paths 1, 3, 4; fights Path 5 swipe cleanup.*

**(b) Temporal versioning (Zep/Graphiti bi-temporal).** `traits.valid_from`, `traits.valid_to NULL`. Retrieval filters `valid_to IS NULL`; `world_state` already uses this shape (schema.sql:78).
Central unresolved question: **who decides** a new `jaded` contradicts the existing `cheerful`? Opposites don't land in the Path 3 verify band — lexical antonymy won't catch "opened up after meeting X" — so you need a new contradiction pass comparing against *all* same-category canonicals, LLM-driven. *Effort: low schema, medium pipeline (extra LLM call per non-merge insert). Path 1 kNN gains a contradiction-lookup, Path 3 gains a fourth SUPERSEDES verdict, every `traits` reader + `recomputeCharacterSummary` must filter.*

**(c) Supersession edges.** New `trait_supersedes (old_id, new_id, reason, source_message_index)`; retrieval filters out any `id` with an outbound edge.
Orthogonal to `canonical_id` (temporal edge between canonicals vs alias edge variant→canonical). Zero mutation of existing rows. Same contradiction-detection question as (b). Two predicates on every trait read. *Effort: low schema, medium pipeline. Same impact as (b).*

**(d) Separate `character_state` table.** `(character_id, chat_id, field_name, value, updated_at, source_event_id)`, PK `(character_id, chat_id, field_name)`. UPSERT overwrites. Closed field set: `current_mood`, `current_goal`, `current_situation`, `current_loyalty`, `current_injury`, `current_disposition`, `current_relationship_stance`.
Aligns with the **existing** `persistent_traits` vs `scene_state` split (extractor.js:115–221). Today `scene_state[]` gets folded into `context_snapshots.emotional_tone` and thrown away per-batch; (d) is "promote scene_state to typed, chat-scoped, first-class storage." UPSERT sidesteps contradiction detection entirely. Matches AGARS's `profile_change` 1:1. Doesn't touch `traits`, so Paths 1–5 are untouched. Closed field set (prompt+code to extend); no history by default; split rule ("durable→trait; current-arc→state") is the same call the extractor already makes. *Effort: low schema, low pipeline. Zero impact on Paths 1–5.*

**(e) Lifespan-aware categories.** Tag categories stable/evolving; soft-decay at retrieval.
Doesn't fix anything — contradictory rows still live in the table and still reach UI panels and `summary_embedding` (no way to weight a mean-pool). *Rejected.*

## 3. Recommendation

**Do (d) now. Consider (c) as a follow-up only if the closed field set proves too restrictive or if we start injecting traits into generation.**

1. **(d) has zero blast radius on the trait pipeline.** Path 1+3 in `upsertTrait` is the highest-complexity code in ChronicleDB (lexicon gate, fuzzy pre-check, contextual embedding, kNN, verifier, three merge branches, aliases, debounced rollup). Every option touching `traits` introduces a coherence failure I can point at; (d) doesn't touch any of it.
2. **(d) matches a split the extractor prompt already enforces.** `persistent_traits` vs `scene_state` is the first thing the prompt teaches the LLM; today `scene_state` lands in `emotional_tone` and gets dropped. (d) keeps it, typed and per-chat.
3. **Retrieval-path argument.** Traits aren't in the generation prompt today. The immediate consumers of the bug are UI panels and `characters.summary_embedding`. A per-chat overwrite table fixes both. If we later want to inject current state, it's a ~20-line SECTION_REGISTRY addition.
4. **ROI.** (d) is a day; (b)/(c) are a week including a contradiction-detection pass, verifier cache invalidation, tested Path 3 interaction. For a feature that doesn't yet touch generation, a week is unjustifiable.

What (d) doesn't give us: history of state transitions. "Alice became jaded at turn 420" isn't queryable without `character_state_history`. Ship (d) without history; add only if user feedback demands it. `source_event_id`+`source_message_index` suffice for debug "when did this change?" via join.

## 4. Concrete sketch

**New table** (add to `schema.sql` immediately after `traits`, per MIGRATIONS.md pattern):

```
CREATE TABLE IF NOT EXISTS character_state (
    character_id         TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    chat_id              TEXT NOT NULL,
    field_name           TEXT NOT NULL,   -- closed set, enforced in applier
    value                TEXT NOT NULL,
    evidence             TEXT,            -- one-sentence justification
    source_event_id      TEXT REFERENCES events(id) ON DELETE SET NULL,
    source_message_index INT,
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (character_id, chat_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_character_state_chat
    ON character_state (chat_id);
CREATE INDEX IF NOT EXISTS idx_character_state_swipe
    ON character_state (chat_id, source_message_index)
    WHERE source_message_index IS NOT NULL;
```

Closed `field_name` enum enforced in `extractor.js::applyExtractionToGraph`: `current_mood`, `current_goal`, `current_situation`, `current_loyalty`, `current_injury`, `current_disposition`, `current_relationship_stance`.

**New extraction prompt field.** Add one object per character alongside `persistent_traits[]` / `scene_state[]`:

```
"character_state": {
  "current_mood": "...", "current_goal": "...", "current_situation": "...",
  "current_disposition": "...", "current_loyalty": "...",
  "current_injury": "...", "current_relationship_stance": "..."
}
```

All fields nullable; the LLM is instructed to **emit a field only if this batch actively changes it**. Null fields are skipped by the writer so UPSERT preserves the prior value. The existing `scene_state[]` stays (still feeds `emotional_tone`); when both mood paths are populated, `character_state.current_mood` wins.

**Who computes.** The extractor, same call — no separate pass. The extractor already owns the durable-vs-momentary decision. `applyExtractionToGraph` gains a small loop calling `db.upsertCharacterState(...)` (plain `INSERT ... ON CONFLICT ... DO UPDATE`).

**What retrieval reads.** New helper `getCharacterState(pool, chatIds, characterIds)` in `shared/retrieval-core.js`; `retriever.js::retrieve` parallel block gains an eighth promise; new SECTION_REGISTRY entry "Current Character State" (order TBD by eval); new `/character/:name/state` endpoint.

## 5. Impact on existing code

- **Trait canonicalization (Paths 1–5):** untouched. `persistent_traits[]` still flows through `upsertTrait`. The "mutable trait re-merged into old canonical" concern doesn't arise because mutable fields don't go through `traits`.
- **Retrieval:** additive. New helper, new SECTION_REGISTRY entry. No existing query changes.
- **Extractor prompt:** adds one object per character. Rule: "durable→trait, current-arc closed-set→state, momentary-affect→scene_state." Put the closed field list verbatim in the prompt — same strategy as the existing `category` enum.
- **Swipe handling:** `source_message_index` tagged on write. But UPSERT means swipe cleanup **cannot delete-to-revert** — deleting erases to NULL, not to the previous value. Cleanest behavior: `/clear-message-extractions` deletes rows whose `source_message_index = msg_idx`, accepting that the field reverts to unset until re-set. Worth calling out in the PR. See `[OPEN]`.

## 6. Migration + backfill

Purely additive. Existing `traits` rows untouched. No backfill: `character_state` starts empty and populates on re-ingest; legacy chats have no state and retrieval handles the empty case (section returns null, same as every other SECTION_REGISTRY section). `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`. No `ALTER` on existing tables.

## 7. Open questions

- `[OPEN]` **Swipe semantics.** Delete-on-swipe loses prior value. Alternatives: (i) accept the loss (my pick), (ii) per-process LRU of prior values, (iii) add `character_state_history` and replay on swipe. (iii) pulls us toward (c). Need your call.
- `[OPEN]` **Field set scope.** Seven fields feels right but I haven't eyeballed the eval corpus. Cut candidates: `current_location` (already `present_at`), `current_companions` (derivable from `participated_in`), `current_resources` (too domain-specific). Adding later is cheap.
- `[OPEN]` **Inject into generation in PR1?** I lean yes — otherwise the symptom (model writes Alice as cheerful at ch12) isn't actually fixed. But it's a separate call with its own `formatMemoryBlock` budget impact. Needs your input on whether PR1 ships storage-only or storage+SECTION_REGISTRY.
- `[OPEN]` **Path 4 interaction.** `recomputeCharacterSummary` mean-pools `traits.embedding` personality rows. If `current_disposition` should influence cross-chat similarity, it needs to embed and join the mean. Default: leave Path 4 alone in PR1.
- `[OPEN]` **Chat-scoped vs global.** Defaulted to chat-scoped (matches `feels_about.session_id`, arc-local affects). Moot for single-long-chat users.
- `[OPEN]` **Admin route.** Mirror `/recompute-character-summaries` with `/recompute-character-state` for debug parity? Probably yes, not blocking.
