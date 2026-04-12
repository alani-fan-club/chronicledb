/**
 * LLM-based memory extraction for ChronicleDB.
 * Sends RP message batches to a cheap local model, gets structured JSON back.
 */

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
   - **traits**: innate properties (distinct from learned knowledge). Categories:
     personality, skill, background, physical, faction.

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

  // Retry with exponential backoff for rate limit errors (429) and transient 5xx
  const callWithRetry = async (fn, maxRetries = 4) => {
    let delay = 1000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = err.message || "";
        const isRetriable = msg.includes("429") || msg.includes("503") || msg.includes("500") || msg.includes("RESOURCE_EXHAUSTED");
        if (!isRetriable || attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2; // 1s → 2s → 4s → 8s → 16s
      }
    }
  };

  if (apiType === "openai") {
    content = await callWithRetry(async () => {
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
    content = await callWithRetry(async () => {
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

const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models";

async function embed(settings, text) {
  const model = (settings.geminiEmbeddingModel || "gemini-embedding-2-preview").trim();
  const apiKey = (settings.geminiApiKey || "").trim();
  const dimension = settings.geminiEmbeddingDimension || 768;

  const res = await fetch(`${GEMINI_EMBED_URL}/${model}:embedContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      taskType: "SEMANTIC_SIMILARITY",
      outputDimensionality: dimension,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini embed error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.embedding.values;
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

  let delay = 1000;
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
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
        const retriable = res.status === 429 || res.status === 503 || res.status === 500;
        if (!retriable || attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return (text || "").trim();
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  return "";
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

module.exports = { extract, embed, generateSituatingBlurb, chunkText, extractDialogueQuotes };
