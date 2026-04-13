/**
 * LLM-based memory extraction for ChronicleDB.
 * Sends RP message batches to a cheap local model, gets structured JSON back.
 */

const db = require("./db");

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
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error("withExponentialBackoff: exhausted without result");
}

const EXTRACTION_PROMPT = `You are a narrative analyst for a roleplay memory system. Extract structured information from RP messages.

Each message has a speaker and content. Some are from the user (player), others from AI characters or narrators.

Extract:
1. **Characters** — Extract EVERY named character that appears, no matter how minor.
   This includes: protagonists, antagonists, walk-ons, servers, drivers, guards,
   passersby, characters mentioned in dialogue, characters in flashbacks. If a
   name appears, the character gets a node. Do NOT filter by importance — the
   graph filters at query time, not extraction time.

   For each character, also extract:
   - **aliases**: alternate forms of the name. E.g., "Alex Reynolds" might also be
     called "Protagonist", "Alex", "Al", "Night Captain". List all forms
     you've seen in this passage or know from earlier context.
   - **traits**: **dispositional** properties — things the character IS over
     the long run, not what they're feeling right now. This distinction is
     the most common extraction failure, so read the rules carefully:

     A trait is INNATE, STABLE, and PERSISTENT. It would still be true of
     the character tomorrow, next week, in a completely different scene.
     It is something another character in the story would describe as
     "just who they are".

     **DO NOT emit as traits**:
       * Emotional states or moods (angry, sad, happy, amused, annoyed,
         besotted, aroused, awed, baffled, bemused, charmed, astonished,
         frustrated, afraid, nervous, excited, content, distressed,
         curious at the moment, etc). These belong in
         context_snapshot.emotional_tone, NOT here.
       * Reactions to one scene (annoyed at staff, calm but firm, cold
         conviction, appreciative of the gift). Reactions aren't traits.
       * Situational descriptors that only apply right now (soaked from
         the rain, limping, out of breath).
       * Gerunds / participles describing what they're doing
         (calculating the odds, charming the guard). Use the dispositional
         adjective if the character IS habitually that way.
       * Momentary physical states (aroused, trembling, flushed, crying).
       * Single-scene philosophies dressed up as values ("annihilation
         over submission" — phrase-of-the-moment, not a life-long credo
         unless the narrator literally says so).

     **DO emit as traits**:
       * Persistent personality dispositions: stoic, cunning, protective,
         impulsive, analytical, loyal, jealous (the permanent-disposition
         kind), reserved, charismatic, paranoid, cynical.
       * Long-term skills: knife fighting, leadership, piano, forgery,
         combat proficiency, field medicine.
       * Background facts: former yakuza captain, raised in an orphanage,
         lost left eye in prison, speaks three languages.
       * Persistent physical features: facial marker on the jaw, mismatched
         eyes, tattoo sleeve.
       * Faction / allegiance: Faction family, Hidden Leaf ANBU.

     TRAIT FORMAT RULES:
     * Use the **canonical adjective / noun form**, not the gerund or past
       tense. "charming" (not "charmed" or "charms"), "observant" (not "was
       observant" or "observing"), "resourceful" (not "is resourceful").
     * **Single word when possible**, short phrase only when necessary.
       "stoic" not "generally stoic and reserved".
     * **Do not emit morphological variants** of a trait you've already
       listed. If you're about to write "charmed", check whether you
       already wrote "charming" — if so, drop it.
     * **Lowercase** unless it's a proper noun. "stoic", not "Stoic".
     * **No redundant qualifiers** like "somewhat", "very", "extremely",
       "always" unless they change the meaning.
     * Each trait is **one fact** — don't emit "brave, loyal, and protective"
       as a single trait; that's three separate entries.
     * **Bias STRONGLY toward not emitting.** If you're unsure whether
       something is a trait or a mood, it's a mood — skip it. The trait
       list is user-visible and noise pollutes it. Emit 3-5 very confident
       traits per character per batch rather than 15 maybe-traits.

   Example of permissive extraction:
   A passage mentions "the bartender the bartender set down a drink" — extract the bartender as a
   character even though she has one line. Extract "the doorman the doorman" even if
   he's only named in passing.
2. **Relationships** — how characters feel about each other (sentiment -1.0 to 1.0, intensity 0-1, evidence)
3. **Events** — things that happened, with significance. For each event, also
   capture **source_quote**: the most distinctive 1-2 sentences from the
   passage, copied VERBATIM. Include dialogue if any. This is the actual line
   that justifies the event existing — preserve it exactly so we can quote it
   back later. If no specific quote captures it (pure narration), include the
   single most narratively load-bearing sentence verbatim.
   CRITICAL: major events (4-5) are the load-bearing plot beats — only mark something major if it would appear in a summary of the whole chapter:
   - 5 = defining moment (major plot beat, character revelation, death, transformation, confession, betrayal)
   - 4 = important development (confrontation, decision, significant reveal, first meeting, turning point)
   - 3 = meaningful action (argument, bonding moment, notable action with consequences)
   - 2 = minor beat (small gesture, casual dialogue with some weight)
   - 1 = flavor detail (background action, mundane interaction, transitional scene)
   Be strict about 4-5. In a typical batch you'll have 1-3 major events at most, many minor ones.
4. **Event chains** — when one event directly causes, triggers, or leads to another. Think causally: "X caused Y", "Because of A, B happened". Only chain events that have a clear causal link.
5. **Story arcs** — identify narrative arcs like in manga/anime. An arc is a set of connected events that form a coherent story beat. Examples: "The Betrayal Arc", "First Meeting Arc", "Confession Arc", "Training Arc". Each arc has a defining "spine" event (the most important one) and flavor events around it.
6. **World state** — environmental/setting changes (key-value)
7. **Knowledge updates** — what each character learned AND what they explicitly do not know
8. **Context snapshot** — a summary of the current scene state: who is present, where, emotional tone, what's happening
9. **Plot threads** — foreshadowing, pending events, unresolved tensions, promises, threats. Mark if a prior thread got resolved.

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
    "traits": [
      { "category": "personality | skill | background | physical | faction", "content": "" }
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
    "significance": 3
  }],
  "event_chains": [{ "from": "event_key", "to": "event_key", "chain_type": "caused | triggered | led_to | followed_by", "description": "" }],
  "story_arcs": [{
    "title": "",
    "description": "",
    "arc_type": "main | subplot | character_arc | world_arc",
    "status": "active | resolved | ongoing",
    "importance": 3,
    "spine_event_key": "the defining event_key",
    "event_keys": ["list", "of", "event_keys", "in", "this", "arc"]
  }],
  "world_state": [{ "key": "", "value": "", "reason": "" }],
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
  "contradictions": ["Any detail that contradicts previously established facts, if noticed"]
}`;

async function extract(settings, { characterName, userName, messages }) {
  const msgBlock = messages
    .filter((m) => !m.is_system)
    .map((m) => `[${m.is_user ? "USER" : "CHARACTER"}] ${m.name}: ${m.mes.slice(0, 2000)}`)
    .join("\n\n---\n\n");

  const prompt = `${EXTRACTION_PROMPT}

Context: roleplay between user "${userName}" and character "${characterName}".

Messages:
${msgBlock}

JSON:`;

  const apiType = (settings.extractionApiType || "gemini").trim();
  const apiKey = (settings.extractionApiKey || settings.geminiApiKey || "").trim();
  const model = (settings.extractionModel || "gemini-2.5-flash-lite").trim();
  const apiUrl = (settings.extractionApiUrl || "https://generativelanguage.googleapis.com/v1beta").trim();

  let content;

  if (apiType === "openai") {
    content = await withExponentialBackoff(async () => {
      const res = await fetch(`${apiUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 16384,
        }),
      });
      if (!res.ok) throw new Error(`Extraction LLM error: ${res.status} ${await res.text()}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content;
    });
  } else {
    content = await withExponentialBackoff(async () => {
      const res = await fetch(`${apiUrl}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 65536,
            responseMimeType: "application/json",
          },
        }),
      });
      if (!res.ok) throw new Error(`Gemini extraction error: ${res.status} ${await res.text()}`);
      const data = await res.json();
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason && candidate.finishReason !== "STOP") {
        console.warn(`[ChronicleDB] Finish reason: ${candidate.finishReason}`);
      }
      return candidate?.content?.parts?.[0]?.text;
    });
  }

  if (!content) throw new Error("LLM returned empty response");

  return parseResponse(content);
}

function parseResponse(raw) {
  // Try raw JSON
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  // Try markdown fenced
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
  // Find first { to last }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error("Could not parse extraction response");
}

const GEMINI_EMBED_BASE = "https://generativelanguage.googleapis.com/v1beta";

function embeddingConfig(settings) {
  return {
    model: (settings.geminiEmbeddingModel || "gemini-embedding-2-preview").trim(),
    apiKey: (settings.geminiApiKey || "").trim(),
    dimension: settings.geminiEmbeddingDimension || 768,
    apiBase: (settings.geminiEmbeddingApiUrl || GEMINI_EMBED_BASE).trim(),
  };
}

// Gemini's batchEmbedContents accepts up to 100 inputs per call. Keep batches
// under that; ingest hits this hardest on long chats where per-message
// sequential HTTP dominates ingest wall time.
const EMBED_BATCH_CAP = 100;

async function embedBatch(settings, texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const { model, apiKey, dimension, apiBase } = embeddingConfig(settings);

  const out = new Array(texts.length);
  for (let start = 0; start < texts.length; start += EMBED_BATCH_CAP) {
    const slice = texts.slice(start, start + EMBED_BATCH_CAP);
    // Each sub-request MUST include the model field per Gemini spec. The
    // model string needs the "models/" prefix when nested; the outer path
    // already uses ":batchEmbedContents" on the top-level model.
    const requests = slice.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      taskType: "SEMANTIC_SIMILARITY",
      outputDimensionality: dimension,
    }));

    const data = await withExponentialBackoff(async () => {
      const res = await fetch(`${apiBase}/models/${model}:batchEmbedContents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ requests }),
      });
      if (!res.ok) {
        const body = await res.text();
        // Surface status on the Error so defaultIsRetriable can key off it
        // without regexing the message.
        const err = new Error(`Gemini batchEmbed error ${res.status}: ${body}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });

    const embeddings = data.embeddings || [];
    if (embeddings.length !== slice.length) {
      throw new Error(`Gemini batchEmbed returned ${embeddings.length} vectors for ${slice.length} inputs`);
    }
    for (let i = 0; i < embeddings.length; i++) {
      out[start + i] = embeddings[i].values;
    }
  }
  return out;
}

// Kept on the singular embedContent endpoint (not batch) so retrieval and
// lorebook paths keep their exact prior behavior. Batch is opt-in via
// embedBatch(), which the ingest loops use explicitly.
async function embed(settings, text) {
  const { model, apiKey, dimension, apiBase } = embeddingConfig(settings);
  return withExponentialBackoff(async () => {
    const res = await fetch(`${apiBase}/models/${model}:embedContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "SEMANTIC_SIMILARITY",
        outputDimensionality: dimension,
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
}

async function generateSituatingBlurb(settings, { chatTitle, surroundingContext, message }) {
  const apiKey = (settings.extractionApiKey || settings.geminiApiKey || "").trim();
  // contextModel is legacy — the UI now surfaces a single model. Fall back
  // through contextModel (if user had it set) → extractionModel → hardcoded.
  const model = (settings.contextModel || settings.extractionModel || "gemini-2.5-flash-lite").trim();
  const apiUrl = (settings.extractionApiUrl || "https://generativelanguage.googleapis.com/v1beta").trim();

  const prompt = `You are situating a passage from a roleplay chat for a search index.
Given the chat title, surrounding context, and the target passage, write 1-2 short sentences placing this passage in the larger story: who is involved, where, and what is happening at this moment. No preamble, no quotes around the answer, no markdown — just the sentences.

Chat: ${chatTitle || "(untitled)"}

Surrounding context:
${(surroundingContext || "").slice(0, 4000)}

Target passage:
${(message || "").slice(0, 3000)}

Situating sentences:`;

  return withExponentialBackoff(async () => {
    const res = await fetch(`${apiUrl}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Situating LLM error ${res.status}: ${body}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return (text || "").trim();
  });
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

  // Characters + traits
  for (const char of (extraction.characters || [])) {
    const description = (char.traits || []).map((t) => t.content).join("; ");
    await db.upsertCharacter(settings, {
      name: char.name,
      aliases: char.aliases || [],
      description,
      firstSeen: safeChat,
    });
    const charId = db.slugify(char.name);
    if (char.role || char.status || char.significance) {
      const p = db.getPool(settings);
      await p.query(
        `UPDATE characters SET role = COALESCE(NULLIF($2,''),role), status = COALESCE(NULLIF($3,''),status), significance = GREATEST(significance,$4) WHERE id = $1`,
        [charId, char.role || "", char.status || "", char.significance || 3],
      );
    }
    for (const trait of (char.traits || [])) {
      if (trait.content) {
        await db.upsertTrait(settings, {
          characterId: charId,
          category: trait.category || "personality",
          content: trait.content,
          sourceChat: safeChat,
        });
      }
    }
    // Legacy: some older prompts stashed traits as `new_facts`.
    for (const fact of (char.new_facts || [])) {
      await db.upsertTrait(settings, {
        characterId: charId,
        category: "personality",
        content: fact,
        sourceChat: safeChat,
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
  const eventKeyToId = new Map();
  for (const event of (extraction.events || [])) {
    const eventId = await db.upsertEvent(settings, {
      summary: event.summary,
      sourceText: event.source_quote,
      participants: event.participants,
      location: event.location,
      significance: event.significance,
      messageIndex: msgIdx,
      sessionId: safeChat,
    });
    if (event.event_key) eventKeyToId.set(event.event_key, eventId);
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

  // Story arcs — depend on events existing for FK lookups.
  for (const arc of (extraction.story_arcs || [])) {
    const spineId = arc.spine_event_key ? eventKeyToId.get(arc.spine_event_key) : null;
    const arcId = await db.upsertStoryArc(settings, {
      chatId: safeChat,
      title: arc.title,
      description: arc.description || "",
      arcType: arc.arc_type || "main",
      status: arc.status || "active",
      importance: arc.importance || 3,
      startMsgIdx: msgIdx,
      endMsgIdx: msgIdx != null && batchSize ? msgIdx + batchSize : msgIdx,
      spineEventId: spineId,
    });
    let pos = 0;
    for (const key of (arc.event_keys || [])) {
      const eventId = eventKeyToId.get(key);
      if (eventId) {
        await db.linkEventToArc(settings, {
          arcId,
          eventId,
          position: pos++,
          isAnchor: eventId === spineId,
        });
      }
    }
  }

  // World state — written before the context snapshot snapshots them.
  for (const ws of (extraction.world_state || [])) {
    await db.upsertWorldState(settings, { ...ws, chatId: safeChat });
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
  if (extraction.context_snapshot) {
    const snap = extraction.context_snapshot;
    const wsSnap = {};
    for (const ws of (extraction.world_state || [])) wsSnap[ws.key] = ws.value;
    await db.insertContextSnapshot(settings, {
      chatId: safeChat,
      messageIndex: msgIdx ?? 0,
      summary: snap.summary || "",
      locationName: snap.location || null,
      presentChars: snap.present_characters || [],
      emotionalTone: snap.emotional_tone || "",
      worldStateSnapshot: wsSnap,
    });

    if (snap.location && snap.present_characters?.length > 0) {
      const locationId = await db.upsertLocation(settings, snap.location, "");
      const p = db.getPool(settings);
      const charIds = snap.present_characters.map((n) => db.slugify(n));
      // Only clear presence within THIS chat so a character present in
      // chat A doesn't get kicked out of their location in chat B when
      // chat A's extraction fires.
      await p.query(
        `UPDATE present_at SET is_current = FALSE
         WHERE character_id = ANY($1::text[]) AND chat_id = $2`,
        [charIds, safeChat],
      ).catch(() => {});
      for (const presentName of snap.present_characters) {
        const pCharId = db.slugify(presentName);
        await db.upsertCharacter(settings, { name: presentName });
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
  const tasks = [];
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

    let situating = "";
    try {
      situating = await generateSituatingBlurb(settings, {
        chatTitle: safeChat,
        surroundingContext,
        message: text,
      });
    } catch (err) {
      // Situating is a nice-to-have; one failure must not abort embedding.
      console.warn(`[ChronicleDB] msg ${messageIndex} situating failed: ${err.message}`);
    }

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
  chunkText,
  extractDialogueQuotes,
  withExponentialBackoff,
  applyExtractionToGraph,
  applyMessagesToVectorStore,
};
