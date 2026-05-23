/**
 * LLM-based memory extraction for ChronicleDB.
 * Sends RP message batches to a cheap local model, gets structured JSON back.
 */

const db = require("./db");
const llmMonitor = require("./llm-monitor");

// Shared retry helper. Three call sites used to hand-roll this (callWithRetry,
// the inline generateSituatingBlurb loop, and run_eval_gemini.ts::gemini) —
// they all retry on 429/5xx with 1s → 2s → 4s → 8s → 16s backoff. Unifying
// means one place to tune, one place to fix bugs like "attempt === maxRetries"
// off-by-ones.
function defaultIsRetriable(err) {
  if (!err) return false;
  if (typeof err.status === "number") {
    return err.status === 429 || err.status >= 500;
  }
  const msg = (err.message || "").toString();
  return (
    msg.includes("429") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("RESOURCE_EXHAUSTED")
  );
}

async function withExponentialBackoff(fn, { retries = 4, baseDelay = 1000, isRetriable = defaultIsRetriable } = {}) {
  let delay = baseDelay;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries || !isRetriable(err)) throw err;
      // Full jitter — extractionConcurrency fans batches out in parallel,
      // so a shared 429/5xx will retry-stampede in lockstep without it.
      // Sleep is a uniform sample from [0, delay) rather than the full
      // delay; on average each retry waits delay/2 but is decorrelated
      // across siblings.
      await new Promise((r) => setTimeout(r, Math.random() * delay));
      delay *= 2;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error("withExponentialBackoff: exhausted without result");
}

// Wraps an LLM-calling async closure with a monitor record. Measures total
// latency (including all backoff retries if fn internally uses
// withExponentialBackoff), captures provider/model/purpose/prompt preview,
// and records the final outcome. On error, records status=error with the
// message and rethrows so caller control flow is unchanged.
async function trackLlm(meta, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const formatted = meta.formatResult
      ? meta.formatResult(result)
      : typeof result === "string"
        ? result
        : result == null
          ? null
          : JSON.stringify(result);
    llmMonitor.record({
      purpose: meta.purpose,
      provider: meta.provider,
      model: meta.model,
      promptPreview: meta.promptPreview,
      responsePreview: formatted,
      latencyMs: Date.now() - started,
      status: "ok",
      inputSize: typeof meta.inputSize === "number" ? meta.inputSize : null,
      outputSize:
        typeof formatted === "string"
          ? formatted.length
          : typeof meta.outputSize === "number"
            ? meta.outputSize
            : null,
    });
    return result;
  } catch (err) {
    llmMonitor.record({
      purpose: meta.purpose,
      provider: meta.provider,
      model: meta.model,
      promptPreview: meta.promptPreview,
      responsePreview: null,
      latencyMs: Date.now() - started,
      status: "error",
      error: err && err.message ? err.message : String(err),
      inputSize: typeof meta.inputSize === "number" ? meta.inputSize : null,
    });
    throw err;
  }
}

const EXTRACTION_PROMPT = `You are a narrative analyst for a roleplay memory system. Extract structured information from RP messages.

Each message has a speaker and content. Some are from the user (player), others from AI characters or narrators.

OVERALL CAPS — be aggressive about NOT emitting. The user has explicitly
asked for slim, summary-level extraction; this memory store gets polluted
fast and has to be cleaned by hand if you over-extract. Per BATCH
(typically 5 messages), aim for AT MOST:
  - ≤ 5 events total (only significance ≥ 3; mundane beats are noise)
  - ≤ 2 plot_threads total (only genuinely NEW unresolved tensions)
  - ≤ 3 NEW persistent_traits per character (only previously-unseen
    dispositions; do NOT re-emit traits the character already had)
  - ≤ 5 relationships total (only when sentiment/intensity meaningfully
    changes or a brand-new pair interacts for the first time)
  - ≤ 3 knowledge_updates total (only genuinely NEW information a
    character ACQUIRED this batch — see rule 7 for what counts as
    knowledge vs scene_state, event content, or world_state)
When in doubt, EMIT NOTHING for that field. Empty arrays are correct
answers most of the time.

Extract:
1. **Characters** — Extract characters who SPEAK or TAKE ACTION in this batch,
   plus characters who are the explicit subject of dialogue. SKIP one-line
   walk-ons (random servers, drivers, passersby) unless they're plot-relevant.
   Reuse names from the "Known entities" list verbatim — don't introduce
   spelling/casing variants of characters that already exist.

   For each character, also extract:
   - **aliases**: alternate surface forms of THIS character's name only.
     "Alex Reynolds" → "Alex", "Reynolds", "Al", "the Night Captain".
     Aliases are different ways to refer to the SAME identity — short
     forms, full forms, titles, epithets the character is called.

     CRITICAL: a pet name, term of endearment, or referent that one
     character uses for ANOTHER character is an alias of the character
     being referred to, NOT the speaker. Phrases like "his dove",
     "his Riley", "the foreign girl", "my sweet wife" are aliases of
     the person those phrases describe — they go under THAT character's
     aliases, never under the speaker's.

     Worked negative example — DO NOT do this:
       Passage (Alex POV, Riley is the person Alex is watching):
         "He watched his dove move through the kitchen, his Riley
          finally home."
       Wrong: emit aliases ["his dove", "his Riley"] under Alex
         because the phrases occur in Alex's POV / dialogue.
       Right: emit aliases ["his dove", "his Riley"] under Riley.
         Alex's aliases stay limited to surface forms of Alex's own
         name (e.g. "Alex", "Alex Reynolds", "Mr. Reynolds").

     Aliases are how this character is NAMED, not what they SEE or what
     they CALL OTHERS. If you're unsure whether a phrase is an alias of
     character X, ask: "is this string a way to say character X's name,
     or is it character X's way of describing someone else?" Only the
     former goes in X's aliases.

     Never emit another character's primary name as an alias under this
     character. The downstream identity store uses aliases to dedup
     surface forms back to one row; cross-character pollution there
     causes permanent identity drift.

   Two SEPARATE buckets must be emitted per character. The distinction is
   structural — the output schema has two different fields and they go to
   two different tables. Do NOT conflate them.

   ── persistent_traits ───────────────────────────────────────────────
   Innate, STABLE, dispositional properties. Something that would still
   be true of the character tomorrow, next week, in a different scene.
   Something another character would describe as "just who they are".
   This bucket feeds the long-term trait index and is user-visible, so
   noise pollutes it permanently.

   DO emit here (positive examples):
     * Analytical — persistent cognitive disposition, still true in
       any scene.
     * Calculating — stable trait of how they approach problems.
     * Stoic — long-run emotional regulation pattern.

   DO NOT emit here (negative examples — these belong in scene_state):
     * Adoring — momentary reaction to the person in front of them.
     * Amused — one-scene affect, will not survive to tomorrow.
     * Awed — transient reaction to a specific sight or reveal.

   Other kinds of things that BELONG in persistent_traits:
     * Personality dispositions: cunning, protective, impulsive, loyal,
       jealous (the permanent-disposition kind), reserved, charismatic,
       paranoid, cynical.
     * Long-term skills: knife fighting, leadership, piano, forgery,
       combat proficiency, field medicine.
     * Background facts: former yakuza captain, raised in an orphanage,
       lost left eye in prison, speaks three languages.
     * Persistent physical features: facial marker on the jaw, mismatched
       eyes, tattoo sleeve.
     * Faction / allegiance: Faction family, Hidden Leaf ANBU.

   persistent_traits FORMAT RULES:
     * Use the **canonical adjective / noun form**, not the gerund or
       past tense. "charming" (not "charmed" or "charms"), "observant"
       (not "was observant" or "observing").
     * **Single word when possible.** "stoic" not "generally stoic and
       reserved".
     * **Do not emit morphological variants** of a trait you've already
       listed. If you're about to write "charmed", check whether you
       already wrote "charming" — if so, drop it.
     * **Lowercase** unless it's a proper noun. "stoic", not "Stoic".
     * **No redundant qualifiers** like "somewhat", "very", "extremely",
       "always" unless they change the meaning.
     * Each entry is **one fact** — don't emit "brave, loyal, and
       protective" as a single row; that's three separate entries.
     * **If you're unsure whether something is a trait or a mood, drop
       it.** Re-emitting an existing trait is wasted output, and a wrong
       trait is worse than a missing one. But do NOT skip a clear,
       evidenced trait just because the character already has a few on
       file — there is no "enough traits" cap. A well-developed character
       earns dozens of dispositional traits over the arc of a chat.
     * Emit **AT MOST 3 NEW traits per character per batch**. NEW means
       not already in the "Known entities" trait list shown for this
       character below — neither verbatim, a casing variant, nor a
       morphological / near-synonym variant. Anything in that list (or a
       reworded duplicate of it) MUST NOT be re-emitted.
     * **Bias toward emitting genuine, evidenced new traits this batch.**
       If the passage clearly shows a dispositional trait the character
       does not yet have on file, emit it (with evidence_sentence). The
       per-batch cap of 3 is the ceiling, not a target — a normal batch
       has 0–2 new traits per character.
     * **Every trait MUST come with an evidence_sentence**: one
       sentence drawn verbatim from the passage (lightly cleaned is OK:
       strip dialogue tags, redundant framing, and he-said/she-said
       attribution) that directly justifies the trait. This is what the
       downstream embedder uses to disambiguate "stoic the trait" from
       "stoic the fleeting mood"; without it the trait cannot be
       deduped against existing ones correctly.

       Positive examples of good evidence_sentence:
         * Trait: "stoic"
           evidence_sentence: "He did not flinch when the blade
             grazed his cheek, and his expression never changed."
         * Trait: "former military captain"
           evidence_sentence: "She served as a captain under the
             Northern Regiment for six years before the armistice."
         * Trait: "protective of children"
           evidence_sentence: "He stepped between the child and the
             gunman without hesitation."
       Each of those is one sentence, drawn from the passage,
       descriptive or quoted, and specifically justifies the trait.
       If no single sentence supports the trait, do not emit the
       trait — choose a different one you can actually evidence.

     * **ATTRIBUTION DISCIPLINE — the trait belongs to the character
       who DOES or EMBODIES it, NOT the character who watches, thinks
       about, or discusses them.** A trait emitted under character X
       requires an evidence_sentence in which X is the one performing
       or possessing the trait. POV / observation / attention is NOT
       attribution. This is the #1 way pairs of characters in dense
       intimate scenes get their traits leaked into each other.

       Worked negative example — DO NOT do this:
         Passage (Alex is the POV character watching Riley paint):
           "He watched her brush trail across the canvas, a streak of
            paint on her wrist catching the afternoon light."
         Wrong: emit 'painter' (skill) under Alex because the sentence
           is from Alex's POV.
         Right: emit 'painter' (skill) under Riley. The evidence_sentence
           must name Riley (or be unambiguously about her, e.g. "Her
           brush trailed across the canvas..."). For Alex, this passage
           supports a scene_state like "watching her" at most — NOT a
           skill or trait.

       Worked negative example — observer-as-knower:
         Passage: "Alex knew Riley had served in the Northern Regiment
           before the armistice."
         Wrong: emit 'former military' (background) under Alex because
           Alex is the grammatical subject.
         Right: emit 'former military' (background) under Riley. Alex
           merely *knows* the fact; the trait is about Riley.

       If the only evidence you can find is a sentence about a different
       character observing / discussing / remembering this trait, DROP
       the trait for THIS character and emit it under the character it
       actually describes (if any).

   ── scene_state ─────────────────────────────────────────────────────
   How the character is feeling / behaving IN THIS SCENE ONLY. Momentary
   reactions, moods, arousal level, situational descriptors. NOT a trait.
   These entries NEVER land in the trait table; at most they roll up into
   context_snapshot.emotional_tone for this batch.

   DO emit here (positive examples):
     * Amused — a one-scene reaction to something funny happening now.
     * Besotted — a current infatuation state, not a life-long trait.
     * Annoyed at staff — a situational reaction bound to this scene.

   DO NOT emit here (negative examples — these belong in persistent_traits):
     * Analytical — cognitive style, stable across scenes.
     * Calculating — dispositional, not a one-scene mood.
     * Stoic — regulation pattern, not a current feeling.

   Other things that BELONG in scene_state:
     * Moods: adoring, awestruck, charmed, bemused, astonished, afraid,
       nervous, excited, content, distressed, frustrated.
     * Reactions to one scene: calm but firm, cold conviction,
       appreciative of the gift, curious at the moment.
     * Situational descriptors that only apply right now: soaked from
       the rain, limping, out of breath.
     * Gerunds / participles describing what they're doing: calculating
       the odds, charming the guard. (If the character IS habitually
       that way, use the dispositional adjective in persistent_traits
       instead — NOT both.)
     * Momentary physical states: aroused, trembling, flushed, crying.
     * Single-scene philosophies dressed up as values ("annihilation
       over submission" — phrase-of-the-moment, not a life-long credo
       unless the narrator literally says so).

   scene_state is short free-text; no category required. Keep entries
   brief. Omit entirely if the scene has no notable affect for this
   character.

   Example of permissive extraction:
   A passage mentions "the bartender set down a drink" — extract the bartender
   as a character even if she has one line. Extract "the doorman" even if he
   is only named in passing.
2. **Relationships** — Cap: ≤ 5 per BATCH. Only emit when a pair INTERACTS
   in this batch AND the sentiment/intensity meaningfully changes from
   what's already known, OR they meet for the first time. Don't re-emit
   the same neutral relationship every batch.
3. **Events** — Cap: ≤ 5 events per BATCH (5 messages), and ONLY events at
   significance ≥ 3. Skip flavor beats and small gestures entirely; do not
   emit them as significance-1 or 2 — leave the array short. Prefer ONE
   summary event per scene to many granular ones.
   For each event, capture **source_quote**: the most distinctive 1-2
   sentences from the passage, copied VERBATIM. Include dialogue if any.
   Also capture **world_time** per event: optional, any in-world time marker
   for this moment, natural language like "the next morning" or "three hours
   later" or null if none. Null is the expected default — only populate when
   the prose itself names a time shift or time-of-day.
   Significance scale (only emit ≥3):
   - 5 = defining moment (major plot beat, revelation, death, betrayal)
   - 4 = important development (confrontation, decision, first meeting, turning point)
   - 3 = meaningful action with downstream consequences
   In a typical batch expect 0-3 events. Five is a hard ceiling reached only
   in dense plot-heavy batches.

   **'participants' MUST include every named character who acts, speaks,
   or receives an action in this event — not just the dialogue speaker.**
   If the summary mentions two characters, both go in the list. POV /
   observer characters who don't act stay out. Missing participants is
   the #1 reason the protagonist disappears from their own story in this
   memory store: if a scene is "X and Y do/say Z together", both X and Y
   must be in participants.

   Worked positive example (interaction, both act/receive):
     summary: "Alex gives Riley the keys to the warehouse."
     participants: ["Alex", "Riley"]   (BOTH — Alex acts, Riley receives.)

   Worked positive example (both speak):
     summary: "Alex and Riley argue about the missing money."
     participants: ["Alex", "Riley"]

   Worked negative example (observer only):
     summary: "Alex watches Riley walk into the bar from across the street."
     Riley is the one acting. Alex is only observing, not participating
     in Riley's action. participants: ["Riley"]. If you want to capture
     Alex's observation, that's a knowledge_update under Alex with
     source: "saw Riley enter the bar".
4. **Event chains** — when one event directly causes, triggers, or leads to another. Think causally: "X caused Y", "Because of A, B happened". Only chain events that have a clear causal link.
5. **Location transitions** — movement between two named locations mentioned in this batch, as a character going from A to B. Empty if none. Do not invent locations that aren't explicitly in the prose.
6. **World state** — environmental/setting changes (key-value)
7. **Knowledge updates** — Cap: ≤ 3 per BATCH. ONLY genuinely NEW
   information a character ACQUIRED this batch (learned from witnessing
   something, being told, reading, deducing). The bucket is "what does
   character X now know that they did NOT know before this batch?" —
   not "summarize what's going on with X."

   This bucket is the #1 source of noise in this memory store. The
   distinction below is structural; if you ignore it, the trait/fact
   tables get polluted and the user has to clean by hand.

   DO emit here (positive examples):
     * { character: "Alex", learned: "Riley is the one who has been
         leaving notes in their apartment.", source: "Riley confessed it." }
     * { character: "Riley", learned: "Jordan is a police officer.",
         source: "Jordan showed a badge at the door." }
     * { character: "Alex", learned: "The council meeting is on Saturday.",
         source: "Sam told them at breakfast." }
   Each is a discrete piece of NEW information acquired *in this batch*,
   with a source the character could perceive. Past-tense verb of
   acquisition: learned, heard, was told, witnessed, read, deduced.

   DO NOT emit here (negative examples — these belong elsewhere):
     * "Alex is attending the council meeting."
       → ongoing scene state. Goes in context_snapshot.summary,
         NOT knowledge_updates. Alex already knows they're at the
         meeting; nothing was learned.
     * "Alex feels pressured to perform."
       → emotional state. Goes in scene_state under Alex,
         NOT knowledge_updates.
     * "Alex spent hours preparing the documents."
       → past narrative action. Goes in events (with significance
         and source_quote), NOT knowledge_updates.
     * "Sam expects Alex to handle the books."
       → world state / standing relationship dynamic. Goes in
         world_state OR a relationship row, NOT knowledge_updates,
         unless the CURRENT batch is the moment Alex first
         REALIZES Sam expects this — in which case the fact is
         "Sam expects me to handle the books" and the source is the
         moment of realization.
     * "The council expects Alex to provide a report."
       → standing world fact. world_state, NOT knowledge_updates.
     * "Alex feels used by the council."
       → emotional state, scene_state. NOT knowledge.
     * Any rewording of a fact this character already knows — the
       "Recent knowledge" list below shows what each character has
       already learned in this chat. Do NOT re-emit a fact they
       already have, even with different wording.

   FORMAT RULES:
     * Each knowledge_updates entry MUST have a 'source' field — what
       or who the character learned it from. If you can't name a source
       from the passage, the character did not "learn" anything; drop it.
     * Phrase 'learned' as a fact, not a feeling. "Riley has a hidden
       room" (knowledge) vs "Riley is hiding something from them"
       (suspicion / scene_state).
     * STRONG bias toward emitting nothing. Most batches have 0
       knowledge_updates. A whole novel chapter rarely has more than 3.
8. **Context snapshot** — a summary of the current scene state: who is present, where, emotional tone, what's happening

8b. **World state** — standing facts about the world this chat lives in.
   The "Current world state" list below shows every standing fact already
   tracked, with its canonical key. Two rules govern key naming:

   - **REUSE exact keys verbatim** when updating a fact already in the
     list. If "ship_destination" exists, do NOT write "ship destination",
     "Ship_Destination", "destination_of_ship", or "ship_destination_status"
     — write "ship_destination". Inventing a key variant for an existing
     fact creates a parallel "current" row that shadows the original
     forever.
   - **Use lowercase snake_case for new keys.** Drop trailing
     "_status" / "_state" qualifiers — the value column already conveys
     status. Examples of canonical keys: "ship_destination", "weather",
     "boarding", "piper_the_black", "alice" (NOT "Piper the Black status",
     "Alice's status", "ship_status", or "boarding_status").

   ── world_state_supersede ───────────────────────────────────────────
   When a fact in the "Current world state" list above has STOPPED being
   true in this batch — the storm passed, the boarding ended, the ship
   reached port, a character revealed to be dead is now confirmed alive
   — list its EXACT key in the world_state_supersede array so it can
   be closed instead of lingering as a stale "current" fact forever.
   Do NOT supersede a key just because the batch doesn't mention it; only
   supersede when the batch contains affirmative evidence the fact has
   changed. Standing facts (character backgrounds, established factions,
   secret knowledge) almost never need superseding.

9. **Plot threads** — Cap: ≤ 2 per BATCH, only NEW unresolved tensions.
   The "Active plot threads in this chat" list below shows every thread
   already tracked, with its stable id. Do NOT re-emit any of those, even
   with reworded titles — duplicate-by-rewording is the #1 way this list
   gets polluted. If a thread you'd write is a slight rewording of one
   already in the list, skip it.
   To close a thread that just resolved in this batch, put its id in
   the 'resolves_thread_ids' output field — do NOT re-emit it with
   type:"resolved" under a new title; that creates a duplicate row
   instead of resolving the original.

RULES:
- Only attribute knowledge to characters who were PRESENT and could perceive it
- Narrator descriptions are omniscient — characters only know what they witnessed or were told
- Track the active message text only, not alternative swipes
- Plot threads should capture NARRATIVE tension: secrets about to be revealed, fights brewing, promises made, mysteries introduced, foreshadowing of future events

Return ONLY valid JSON:
{
  "characters": [{
    "name": "",
    "aliases": [],
    "persistent_traits": [
      { "category": "personality | skill | background | physical | faction", "content": "", "evidence_sentence": "<one sentence from the passage that justifies this trait>" }
    ],
    "scene_state": [
      "amused",
      "besotted",
      "annoyed at staff"
    ],
    "role": "protagonist/antagonist/ally/npc/mentor/etc",
    "status": "active/injured/missing/dead/etc",
    "significance": 3
  }],
  "relationships": [{ "from": "", "to": "", "sentiment": -1.0, "intensity": 0.5, "description": "Rich 2-3 sentence description of the relationship dynamics, emotional undercurrents, and recent developments" }],
  "events": [{
    "event_key": "unique_short_key_like_first_meeting",
    "summary": "",
    "source_quote": "<verbatim quote from the passage>",
    "participants": [],
    "location": "",
    "significance": 3,
    "world_time": "<optional: any in-world time marker for this moment, natural language like 'the next morning' or 'three hours later' or null if none>"
  }],
  "event_chains": [{ "from": "event_key", "to": "event_key", "chain_type": "caused | triggered | led_to | followed_by", "description": "" }],
  "location_transitions": [
    { "from": "<location name>", "to": "<location name>" }
  ],
  "world_state": [{ "key": "", "value": "", "reason": "" }],
  "world_state_supersede": ["<exact key from the 'Current world state' list above whose fact has stopped being true in this batch — leave empty if nothing changed>"],
  "knowledge_updates": [
    { "character": "", "learned": "", "source": "" },
    { "character": "", "does_not_know": "" }
  ],
  "items": [{ "name": "", "description": "", "powers": "", "significance": 3, "owner": "character name or null", "location": "location name or null", "status": "intact/damaged/lost/hidden/etc" }],
  "locations_detail": [{ "name": "", "description": "", "importance": 3, "current_state": "What the location currently looks like or what's happening there" }],
  "context_snapshot": {
    "summary": "Brief description of the current scene",
    "location": "Where the scene is taking place",
    "present_characters": ["names of characters currently present"],
    "emotional_tone": "tense/warm/hostile/playful/melancholic/etc",
    "genre": "The genre/mood of this RP (action/romance/mystery/horror/etc)"
  },
  "plot_threads": [
    {
      "title": "Short title for the thread",
      "description": "What's unresolved or being foreshadowed",
      "type": "pending | foreshadowing | unresolved | resolved",
      "involved_characters": ["names"],
      "importance": 3
    }
  ],
  "resolves_thread_ids": ["<id of an existing active plot thread that just resolved in this batch — copy verbatim from the 'Active plot threads' list above>"],
  "contradictions": ["Any detail that contradicts previously established facts, if noticed"]
}`;

// Per-message hard cap on what gets shown to the extraction LLM.
// Originally 2000 — silently lopped the back half off most narrative
// RP messages, dropping events / traits / world-state changes that
// happened past the cutoff. 12000 (~3k tokens) covers virtually every
// real message and still bounds pathological 50k-char paste-bombs at
// 5 msgs/batch × 12k = 60k chars (~15k tokens), well under any modern
// extraction LLM's context window.
const EXTRACT_MSG_CHAR_CAP = 12000;

// Default model for every text-generation call site (extract, verifier,
// situating blurb, arc naming). Each site reads its own settings override
// (extractionModel / verifierModel / contextModel / arcNamingModel) and
// falls back through extractionModel before landing here, so swapping
// providers globally is one settings edit. Previously each site hardcoded
// the same literal, which drifted whenever the default got bumped.
const DEFAULT_TEXT_MODEL = "gemini-2.5-flash-lite";

// Derive a userName from the messages themselves when the caller didn't
// pass one (or passed an empty/whitespace-only value). The UI extension
// reads ctx.name1 from SillyTavern, but ctx.name1 is empirically prone to
// returning undefined under certain ST lifecycle states — and when that
// happens, isPersonaName silently returns false for every batch and the
// global persona pool never accumulates anything. Falling back to the
// most-frequent `name` across is_user=true messages is a deterministic
// signal pulled from the actual chat content, which is what we want
// anyway (the persona's NAME in dialogue is the source of truth for who
// the user is playing).
//
// Returns null when no is_user messages have a usable name — caller
// should treat that as "no persona context for this batch".
function derivePersonaNameFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const counts = new Map();
  for (const m of messages) {
    if (!m || !m.is_user) continue;
    const name = typeof m.name === "string" ? m.name.trim() : "";
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) { best = name; bestN = n; }
  }
  return best;
}

// Resolve the persona name with a two-step fallback: caller-provided
// userName (from ctx.name1) wins when present and non-blank; otherwise
// derive from the message stream. Centralized so /extract,
// /ingest-chat, and applyExtractionToGraph all converge on the same
// resolution rule.
function resolveUserName(userName, messages) {
  if (typeof userName === "string" && userName.trim().length > 0) {
    return userName.trim();
  }
  return derivePersonaNameFromMessages(messages);
}

// Decide whether an extracted character is the user's persona by matching
// against the userName the chat ingest harness passed in. Comparison is
// case- and whitespace-insensitive, and considers both the character's
// primary name AND aliases (the user persona's name often appears as a
// nickname / pet name / title in dialogue, and the LLM frequently emits
// the canonical name in `aliases` when extracting under a different
// surface form). Returns false when userName is missing — without a known
// persona name we have nothing to match against and persona-mirroring is
// skipped for the batch.
function isPersonaName(extractedChar, userName) {
  if (!userName || typeof userName !== "string" || !userName.trim()) return false;
  const target = userName.trim().toLowerCase();
  if (!extractedChar || typeof extractedChar !== "object") return false;
  if (typeof extractedChar.name === "string" && extractedChar.name.trim().toLowerCase() === target) {
    return true;
  }
  if (Array.isArray(extractedChar.aliases)) {
    for (const a of extractedChar.aliases) {
      if (typeof a === "string" && a.trim().toLowerCase() === target) return true;
    }
  }
  return false;
}

async function extract(settings, { characterName, userName, messages, chatId, messageIndex = null }) {
  // Resolve persona name with caller→message-stream fallback. The result
  // is used both in the prompt context line and (downstream) in
  // applyExtractionToGraph's persona detection. We log the resolved name
  // ONCE per extract call so a live install can confirm whether persona
  // mirroring is firing, without flooding the console on bulk ingests.
  const resolvedUserName = resolveUserName(userName, messages);
  if (!userName && resolvedUserName) {
    console.warn(
      `[ChronicleDB] extract: caller passed empty userName; derived "${resolvedUserName}" from is_user messages`,
    );
  }
  let truncatedCount = 0;
  const msgBlock = messages
    .filter((m) => !m.is_system)
    .map((m) => {
      const body = typeof m.mes === "string" ? m.mes : "";
      const capped = body.length > EXTRACT_MSG_CHAR_CAP ? body.slice(0, EXTRACT_MSG_CHAR_CAP) : body;
      if (capped.length < body.length) truncatedCount += 1;
      return `[${m.is_user ? "USER" : "CHARACTER"}] ${m.name}: ${capped}`;
    })
    .join("\n\n---\n\n");
  if (truncatedCount > 0) {
    console.warn(
      `[ChronicleDB] extraction: ${truncatedCount} of ${messages.length} message(s) exceeded ${EXTRACT_MSG_CHAR_CAP} chars and were truncated for the extractor prompt. Embeddings still index the full text via chunkText.`,
    );
  }

  // Cross-batch entity context: prepend a bullet list of characters,
  // locations, and items already known in THIS chat so the per-batch
  // extraction LLM stops spawning variants of the same entity ("the
  // tavern" in batch 5, "The Tavern" in batch 12). The list is best-
  // effort — if chatId is missing or the lookup fails, the prompt is
  // unchanged from the pre-fix behavior. AGARS-inspired; paired with
  // deterministic slug canonicalization at insert time in
  // db.upsertLocation / db.upsertItem as a backstop.
  let knownSection = "";
  if (chatId) {
    try {
      const known = await db.listKnownEntitiesForChat(settings, chatId, messageIndex);
      if (known) {
        const bullets = [];
        if (known.characterNames && known.characterNames.length > 0) {
          bullets.push(`- Characters: ${known.characterNames.join(", ")}`);
        }
        if (known.locationNames && known.locationNames.length > 0) {
          bullets.push(`- Locations: ${known.locationNames.join(", ")}`);
        }
        if (known.itemNames && known.itemNames.length > 0) {
          bullets.push(`- Items: ${known.itemNames.join(", ")}`);
        }
        if (bullets.length > 0) {
          knownSection =
            `\n\nKnown entities in this chat (prefer reusing these exact names when you recognize them; do not re-name or re-describe them with variations):\n` +
            bullets.join("\n");
        }
        // Active plot threads — give the extractor the real list so it can
        // (a) skip emitting reworded near-duplicates of an existing tension,
        // and (b) close threads via resolves_thread_ids using the stable id
        // instead of re-emitting them with type:"resolved" under a slightly
        // different title (which would hash to a NEW row and leave the
        // original NULL forever).
        if (known.activePlotThreads && known.activePlotThreads.length > 0) {
          const threadLines = known.activePlotThreads.map((t) => {
            const chars = (t.involvedChars && t.involvedChars.length > 0)
              ? ` (involves: ${t.involvedChars.join(", ")})`
              : "";
            return `  - id=${t.id} | ${t.title}${chars}`;
          }).join("\n");
          knownSection +=
            `\n\nActive plot threads in this chat (do NOT re-emit any of these as new threads, even with reworded titles — they are already tracked. If a listed thread has been resolved by the messages in this batch, put its id in resolves_thread_ids):\n` +
            threadLines;
        }
        // Recent knowledge per character — surfaced so the extractor stops
        // re-emitting reworded variants of facts each character already
        // knows. Same shape as the active-plot-threads list.
        if (known.recentKnowsByChar && Object.keys(known.recentKnowsByChar).length > 0) {
          const knowsLines = [];
          for (const [charName, facts] of Object.entries(known.recentKnowsByChar)) {
            if (!Array.isArray(facts) || facts.length === 0) continue;
            knowsLines.push(`  ${charName}:`);
            for (const f of facts) knowsLines.push(`    - ${f}`);
          }
          if (knowsLines.length > 0) {
            knownSection +=
              `\n\nRecent knowledge each character already has in this chat (do NOT re-emit any of these as new knowledge_updates, even with reworded wording — they are already tracked. Only emit knowledge_updates for genuinely NEW information acquired in this batch):\n` +
              knowsLines.join("\n");
          }
        }
        // Current world_state — surfaced so the extractor reuses canonical
        // keys for facts that already exist instead of inventing variants.
        // Without this list the LLM emits "ship status: under_attack" one
        // batch and "ship: under_attack" the next, leaving both rows alive
        // as parallel "current" facts. Format: key=value per line.
        //
        // Stale annotation: rows whose source_message_index is more than
        // STALE_WORLD_STATE_TURNS turns behind the current batch are
        // tagged "[stale: not seen in N turns]". The single biggest cause
        // of frozen world_state is the LLM never proactively superseding
        // scene-anchored facts — a "tomorrow's meeting" key set 30 turns
        // ago that the current scene has clearly moved past. Annotating
        // gives the LLM a concrete supersede candidate list rather than
        // expecting it to infer staleness from the value strings alone.
        const wsCount = known.currentWorldState ? known.currentWorldState.length : 0;
        if (wsCount > 0) {
          const STALE_WORLD_STATE_TURNS = 15;
          const wsLines = known.currentWorldState
            .map((w) => {
              const stale = typeof w.turnsSinceSeen === "number" && w.turnsSinceSeen >= STALE_WORLD_STATE_TURNS;
              const tag = stale ? `  ⚠️ [stale: not seen in ${w.turnsSinceSeen} turns]` : "";
              return `  - ${w.key}=${w.value}${tag}`;
            })
            .join("\n");
          knownSection +=
            `\n\nCurrent world state in this chat (REUSE these exact keys when updating any of these facts; do NOT introduce a renamed variant. To mark a fact as no longer true, put its key in world_state_supersede in the output. To leave a fact unchanged, simply omit its key from world_state):\n` +
            wsLines +
            `\n\n⚠️ Rows tagged [stale: not seen in N turns] are supersede CANDIDATES. Put their exact key in world_state_supersede if EITHER condition holds:\n` +
            `  (1) the key references a SCENE-ANCHORED moment that has clearly passed (a "tomorrow" meeting that the chat has moved beyond, a "currently_at" location the characters have left, an in-progress action that has ended); OR\n` +
            `  (2) the current passage describes a setting/situation that is incompatible with the stale fact still being true (different city, different day, the involved characters are dead/gone/no-longer-affiliated).\n` +
            `Do NOT supersede stale-tagged rows that describe STANDING facts (character backgrounds, established factions, learned secrets, marriages, public knowledge). Standing facts can stay current indefinitely — the stale tag just means "no one re-mentioned it"; absence of mention is not contradiction.`;
        }
        // Thin-state nudge: when the chat has fewer than 5 standing world
        // facts on file, the LLM tends to keep the list small forever — it
        // sees nothing to dedupe against, takes the per-batch "EMIT NOTHING
        // when in doubt" rule literally, and never broadens. The result is
        // 80-turn chats with one world_state row. This nudge fires in that
        // regime and explicitly invites coverage of the kinds of standing
        // facts that ARE worth tracking, with examples.
        if (wsCount < 5) {
          knownSection +=
            `\n\n⚠️ This chat has only ${wsCount} standing world-state fact${wsCount === 1 ? "" : "s"} on file so far. If the recent passage establishes any of the following kinds of STANDING (multi-scene) facts, emit them in world_state with lowercase snake_case keys:\n` +
            `  - Setting / political: who rules where, current factions in tension, named ongoing crises, kingdom or court alliances ("kingdom_alliance", "court_faction_in_power").\n` +
            `  - Relational standing: established marriages, betrothals, public secrets, named rivalries ("alice_bob_status", "bob_eve_loyalty").\n` +
            `  - Setting facts: capital city, dominant religion, time period, magic-system flags ("setting_capital", "setting_era").\n` +
            `  - Public facts known to multiple characters in this chat: open war, recent royal death, public scandal.\n` +
            `Do NOT emit moods, momentary actions, or single-scene affect — those are scene_state. Standing facts only. Stay under 5 new keys per batch.`;
        }
        // Persona traits already known globally — surfaced so the
        // extractor doesn't waste a per-batch trait slot re-emitting a
        // disposition the persona has already established in another
        // chat. The persona row accumulates across every chat the user
        // appears in, so without this list the LLM keeps re-extracting
        // the same baseline traits ("introspective", "intellectually
        // sharp", etc.) every batch in every new chat.
        if (known.personaTraitsByChar && Object.keys(known.personaTraitsByChar).length > 0) {
          const personaLines = [];
          for (const [personaName, traits] of Object.entries(known.personaTraitsByChar)) {
            if (!Array.isArray(traits) || traits.length === 0) continue;
            personaLines.push(`  ${personaName} (persona, global across all chats):`);
            for (const t of traits) personaLines.push(`    - ${t.category}: ${t.content}`);
          }
          if (personaLines.length > 0) {
            knownSection +=
              `\n\nPersona traits already established for the user persona across prior chats (do NOT re-emit any of these as new persistent_traits — they're already on file. Only emit a NEW persona trait if the current passage reveals a major, genuinely surprising disposition this persona has never shown before):\n` +
              personaLines.join("\n");
          }
        }
      }
    } catch (err) {
      console.warn(`[ChronicleDB] extract: listKnownEntitiesForChat failed (${err.message}); continuing without known-entity context`);
    }
  }

  const prompt = `${EXTRACTION_PROMPT}

Context: roleplay between user "${resolvedUserName || userName || "(unknown)"}" and character "${characterName}".${knownSection}

Messages:
${msgBlock}

JSON:`;

  const model = (settings.extractionModel || DEFAULT_TEXT_MODEL).trim();
  const cfg = textGenerationConfig(settings, model);

  return trackLlm(
    { purpose: "extract", provider: cfg.apiType, model: cfg.model, promptPreview: prompt, inputSize: prompt.length },
    async () => {
      const { text: content, finishReason } = await generateText(settings, {
        prompt,
        model: cfg.model,
        temperature: 0.1,
        maxOutputTokens: 32768,
        responseMimeType: "application/json",
        safetySettings: DISABLED_GEMINI_SAFETY_SETTINGS,
      });
      if (finishReason && finishReason !== "STOP") {
        console.warn(`[ChronicleDB] Finish reason: ${finishReason}`);
      }
      if (!content && finishReason && finishReason !== "STOP") {
        // Surface the real cause to the LLM call monitor instead of the
        // generic "empty response" — SAFETY, MAX_TOKENS, RECITATION, etc.
        // each suggest a different fix.
        throw new Error(`${cfg.apiType} returned empty response (finishReason=${finishReason})`);
      }
      if (!content) throw new Error("LLM returned empty response");

      return parseResponse(content);
    });
}

// Best-effort sanitizer for LLM JSON quirks: strip trailing commas
// before `}` or `]` (the most common Gemini-side flaw), and strip
// JS-style line comments that occasionally leak in. Returns the input
// unchanged if no fixes apply.
function sanitizeLooseJson(s) {
  return s
    .replace(/,(\s*[}\]])/g, "$1")  // trailing commas
    .replace(/^\uFEFF/, "")          // BOM
    .replace(/\/\/[^\n]*\n/g, "\n"); // line comments
}

function tryParse(s) {
  try { return JSON.parse(s); } catch (_) { /* fall through */ }
  try { return JSON.parse(sanitizeLooseJson(s)); } catch (_) { /* fall through */ }
  return undefined;
}

function parseResponse(raw) {
  const trimmed = raw.trim();
  // Try raw JSON
  if (trimmed.startsWith("{")) {
    const parsed = tryParse(trimmed);
    if (parsed) return parsed;
  }
  // Try markdown fenced
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const parsed = tryParse(fenceMatch[1].trim());
    if (parsed) return parsed;
  }
  // Find first { to last }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const parsed = tryParse(trimmed.slice(first, last + 1));
    if (parsed) return parsed;
  }
  throw new Error("Could not parse extraction response");
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_API_BASE = "https://api.openai.com/v1";
// Vertex Express-mode API keys authenticate against aiplatform.googleapis.com
// directly, no project/region URL path and no OAuth bearer. Real region-scoped
// Vertex (aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/…)
// needs OAuth and isn't supported by the ?key= auth flow; users on a full
// Vertex project should override apiBase via embeddingApiUrl / extractionApiUrl.
const VERTEX_BASE = "https://aiplatform.googleapis.com/v1/publishers/google";
const GEMINI_EMBED_BASE = GEMINI_API_BASE;
const OPENAI_EMBED_BASE = OPENAI_API_BASE;

const DISABLED_GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

// Gemini API and Vertex Express share the :generateContent / :embedContent /
// :predict surface area but differ on where the key goes: Gemini accepts
// x-goog-api-key header; Vertex Express rejects it and wants ?key= on the
// URL. This helper centralizes that so every call site can just spread
// auth.headers into its headers and append auth.query to its URL.
function googleAuth(apiType, apiKey) {
  if (apiType === "vertex") {
    return { query: `?key=${encodeURIComponent(apiKey)}`, headers: {} };
  }
  return { query: "", headers: { "x-goog-api-key": apiKey } };
}

function textGenerationConfig(settings, modelOverride) {
  const apiType = (settings.extractionApiType || "gemini").trim().toLowerCase();
  const apiKey = (settings.extractionApiKey || settings.geminiApiKey || "").trim();
  let defaultBase = GEMINI_API_BASE;
  if (apiType === "openai") defaultBase = OPENAI_API_BASE;
  else if (apiType === "vertex") defaultBase = VERTEX_BASE;
  return {
    apiType,
    apiKey,
    model: (modelOverride || settings.extractionModel || DEFAULT_TEXT_MODEL).trim(),
    apiBase: (settings.extractionApiUrl || defaultBase).trim(),
  };
}

async function generateText(settings, { prompt, model, temperature = 0.1, maxOutputTokens = 1024, responseMimeType, safetySettings } = {}) {
  const cfg = textGenerationConfig(settings, model);
  if (!cfg.apiKey) throw new Error(`generateText: ${cfg.apiType} API key is missing`);

  if (cfg.apiType === "openai") {
    // Honor responseMimeType on OpenAI too. Gemini reads it directly via
    // generationConfig.responseMimeType; the OpenAI Chat Completions
    // analogue is `response_format: { type: "json_object" }`. Without
    // this, OpenAI-route extraction relied on parseResponse's fenced/
    // first-{ fallbacks for every call. We only forward when the caller
    // asked for JSON — plain-text callers (situating blurb) keep the
    // default text mode so the model isn't forced into JSON shape.
    const wantsJson = responseMimeType === "application/json";
    const body = {
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxOutputTokens,
    };
    if (wantsJson) body.response_format = { type: "json_object" };
    const data = await withExponentialBackoff(async () => {
      const res = await fetch(`${cfg.apiBase}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = await res.text();
        const err = new Error(`OpenAI-compatible generation error ${res.status}: ${body}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
    const choice = data.choices?.[0] || {};
    return {
      text: choice.message?.content || "",
      finishReason: choice.finish_reason || null,
    };
  }

  const auth = googleAuth(cfg.apiType, cfg.apiKey);
  const generationConfig = { temperature, maxOutputTokens };
  if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };
  if (Array.isArray(safetySettings) && safetySettings.length > 0) {
    body.safetySettings = safetySettings;
  }

  const data = await withExponentialBackoff(async () => {
    const res = await fetch(`${cfg.apiBase}/models/${cfg.model}:generateContent${auth.query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth.headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const respBody = await res.text();
      const err = new Error(`${cfg.apiType} generation error ${res.status}: ${respBody}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
  const candidate = data.candidates?.[0] || {};
  return {
    text: candidate.content?.parts?.[0]?.text || "",
    finishReason: candidate.finishReason || null,
  };
}

// Resolves the embedding provider config from settings with full backward
// compat. Settings precedence:
//   1. embeddingApiType — explicit "gemini" | "openai" | "vertex" (default "gemini")
//   2. embeddingApiKey / embeddingApiUrl / embeddingModel / embeddingDimension
//      — generic names, take precedence if set
//   3. geminiApiKey / geminiEmbeddingModel / geminiEmbeddingApiUrl /
//      geminiEmbeddingDimension — legacy gemini-prefixed names, used as
//      fallback when the generic ones aren't set
//
// The default model and base URL key off apiType so a user who flips just
// the dropdown to a new provider gets sensible defaults (OpenAI's
// text-embedding-3-small + api.openai.com; Vertex's text-embedding-004 +
// aiplatform.googleapis.com/v1/publishers/google).
function embeddingConfig(settings) {
  const apiType = (settings.embeddingApiType || "gemini").trim().toLowerCase();
  const dimension =
    settings.embeddingDimension ||
    settings.geminiEmbeddingDimension ||
    768;
  const apiKey =
    (settings.embeddingApiKey || settings.geminiApiKey || "").trim();
  if (apiType === "openai") {
    return {
      apiType: "openai",
      apiKey,
      dimension,
      model: (settings.embeddingModel || "text-embedding-3-small").trim(),
      apiBase: (settings.embeddingApiUrl || OPENAI_EMBED_BASE).trim(),
    };
  }
  if (apiType === "vertex") {
    return {
      apiType: "vertex",
      apiKey,
      dimension,
      // text-embedding-004 is Vertex's current default 768-dim model and
      // honors the `outputDimensionality` parameter under `parameters`,
      // so a default install hits the schema without user intervention.
      model: (settings.embeddingModel || settings.geminiEmbeddingModel ||
        "text-embedding-004").trim(),
      apiBase: (settings.embeddingApiUrl || settings.geminiEmbeddingApiUrl ||
        VERTEX_BASE).trim(),
    };
  }
  return {
    apiType: "gemini",
    apiKey,
    dimension,
    model:
      (settings.embeddingModel || settings.geminiEmbeddingModel ||
        "gemini-embedding-2-preview").trim(),
    apiBase:
      (settings.embeddingApiUrl || settings.geminiEmbeddingApiUrl ||
        GEMINI_EMBED_BASE).trim(),
  };
}

// Gemini's batchEmbedContents accepts up to 100 inputs per call. OpenAI's
// /embeddings endpoint accepts up to 2048 inputs per request, but 100 is
// also fine there — keeping the cap unified means the same ingest loop
// produces the same wall-time profile across providers.
const EMBED_BATCH_CAP = 100;

async function embedBatch(settings, texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const cfg = embeddingConfig(settings);
  if (!cfg.apiKey) throw new Error(`embedBatch: ${cfg.apiType} embedding API key is missing`);

  const totalChars = texts.reduce((a, t) => a + (t?.length || 0), 0);
  return trackLlm(
    {
      purpose: "embed-batch",
      provider: cfg.apiType,
      model: cfg.model,
      promptPreview: `[${texts.length} texts, ${totalChars} chars total]`,
      inputSize: totalChars,
      formatResult: (vecs) => `[${vecs.length} vectors, ${cfg.dimension}-dim]`,
    },
    async () => {
      const out = new Array(texts.length);
      for (let start = 0; start < texts.length; start += EMBED_BATCH_CAP) {
        const slice = texts.slice(start, start + EMBED_BATCH_CAP);
        let vecs;
        if (cfg.apiType === "openai") vecs = await openaiEmbedBatch(cfg, slice);
        else if (cfg.apiType === "vertex") vecs = await vertexEmbedBatch(cfg, slice);
        else vecs = await geminiEmbedBatch(cfg, slice);
        if (vecs.length !== slice.length) {
          throw new Error(`${cfg.apiType} embedBatch returned ${vecs.length} vectors for ${slice.length} inputs`);
        }
        for (let i = 0; i < vecs.length; i++) {
          out[start + i] = vecs[i];
        }
      }
      return out;
    },
  );
}

async function geminiEmbedBatch(cfg, slice) {
  // Each sub-request MUST include the model field per Gemini spec. The
  // model string needs the "models/" prefix when nested; the outer path
  // already uses ":batchEmbedContents" on the top-level model.
  const requests = slice.map((text) => ({
    model: `models/${cfg.model}`,
    content: { parts: [{ text }] },
    taskType: "SEMANTIC_SIMILARITY",
    outputDimensionality: cfg.dimension,
  }));

  const data = await withExponentialBackoff(async () => {
    const res = await fetch(`${cfg.apiBase}/models/${cfg.model}:batchEmbedContents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
      body: JSON.stringify({ requests }),
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Gemini batchEmbed error ${res.status}: ${body}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
  return (data.embeddings || []).map((e) => e.values);
}

async function openaiEmbedBatch(cfg, slice) {
  // OpenAI-compatible /embeddings accepts an `input` array. The `dimensions`
  // field is supported by OpenAI's text-embedding-3-* and silently ignored
  // by everyone else. Passing it ensures the response matches the schema's
  // 768-dim columns when the user picks an OpenAI 3.x model.
  const data = await withExponentialBackoff(async () => {
    const res = await fetch(`${cfg.apiBase}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        input: slice,
        dimensions: cfg.dimension,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`OpenAI embeddings error ${res.status}: ${body}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
  // OpenAI returns data: [{embedding: [...], index: 0}, ...]. The order
  // is documented to match the input order, but we sort by index defensively.
  const items = (data.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  return items.map((it) => {
    if (it.embedding && it.embedding.length !== cfg.dimension) {
      throw new Error(
        `OpenAI embeddings returned ${it.embedding.length}-dim vector but the schema requires ${cfg.dimension}. ` +
        `Pick a model that produces ${cfg.dimension}-dim output, or one that supports the dimensions parameter (OpenAI's text-embedding-3-small / text-embedding-3-large do).`,
      );
    }
    return it.embedding;
  });
}

// Vertex AI embeddings use a :predict endpoint with a different request/
// response shape than Gemini's :batchEmbedContents. One :predict call takes
// multiple instances, so the ingest loop batches into this function at the
// same EMBED_BATCH_CAP (100) — safely under Vertex's per-request limits
// across the text-embedding-* family. `task_type` is snake_case in Vertex's
// :predict text-embeddings shape; `outputDimensionality` under `parameters`
// is honored by text-embedding-004 / 005 for native truncation to 768.
async function vertexEmbedBatch(cfg, slice) {
  const body = {
    instances: slice.map((text) => ({
      task_type: "SEMANTIC_SIMILARITY",
      content: text,
    })),
    parameters: { outputDimensionality: cfg.dimension },
  };

  const data = await withExponentialBackoff(async () => {
    const res = await fetch(
      `${cfg.apiBase}/models/${cfg.model}:predict?key=${encodeURIComponent(cfg.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const respBody = await res.text();
      const err = new Error(`Vertex embed error ${res.status}: ${respBody}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });

  // Vertex returns predictions: [{embeddings: {values: [...], statistics: {...}}}, ...]
  // in the same order as instances. Defensive on the values vs embeddings
  // shape because a couple of multimodal variants return `embeddings` as
  // the array directly rather than nested under `.values`.
  const preds = data.predictions || [];
  return preds.map((p) => {
    const values = p.embeddings?.values || p.embeddings;
    if (!Array.isArray(values)) {
      throw new Error(
        `Vertex embed: prediction missing embeddings.values (got ${JSON.stringify(p).slice(0, 120)})`,
      );
    }
    // Mirror openaiEmbedBatch's defensive dim check. Without this, a user
    // who picks a non-768-dim model (e.g. multimodalembedding@001 at 1408)
    // would hit an opaque pgvector dimension error on insert instead of a
    // readable message pointing at the model choice.
    if (values.length !== cfg.dimension) {
      throw new Error(
        `Vertex embeddings returned ${values.length}-dim vector but the schema requires ${cfg.dimension}. ` +
        `Pick a model that produces ${cfg.dimension}-dim output — text-embedding-004 / 005 default to 768 and honor outputDimensionality.`,
      );
    }
    return values;
  });
}

// Singular embed entry point. Used by retrieval (per-query embed) and
// lorebook ingest (per-entry embed). Branches on api type the same way
// embedBatch does.
async function embed(settings, text) {
  const cfg = embeddingConfig(settings);
  if (!cfg.apiKey) throw new Error(`embed: ${cfg.apiType} embedding API key is missing`);
  // openai/vertex paths delegate to embedBatch's sub-functions, which don't
  // emit their own monitor records, so embed() is the right wrap point for
  // the single-text case to avoid double-counting against embedBatch.
  return trackLlm(
    {
      purpose: "embed",
      provider: cfg.apiType,
      model: cfg.model,
      promptPreview: typeof text === "string" ? text.slice(0, 500) : null,
      inputSize: typeof text === "string" ? text.length : null,
      formatResult: (vec) => `[vector, ${Array.isArray(vec) ? vec.length : 0}-dim]`,
    },
    async () => {
      if (cfg.apiType === "openai") {
        const [vec] = await openaiEmbedBatch(cfg, [text]);
        return vec;
      }
      if (cfg.apiType === "vertex") {
        const [vec] = await vertexEmbedBatch(cfg, [text]);
        return vec;
      }
      return withExponentialBackoff(async () => {
        const res = await fetch(`${cfg.apiBase}/models/${cfg.model}:embedContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey },
          body: JSON.stringify({
            content: { parts: [{ text }] },
            taskType: "SEMANTIC_SIMILARITY",
            outputDimensionality: cfg.dimension,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          const err = new Error(`Gemini embed error ${res.status}: ${body}`);
          err.status = res.status;
          throw err;
        }
        const data = await res.json();
        return data.embedding.values;
      });
    },
  );
}

// Path 3: tiny trait-pair verifier. Called by db.upsertTrait when a candidate
// lands in the 0.80-0.88 cosine band against an existing canonical. Returns
// exactly one of "MERGE" / "KEEP_DISTINCT" / "REJECT_NEW"; anything else throws
// and the caller falls through to NEW_CANONICAL.
async function verifyTraitPair(settings, args) {
  const {
    characterName,
    category,
    candidateContent,
    candidateEvidence,
    existingContent,
    existingEvidence,
    cosine,
  } = args || {};

  const model = (settings.verifierModel || settings.extractionModel || DEFAULT_TEXT_MODEL).trim();
  const cfg = textGenerationConfig(settings, model);

  const cosStr = (typeof cosine === "number" ? cosine : 0).toFixed(3);
  const prompt = `You are deduplicating character trait facts for a story-memory database.

Character: ${characterName}
Category: ${category}

Candidate trait: "${candidateContent}"
Candidate evidence: ${candidateEvidence || "(none)"}

Existing canonical trait: "${existingContent}"
Existing evidence: ${existingEvidence || "(none)"}

They scored ${cosStr} cosine similarity — close but not identical.

Decide whether the candidate:
  MERGE        — same disposition as existing, just phrased differently. Collapse them.
  KEEP_DISTINCT — both are valid dispositional traits but they capture different things.
  REJECT_NEW   — the candidate is redundant noise, transient emotion, or a worse phrasing of the existing trait; drop it.

Rules:
- Prefer MERGE when one wording is clearly a paraphrase of the other.
- Prefer KEEP_DISTINCT when both add distinct information about the character.
- Prefer REJECT_NEW when the candidate is vaguer, shorter, or a transient feeling that should not be a persistent trait.
- Answer with EXACTLY one token: MERGE, KEEP_DISTINCT, or REJECT_NEW. No preamble, no punctuation, no explanation.

Answer:`;

  return trackLlm(
    { purpose: "verify-trait", provider: cfg.apiType, model: cfg.model, promptPreview: prompt, inputSize: prompt.length },
    async () => {
      // 32 rather than 8: Gemini 2.5 models sometimes consume output tokens
      // on internal thinking before emitting visible text, and a prior bug
      // silently zeroed out the eval judge with a tight cap. 32 is still tiny
      // and gives room for "Answer: MERGE" or similar incidental preamble.
      const { text } = await generateText(settings, {
        prompt,
        model: cfg.model,
        temperature: 0.0,
        maxOutputTokens: 32,
      });
      // Tolerant parse: the three valid tokens are disjoint substrings, so
      // check longest-first. Handles "Answer: MERGE", "**MERGE**", "MERGE.",
      // etc. without falling through to KEEP_DISTINCT on incidental preamble.
      const up = text.toUpperCase();
      if (up.includes("KEEP_DISTINCT")) return "KEEP_DISTINCT";
      if (up.includes("REJECT_NEW")) return "REJECT_NEW";
      if (up.includes("MERGE")) return "MERGE";
      throw new Error(`verifyTraitPair: unexpected response "${(text || "").slice(0, 40)}"`);
    },
  );
}

async function generateSituatingBlurb(settings, { chatTitle, surroundingContext, message }) {
  // contextModel is legacy — the UI now surfaces a single model. Fall back
  // through contextModel (if user had it set) → extractionModel → hardcoded.
  const model = (settings.contextModel || settings.extractionModel || DEFAULT_TEXT_MODEL).trim();
  const cfg = textGenerationConfig(settings, model);

  const prompt = `You are situating a passage from a roleplay chat for a search index.
Given the chat title, surrounding context, and the target passage, write 1-2 short sentences placing this passage in the larger story: who is involved, where, and what is happening at this moment. No preamble, no quotes around the answer, no markdown — just the sentences.

Chat: ${chatTitle || "(untitled)"}

Surrounding context:
${(surroundingContext || "").slice(0, 4000)}

Target passage:
${(message || "").slice(0, 3000)}

Situating sentences:`;

  return trackLlm(
    { purpose: "situating-blurb", provider: cfg.apiType, model: cfg.model, promptPreview: prompt, inputSize: prompt.length },
    async () => {
      const { text } = await generateText(settings, {
        prompt,
        model: cfg.model,
        temperature: 0.1,
        maxOutputTokens: 200,
      });
      return (text || "").trim();
    },
  );
}

// Path 4: one-shot LLM arc naming. Called by arc-builder.js once per
// surviving community after Louvain + modularity/density gating. Returns a
// short title + 1-sentence description derived from the spine event and the
// first ~12 members in chronological order. Throws on any failure so the
// caller can fall back to the templated title.
async function nameStoryArc(settings, args) {
  const {
    characterName,
    spineEventSummary,
    memberEvents,
    importance,
    kind, // "arc" (default) | "super arc" | "episode" — Path 5 hierarchy
  } = args || {};

  // arcNamingModel overrides extractionModel if set; Flash Lite is cheap and
  // plenty for a 3-7 word naming task.
  const model = (settings.arcNamingModel || settings.extractionModel || DEFAULT_TEXT_MODEL).trim();
  const cfg = textGenerationConfig(settings, model);

  // Path 5: pick the level-appropriate naming idiom. Super-arcs span the
  // most events and want broad, story-arc-of-arcs titles; episodes are
  // the finest grain and want scene-specific titles. Arcs are unchanged.
  const safeKind = kind === "super arc" || kind === "episode" ? kind : "arc";
  const kindLabel =
    safeKind === "arc"
      ? "narrative arc"
      : safeKind === "super arc"
        ? "narrative super-arc (a chat-scale beat that spans multiple smaller arcs)"
        : "narrative episode (a single scene or short sequence inside a larger arc)";
  const importanceLabel =
    safeKind === "arc" ? "Arc" : safeKind === "super arc" ? "Super-arc" : "Episode";
  const noSuffixRule =
    safeKind === "super arc"
      ? "no 'Super Arc' or 'Arc' suffix"
      : safeKind === "episode"
        ? "no 'Episode' or 'Arc' suffix"
        : "no 'Arc' suffix";
  const descWordCap = safeKind === "super arc" ? 35 : 30;

  if (!Array.isArray(memberEvents) || memberEvents.length === 0) {
    throw new Error("nameStoryArc: memberEvents must be non-empty");
  }

  // Truncate the member list to 12. For a 40-event cluster, showing all of
  // them blows up tokens and doesn't help the LLM pick a name — the first 12
  // chronologically give it the setup + early beats, which is enough to
  // extrapolate what the arc is "about". The spine event is always among the
  // members passed in from the caller.
  const MAX_MEMBERS_IN_PROMPT = 12;
  const trimmedMembers = memberEvents.slice(0, MAX_MEMBERS_IN_PROMPT);

  // Truncate each member summary to 200 chars so total prompt input stays
  // ≤~3k chars even with 12 members.
  const MAX_SUMMARY_CHARS = 200;
  const spineId =
    typeof spineEventSummary === "string" && spineEventSummary.trim().length > 0
      ? spineEventSummary.trim().slice(0, MAX_SUMMARY_CHARS)
      : null;
  const memberLines = trimmedMembers.map((m, i) => {
    const sum = (m.summary || "").trim().slice(0, MAX_SUMMARY_CHARS);
    const tag = spineId && sum === spineId ? "   ← spine event" : "";
    return `${i + 1}. [turn ${m.messageIndex ?? "?"}] ${sum}${tag}`;
  });
  // Fallback: if none of the members matched the spine string exactly (can
  // happen when the spine was also truncated to 200 chars), annotate whichever
  // member is the spine by matching messageIndex if possible — but since the
  // caller passes members in chronological order including the spine, and the
  // prompt spec says "1. ...   ← spine event" only if it happens to be
  // chronologically first, it's fine to leave unmarked otherwise.

  const safeImportance =
    typeof importance === "number" && Number.isFinite(importance)
      ? Math.max(1, Math.min(5, Math.round(importance)))
      : 3;

  const safeCharacter =
    typeof characterName === "string" && characterName.trim().length > 0
      ? characterName.trim()
      : "the protagonist";

  const prompt = `You are naming a ${kindLabel} inferred from a roleplay chat.

Protagonist: ${safeCharacter}
${importanceLabel} importance: ${safeImportance}/5

The ${safeKind} groups these events in chronological order:
${memberLines.join("\n")}

Produce:
- A concise ${safeKind} title (3-7 words, no quotes, ${noSuffixRule}, no articles)
- A one-sentence description (≤${descWordCap} words) of what this ${safeKind} is about

Respond with strict JSON, no preamble, no markdown fence:
{"title": "...", "description": "..."}`;

  return trackLlm(
    {
      purpose: `name-${safeKind === "super arc" ? "super-arc" : safeKind}`,
      provider: cfg.apiType,
      model: cfg.model,
      promptPreview: prompt,
      inputSize: prompt.length,
    },
    async () => {
      // 512 rather than 60: Gemini 2.5 models sometimes consume output
      // tokens on internal thinking before emitting visible text. Same
      // lesson as Path 3's verifyTraitPair headroom bump. 150 and 256
      // both truncated real-data responses mid-field on the Protagonist
      // smoke test; 512 gives enough headroom to never re-hit that.
      const { text = "" } = await generateText(settings, {
        prompt,
        model: cfg.model,
        temperature: 0.2,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      });
      let title = "";
      let description = "";
      try {
        const parsed = JSON.parse(text);
        title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
        description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
      } catch {
        // Tolerate stray markdown fence despite responseMimeType.
        try {
          const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
          const parsed = JSON.parse(stripped);
          title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
          description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
        } catch {
          // Truncated JSON — best-effort extract via regex so we don't lose
          // the whole arc to a mid-field cutoff. Gemini occasionally hits the
          // maxOutputTokens cap even after the bump; taking whatever title we
          // got beats falling through to the generic template.
          const titleMatch = text.match(/"title"\s*:\s*"([^"]*)"/);
          const descMatch = text.match(/"description"\s*:\s*"([^"]*)"/);
          if (titleMatch) title = titleMatch[1].trim();
          if (descMatch) description = descMatch[1].trim();
        }
      }
      if (!title) throw new Error(`nameStoryArc: could not extract title from "${text.slice(0, 80)}"`);
      if (!description) description = ""; // title-only is acceptable; arc still gets a real name
      return { title, description };
    },
  );
}

const CHUNK_CHAR_TARGET = 2000;
const CHUNK_CHAR_OVERLAP = 400;

function chunkText(text) {
  if (!text || text.length <= CHUNK_CHAR_TARGET) return [text || ""];
  const stride = CHUNK_CHAR_TARGET - CHUNK_CHAR_OVERLAP;
  const chunks = [];
  for (let start = 0; start < text.length; start += stride) {
    const end = Math.min(start + CHUNK_CHAR_TARGET, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
  }
  return chunks;
}

function extractDialogueQuotes(text) {
  if (!text) return [];
  const out = [];
  // Curly + straight double quotes; require at least 4 chars to skip "...", "?", etc.
  const re = /[\"\u201C]([^\"\u201C\u201D\n]{4,400})[\"\u201D]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const q = m[1].trim();
    if (q.length >= 4) out.push(q);
  }
  return out;
}

// Single source of truth for writing an extraction JSON blob into the graph.
// Callers were triplicated across /extract, /ingest-chat, and ingest-standalone;
// the standalone variant was the reference implementation and this helper is
// a direct port.
//
// Ordering is load-bearing: characters must exist before relationships or
// traits can FK to them; events must exist before arcs/chains reference their
// keys; world_state keys must be written before the context_snapshot packs a
// snapshot of them; plot_threads and present_at run last because they both
// re-upsert characters as a side effect of their own involved_chars lists.
async function applyExtractionToGraph(settings, { extraction, chatId, charName, userName, messageIndex, batchSize }) {
  if (!extraction) return;
  const safeChat = chatId || "";
  const msgIdx = messageIndex ?? null;

  // Characters + persistent_traits.
  //
  // The extractor prompt emits two separate buckets per character:
  //   - persistent_traits: dispositional, multi-scene. Feeds the trait table.
  //   - scene_state: momentary moods / reactions. NEVER lands in traits;
  //     rolled into context_snapshot.emotional_tone below if a snapshot
  //     is being emitted this batch.
  //
  // Backward compat: older prompts (and mid-batch drift from the current
  // one) emitted a single `traits` field that mixed both. If we see that
  // field and no `persistent_traits`, treat it as persistent_traits and
  // warn once per character.
  //
  // Collect scene_state across all characters on the first pass so the
  // context_snapshot writer below can consume them without re-walking
  // the characters array.
  const sceneStateFragments = [];
  // Build a map of every character mentioned in this extraction batch to
  // their full set of names+aliases. The trait-attribution guard in
  // upsertTrait uses this to spot evidence sentences that name a SIBLING
  // character but not THIS one — the painter/voyeur leak case. We pass
  // siblingNames per-character into upsertTrait below.
  const allCharNameSets = (extraction.characters || []).map((c) => {
    const names = new Set();
    if (c && typeof c.name === "string" && c.name.trim()) names.add(c.name.trim());
    for (const a of (Array.isArray(c?.aliases) ? c.aliases : [])) {
      if (typeof a === "string" && a.trim()) names.add(a.trim());
    }
    return { primary: c?.name || "", names };
  });
  for (const char of (extraction.characters || [])) {
    let persistentTraits = char.persistent_traits;
    if (!Array.isArray(persistentTraits) || persistentTraits.length === 0) {
      if (Array.isArray(char.traits) && char.traits.length > 0) {
        console.warn(
          `[ChronicleDB] extraction for "${char.name || "(unnamed)"}" used legacy 'traits' field; treating as persistent_traits`,
        );
        persistentTraits = char.traits;
      } else {
        persistentTraits = [];
      }
    }

    // Normalize scene_state entries to plain strings. The LLM may emit
    // either bare strings or objects ({ content } / { state }); accept
    // both shapes so mid-batch drift doesn't drop affect.
    const rawSceneState = Array.isArray(char.scene_state) ? char.scene_state : [];
    const sceneState = rawSceneState
      .map((s) => {
        if (typeof s === "string") return s.trim();
        if (s && typeof s === "object") return (s.content || s.state || s.text || "").toString().trim();
        return "";
      })
      .filter(Boolean);
    if (sceneState.length > 0 && char.name) {
      sceneStateFragments.push(`${char.name}: ${sceneState.join(", ")}`);
    }

    const description = persistentTraits.map((t) => (t && t.content) || "").filter(Boolean).join("; ");
    // Detect the user's persona character: any extracted character whose
    // name (or any alias) matches userName, case-insensitively. Persona
    // characters get an additional global row (chat_id IS NULL,
    // is_persona=TRUE) into which we mirror trait writes — that row
    // accumulates the user's consistent dispositions across every chat
    // they appear in. See db.ensurePersonaCharacter + the UNION branch
    // in getTraitsForCharacters.
    const isUserPersona = isPersonaName(char, userName);
    const charId = await db.upsertCharacter(settings, {
      name: char.name,
      aliases: char.aliases || [],
      description,
      firstSeen: safeChat,
      chatId: safeChat,
      isPersona: isUserPersona,
    });
    let personaCharId = null;
    if (isUserPersona) {
      try {
        personaCharId = await db.ensurePersonaCharacter(settings, {
          name: char.name,
          aliases: char.aliases || [],
          description,
        });
      } catch (err) {
        console.warn(`[ChronicleDB] ensurePersonaCharacter("${char.name}") failed: ${err.message}`);
      }
    }
    if (char.role || char.status || char.significance) {
      const p = db.getPool(settings);
      await p.query(
        `UPDATE characters SET role = COALESCE(NULLIF($2,''),role), status = COALESCE(NULLIF($3,''),status), significance = GREATEST(significance,$4) WHERE id = $1`,
        [charId, char.role || "", char.status || "", char.significance || 3],
      );
    }
    // M6: parallelize the per-character trait upserts. upsertTrait's hot
    // path is fuzzy-match SELECT + embed RPC + kNN SELECT + INSERT per
    // trait — 2-3 s each serialized is 30-45 s for a 15-trait character.
    // Scope is deliberately narrow: only traits WITHIN one character fan
    // out; the outer characters loop stays serial so we don't multiply
    // the LLM-call burst across N characters at once. Note that upsertTrait
    // on the MERGE / NEW_CANONICAL branches invokes recomputeCharacterSummary
    // internally; with N parallel traits on one character we'll recompute
    // the summary up to N times in this burst. That's wasteful-but-correct
    // and is explicitly out of scope for this fix (the review flagged it
    // as a separate medium to debounce). traitVerifyCache writes are
    // single-threaded-Node safe (Map.set is atomic); in the worst case two
    // parallel calls race on the same trait pair and both fire the verifier.
    // Sibling names = every name/alias of every OTHER character in this
    // extraction batch. Used by upsertTrait's attribution guard.
    const selfNames = new Set();
    if (char.name && typeof char.name === "string") selfNames.add(char.name.trim());
    for (const a of (Array.isArray(char.aliases) ? char.aliases : [])) {
      if (typeof a === "string" && a.trim()) selfNames.add(a.trim());
    }
    const siblingNames = [];
    for (const entry of allCharNameSets) {
      if (entry.primary === char.name) continue;
      for (const n of entry.names) if (!selfNames.has(n)) siblingNames.push(n);
    }
    const traitPromises = [];
    for (const trait of persistentTraits) {
      if (trait && trait.content) {
        // Path 1: pass characterName + evidence_sentence so upsertTrait
        // can build a contextual embedding text of the form
        // `${name} is ${content}: ${evidence_sentence}`. When the prompt
        // didn't emit an evidence sentence (older prompts, or the LLM
        // omitted it), upsertTrait falls back to `${name} is ${content}`.
        // sourceMessageIndex pins this trait to the message it came from
        // so /clear-message-extractions can clean it up on swipe.
        traitPromises.push(
          db.upsertTrait(settings, {
            characterId: charId,
            characterName: char.name,
            characterAliases: Array.from(selfNames),
            siblingNames,
            category: trait.category || "personality",
            content: trait.content,
            evidenceSentence: trait.evidence_sentence || "",
            sourceChat: safeChat,
            sourceMessageIndex: msgIdx,
          }),
        );
        // Persona mirror: write the same trait to the global persona row
        // so it surfaces in every future chat the persona appears in.
        // The global row's upsertTrait runs through the same dedup +
        // attribution path; sourceMessageIndex is intentionally NOT
        // forwarded because the global row is not tied to any one chat's
        // message timeline.
        if (personaCharId) {
          traitPromises.push(
            db.upsertTrait(settings, {
              characterId: personaCharId,
              characterName: char.name,
              characterAliases: Array.from(selfNames),
              siblingNames,
              category: trait.category || "personality",
              content: trait.content,
              evidenceSentence: trait.evidence_sentence || "",
              sourceChat: safeChat,
              sourceMessageIndex: null,
            }).catch((err) => {
              console.warn(`[ChronicleDB] persona-mirror upsertTrait("${trait.content}") failed: ${err.message}`);
            }),
          );
        }
      }
    }
    if (traitPromises.length > 0) await Promise.all(traitPromises);
    // Legacy: some older prompts stashed traits as `new_facts`.
    for (const fact of (char.new_facts || [])) {
      await db.upsertTrait(settings, {
        characterId: charId,
        characterName: char.name,
        category: "personality",
        content: fact,
        sourceChat: safeChat,
        sourceMessageIndex: msgIdx,
      });
    }
  }

  // Relationships
  for (const rel of (extraction.relationships || [])) {
    await db.upsertRelationship(settings, {
      from: rel.from,
      to: rel.to,
      sentiment: parseFloat(rel.sentiment) || 0,
      intensity: parseFloat(rel.intensity) || 0.5,
      description: rel.description || rel.evidence || "",
      sessionId: safeChat,
    });
  }

  // Events — build event_key → event_id map so arcs/chains can resolve keys.
  // Also accumulate ids and embedding texts for the post-loop batch embed.
  const eventKeyToId = new Map();
  const insertedEventIds = [];
  const insertedEventTexts = [];
  for (const event of (extraction.events || [])) {
    const eventId = await db.upsertEvent(settings, {
      summary: event.summary,
      sourceText: event.source_quote,
      participants: event.participants,
      location: event.location,
      significance: event.significance,
      messageIndex: msgIdx,
      sessionId: safeChat,
      worldTime: event.world_time,
    });
    if (event.event_key) eventKeyToId.set(event.event_key, eventId);
    insertedEventIds.push(eventId);
    const text = (event.source_quote || "").trim()
      ? `${event.summary}\n\n${event.source_quote}`
      : (event.summary || "");
    insertedEventTexts.push(text.slice(0, 8000));
  }

  // Populate events.embedding in a single batch call so arc-builder's
  // cosine term has real signal on freshly-ingested rows. Without this
  // the events.embedding column stays NULL and the 5-signal weighted
  // graph degenerates into a near-complete topology (Path 1 smoke test
  // caught exactly that failure — 3 arcs at Q=0.076). Failures are
  // swallowed: event writes must not abort on an embed hiccup.
  //
  // M5: the UPDATEs used to fire one round-trip per event. An 80-event
  // extraction batch ate 80 serial UPDATE statements. Collapse to a
  // single UNNEST-driven UPDATE that joins on (id, emb) pairs built from
  // two parallel arrays.
  if (insertedEventIds.length > 0) {
    try {
      const vecs = await embedBatch(settings, insertedEventTexts);
      const idArr = [];
      const embArr = [];
      for (let i = 0; i < insertedEventIds.length; i++) {
        if (!vecs[i]) continue;
        idArr.push(insertedEventIds[i]);
        embArr.push(JSON.stringify(vecs[i]));
      }
      if (idArr.length > 0) {
        const p = db.getPool(settings);
        await p.query(
          `UPDATE events AS e
           SET embedding = v.emb::vector
           FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS emb) AS v
           WHERE e.id = v.id`,
          [idArr, embArr],
        );
      }
    } catch (err) {
      console.warn(`[ChronicleDB] event embedding at ingest failed: ${err.message}`);
    }
  }

  // Event chains — only link when both endpoints were actually extracted
  // in this same batch (the extractor sometimes references a key from a
  // prior batch which we can't resolve here).
  for (const chain of (extraction.event_chains || [])) {
    const fromId = eventKeyToId.get(chain.from);
    const toId = eventKeyToId.get(chain.to);
    if (fromId && toId) {
      await db.createEventChain(settings, {
        fromEventId: fromId,
        toEventId: toId,
        chainType: chain.chain_type || "caused",
        description: chain.description || "",
      });
    }
  }

  // AGARS location adjacency. Each transition is an undirected edge
  // between two named locations the extractor saw characters move between
  // in this batch. upsertLocationAdjacency is idempotent (content-id-keyed
  // on the lex-sorted pair) so re-ingesting a chat is a no-op on these
  // rows. The event anchor is a rough pointer at this batch's first event
  // — the extractor doesn't attach transitions to specific events, so we
  // don't have a per-transition spine; the anchor is an optional
  // breadcrumb, not a load-bearing join key. Failures are swallowed so a
  // bad transition doesn't abort the rest of the extraction.
  const spineEventId = insertedEventIds[0] || null;
  for (const t of (extraction.location_transitions || [])) {
    if (!t || !t.from || !t.to) continue;
    try {
      await db.upsertLocationAdjacency(settings, {
        chatId: safeChat,
        fromName: t.from,
        toName: t.to,
        eventId: spineEventId,
      });
    } catch (err) {
      console.warn(`[ChronicleDB] location_adjacency upsert failed: ${err.message}`);
    }
  }

  // Path 1: arcs are built structurally post-ingest by arc-builder.rebuildArcsForChat.
  // The LLM no longer emits story_arcs; if a legacy response still includes the field
  // it is intentionally ignored here. See RESEARCH_ARCS.md §5 Path 1.

  // World state — written before the context snapshot snapshots them.
  // sourceMessageIndex is recorded so closeStaleSnapshotKeys can TTL out
  // snapshot-shaped state (boarding, weather, ship motion, etc.) that
  // the extractor has stopped re-emitting.
  for (const ws of (extraction.world_state || [])) {
    await db.upsertWorldState(settings, {
      ...ws,
      chatId: safeChat,
      sourceMessageIndex: msgIdx ?? null,
    });
  }
  // Honor explicit "this fact has stopped being true" markers from the
  // extractor. The LLM emits the exact key (matching one of the keys in
  // the "Current world state" hint list) and we close it.
  if (Array.isArray(extraction.world_state_supersede) && safeChat) {
    await db.supersedeWorldStateKeys(settings, {
      keys: extraction.world_state_supersede,
      chatId: safeChat,
    }).catch(() => {});
  }
  // TTL sweep for snapshot-shaped keys (boarding, weather, ship motion,
  // etc.) that the extractor has stopped re-emitting for more than a few
  // turns. This is the safety net for batches where the LLM forgets to
  // populate world_state_supersede when a scene ends. Runs after the new
  // writes above so a key that just got re-emitted in this batch is
  // considered fresh.
  if (safeChat && msgIdx != null) {
    await db.closeStaleSnapshotKeys(settings, {
      chatId: safeChat,
      currentMessageIndex: msgIdx,
    }).catch(() => {});
  }

  // Knowledge updates: `learned` → fact row scoped to the learner.
  // `does_not_know` is intentionally implicit — absence of a KNOWS edge
  // is the signal, so nothing to write here.
  for (const ku of (extraction.knowledge_updates || [])) {
    if (ku.learned) {
      await db.upsertFact(settings, {
        content: ku.learned,
        domain: "knowledge",
        confidence: 0.9,
        characterScope: [ku.character],
        chatId: safeChat,
      });
    }
  }

  // Items — written off the critical path; a bad item row shouldn't abort
  // the rest of the extraction.
  for (const item of (extraction.items || [])) {
    await db.upsertItem(settings, {
      name: item.name,
      description: item.description,
      powers: item.powers,
      significance: item.significance,
      owner: item.owner,
      location: item.location,
      status: item.status,
      chatId: safeChat,
    }).catch(() => {});
  }

  // Location detail updates — enrich the location rows the extractor
  // mentioned. Separate from upsertLocation inside upsertItem/present_at
  // which only writes name.
  for (const loc of (extraction.locations_detail || [])) {
    if (!loc?.name) continue;
    const locId = await db.upsertLocation(settings, loc.name, loc.description || "");
    const p = db.getPool(settings);
    await p.query(
      `UPDATE locations SET importance = GREATEST(importance, $2), current_state = $3 WHERE id = $1`,
      [locId, loc.importance || 3, loc.current_state || ""],
    ).catch(() => {});
  }

  // Context snapshot + present_at. The retriever's "Current Scene" section
  // reads present_at, so without these writes that section is always empty.
  //
  // scene_state from the characters pass is folded into emotional_tone here
  // — but ONLY when a context_snapshot is actually being emitted for this
  // batch. If the extractor didn't emit a snapshot, scene_state is dropped
  // (the research report explicitly says not to invent a new table for it).
  if (extraction.context_snapshot) {
    const snap = extraction.context_snapshot;
    const wsSnap = {};
    for (const ws of (extraction.world_state || [])) wsSnap[ws.key] = ws.value;
    const baseTone = (snap.emotional_tone || "").toString().trim();
    const sceneStateTone = sceneStateFragments.join("; ");
    const mergedTone = [baseTone, sceneStateTone].filter(Boolean).join(" | ");
    await db.insertContextSnapshot(settings, {
      chatId: safeChat,
      messageIndex: msgIdx ?? 0,
      summary: snap.summary || "",
      locationName: snap.location || null,
      presentChars: snap.present_characters || [],
      emotionalTone: mergedTone,
      worldStateSnapshot: wsSnap,
    });

    if (snap.location && snap.present_characters?.length > 0) {
      const locationId = await db.upsertLocation(settings, snap.location, "");
      const p = db.getPool(settings);
      // Resolve every present-character to its (possibly chat-scoped) id
      // first, then use the resolved set to clear+insert presence. Cannot
      // pre-compute via slugify any more — chat-scoped rows have a hashed
      // prefix that slugify alone doesn't produce.
      const resolvedCharIds = [];
      for (const presentName of snap.present_characters) {
        resolvedCharIds.push(
          await db.upsertCharacter(settings, { name: presentName, chatId: safeChat }),
        );
      }
      // Only clear presence within THIS chat so a character present in
      // chat A doesn't get kicked out of their location in chat B when
      // chat A's extraction fires.
      await p.query(
        `UPDATE present_at SET is_current = FALSE
         WHERE character_id = ANY($1::text[]) AND chat_id = $2`,
        [resolvedCharIds, safeChat],
      ).catch(() => {});
      for (const pCharId of resolvedCharIds) {
        await p.query(
          `INSERT INTO present_at (character_id, location_id, is_current, chat_id) VALUES ($1, $2, TRUE, $3)`,
          [pCharId, locationId, safeChat],
        ).catch(() => {});
      }
    }
  }

  // Plot threads — last, because they re-upsert any involved_chars as a
  // side effect and we want the earlier role/significance updates to win.
  for (const pt of (extraction.plot_threads || [])) {
    await db.upsertPlotThread(settings, {
      chatId: safeChat,
      title: pt.title,
      description: pt.description || "",
      threadType: pt.type || "pending",
      involvedChars: pt.involved_characters || [],
      plantedAt: msgIdx,
      resolvedAt: pt.type === "resolved" ? msgIdx : null,
      importance: pt.importance || 3,
    });
  }

  // Resolve threads the LLM marked as closed by stable id. This is the
  // declarative resolution path — it lands on the original row instead of
  // spawning a new one when the title would have been reworded.
  for (const rawId of (extraction.resolves_thread_ids || [])) {
    const id = (rawId || "").toString().trim();
    if (!id) continue;
    const ok = await db.resolvePlotThread(settings, { id, chatId: safeChat, resolvedAt: msgIdx });
    if (!ok) {
      console.warn(`[ChronicleDB] resolves_thread_ids: no active thread matched id=${id} in chat=${safeChat}`);
    }
  }

  // Contradictions — log only; there's no table for these and the extractor
  // is the only thing that notices them.
  for (const c of (extraction.contradictions || [])) {
    if (c) console.warn(`[ChronicleDB] Contradiction detected: ${c}`);
  }
}

// Single source of truth for chunk → situating blurb → embed → dialogue quote
// on a batch of messages. Ports the rich path from ingest-standalone so
// live /extract and /ingest-chat get chunking/blurbs/quotes that they were
// missing.
//
// Two coordinate systems are in play here:
// - `messages` is whatever context you have for surrounding-context slicing.
//   In /ingest-chat and ingest-standalone this is the full chat. In live
//   /extract this is just the batch ST handed us after GENERATION_ENDED.
// - `chatBatch` is the slice to actually index. `batchStart` is its position
//   within `messages` (for context slicing).
// - `messageIndexOffset` is added to the per-batch message index when
//   writing to DB so memory_embeddings.message_index stays aligned with the
//   full-chat timeline even when we only have a slice in memory.
async function applyMessagesToVectorStore(settings, { messages, chatBatch, batchStart = 0, messageIndexOffset = 0, chatId, ctxWindow = 4 }) {
  const batch = chatBatch || messages;
  const allMsgs = messages || batch;
  const safeChat = chatId || "";

  // First pass: build the per-message work list (skipping system/trivial
  // messages) and generate situating blurbs. Blurbs have to come first
  // because the embed input is `${blurb}\n\n${chunk}` and we want to
  // batch-embed across messages.
  //
  // H4: generateSituatingBlurb is a Gemini round-trip per message (3-8 s
  // each). The old serial loop ate 30-80 s on a 10-message batch just
  // waiting on blurbs. Split into three phases so the blurb awaits run
  // in parallel without disturbing the non-parallelizable work:
  //   1. Build the per-message records with surroundingContext (pure
  //      function of `batch` / `allMsgs`, no async dependencies).
  //   2. Promise.all the blurb calls — all N round-trips fly in parallel.
  //      Each promise catches its own error to a "" blurb so one failure
  //      doesn't reject the whole batch (mirrors the old try/catch).
  //   3. Chunk each message and push tasks in original message order so
  //      `tasks` and the per-task (messageIndex, chunkIndex) stay
  //      deterministic.
  const records = [];
  for (let mi = 0; mi < batch.length; mi++) {
    const m = batch[mi];
    if (!m || m.is_system) continue;
    const text = `${m.name}: ${m.mes}`;
    if (text.length < 80) continue;

    // Slicing position inside `allMsgs` (for surrounding context).
    const slicePos = batchStart + mi;
    // Absolute position in the full-chat timeline (for DB message_index).
    const messageIndex = messageIndexOffset + mi;
    const before = allMsgs.slice(Math.max(0, slicePos - ctxWindow), slicePos);
    const after = allMsgs.slice(slicePos + 1, slicePos + 1 + ctxWindow);
    const surroundingContext = [...before, ...after]
      .filter((mm) => mm && !mm.is_system)
      .map((mm) => `${mm.name}: ${(mm.mes || "").slice(0, 400)}`)
      .join("\n\n");

    records.push({ m, text, messageIndex, surroundingContext });
  }

  // Phase 2: fire all blurb round-trips in parallel. Errors are caught
  // per-promise so one failure degrades to "" (situating is a
  // nice-to-have; the embed still writes without it) rather than
  // rejecting the whole Promise.all.
  const blurbs = await Promise.all(
    records.map((r) =>
      generateSituatingBlurb(settings, {
        chatTitle: safeChat,
        surroundingContext: r.surroundingContext,
        message: r.text,
      }).catch((err) => {
        console.warn(`[ChronicleDB] msg ${r.messageIndex} situating failed: ${err.message}`);
        return "";
      }),
    ),
  );

  // Phase 3: chunk + push tasks in order, binding each record to its
  // corresponding blurb by index.
  const tasks = [];
  for (let ri = 0; ri < records.length; ri++) {
    const { m, messageIndex } = records[ri];
    const situating = blurbs[ri] || "";
    const chunks = chunkText(m.mes);
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const labeledChunk = `${m.name}: ${chunk}`;
      const embedInput = situating ? `${situating}\n\n${labeledChunk}` : labeledChunk;
      tasks.push({
        messageIndex,
        speaker: m.name,
        chunkIndex: ci,
        chunkCount: chunks.length,
        chunk,
        labeledChunk,
        embedInput,
        situating,
        rawMessage: m.mes,
      });
    }
  }

  // Batch-embed all chunks in a single call (or as few as the 100-cap
  // allows). Fallback to per-item embed only if the batch call fails so
  // a single 400 doesn't lose the whole batch's memories.
  const stats = { embeds: 0, chunks: 0, quotes: 0 };
  if (tasks.length > 0) {
    let vectors = null;
    try {
      vectors = await embedBatch(settings, tasks.map((t) => t.embedInput));
    } catch (err) {
      console.warn(`[ChronicleDB] batch embed failed (${err.message}); falling back to per-item`);
    }

    for (let ti = 0; ti < tasks.length; ti++) {
      const t = tasks[ti];
      let vec = vectors ? vectors[ti] : null;
      if (!vec) {
        try {
          vec = await embed(settings, t.embedInput);
        } catch (err) {
          console.warn(`[ChronicleDB] msg ${t.messageIndex} chunk ${t.chunkIndex} embed failed: ${err.message}`);
          continue;
        }
      }

      try {
        await db.upsertMemoryEmbedding(settings, {
          chatId: safeChat,
          nodeType: t.chunkCount > 1 ? "message_chunk" : "message",
          nodeId: t.chunkCount > 1
            ? `msg-${safeChat}-${t.messageIndex}-c${t.chunkIndex}`
            : `msg-${safeChat}-${t.messageIndex}`,
          content: t.labeledChunk.slice(0, 2000),
          rawText: t.chunk,
          embedding: vec,
          characterScope: [t.speaker],
          messageIndex: t.messageIndex,
          contextPrefix: t.situating || null,
        });
        stats.embeds++;
        if (t.chunkCount > 1) stats.chunks++;
      } catch (err) {
        console.warn(`[ChronicleDB] msg ${t.messageIndex} chunk ${t.chunkIndex} upsert failed: ${err.message}`);
      }
    }
  }

  // Dialogue quotes run independently of the embed pipeline so a vector
  // failure doesn't block quote indexing (trgm is valuable on its own).
  for (let mi = 0; mi < batch.length; mi++) {
    const m = batch[mi];
    if (!m || m.is_system) continue;
    const messageIndex = messageIndexOffset + mi;
    const quotes = extractDialogueQuotes(m.mes);
    for (const q of quotes) {
      try {
        await db.upsertDialogueQuote(settings, {
          chatId: safeChat,
          sessionId: safeChat,
          speaker: m.name,
          quote: q,
          messageIndex,
        });
        stats.quotes++;
      } catch (err) {
        console.warn(`[ChronicleDB] msg ${messageIndex} quote insert failed: ${err.message}`);
      }
    }
  }

  return stats;
}

module.exports = {
  extract,
  embed,
  embedBatch,
  generateSituatingBlurb,
  verifyTraitPair,
  nameStoryArc,
  chunkText,
  extractDialogueQuotes,
  withExponentialBackoff,
  applyExtractionToGraph,
  applyMessagesToVectorStore,
  // Persona-name resolution helpers exported for the route layer to call
  // ONCE per request, so /extract and /ingest-chat can converge on a single
  // resolved userName before invoking extract() + applyExtractionToGraph().
  resolveUserName,
  derivePersonaNameFromMessages,
};
