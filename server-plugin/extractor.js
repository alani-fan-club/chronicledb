/**
 * LLM-based memory extraction for ChronicleDB.
 * Sends RP message batches to a cheap local model, gets structured JSON back.
 */

const EXTRACTION_PROMPT = `You are a narrative analyst for a roleplay memory system. Extract structured information from RP messages.

Each message has a speaker and content. Some are from the user (player), others from AI characters or narrators.

Extract:
1. **Characters** — named characters present or mentioned
2. **Relationships** — how characters feel about each other (sentiment -1.0 to 1.0, intensity 0-1, evidence)
3. **Events** — things that happened, with significance:
   - 5 = defining moment (major plot beat, character revelation, death, transformation)
   - 4 = important development (confrontation, decision, significant reveal)
   - 3 = meaningful action (argument, bonding moment, notable action)
   - 2 = minor beat (small gesture, casual dialogue with impact)
   - 1 = flavor detail (background action, mundane interaction)
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
  "characters": [{ "name": "", "new_facts": [], "role": "protagonist/antagonist/ally/npc/mentor/etc", "status": "active/injured/missing/dead/etc", "significance": 3 }],
  "relationships": [{ "from": "", "to": "", "sentiment": -1.0, "intensity": 0.5, "description": "Rich 2-3 sentence description of the relationship dynamics, emotional undercurrents, and recent developments" }],
  "events": [{ "event_key": "unique_short_key_like_first_meeting", "summary": "", "participants": [], "location": "", "significance": 3 }],
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
    // OpenAI-compatible API (OpenRouter, local, etc.)
    const res = await fetch(`${apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });
    if (!res.ok) throw new Error(`Extraction LLM error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    content = data.choices?.[0]?.message?.content;
  } else {
    // Gemini API
    const res = await fetch(`${apiUrl}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini extraction error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    content = data.candidates?.[0]?.content?.parts?.[0]?.text;
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

module.exports = { extract, embed };
