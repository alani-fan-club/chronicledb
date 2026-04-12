/**
 * LLM-based memory extraction for ChronicleDB.
 * Sends RP message batches to a cheap local model, gets structured JSON back.
 */

const EXTRACTION_PROMPT = `You are a narrative analyst for a roleplay memory system. Extract structured information from RP messages.

Each message has a speaker and content. Some are from the user (player), others from AI characters or narrators.

Extract:
1. **Characters** — named characters present or mentioned
2. **Relationships** — how characters feel about each other (sentiment -1.0 to 1.0, intensity 0-1, evidence)
3. **Events** — significant things that happened (significance 1-5)
4. **World state** — environmental/setting changes (key-value)
5. **Knowledge updates** — what each character learned AND what they explicitly do not know

RULES:
- Only attribute knowledge to characters who were PRESENT and could perceive it
- Narrator descriptions are omniscient — characters only know what they witnessed or were told
- Track the active message text only, not alternative swipes

Return ONLY valid JSON:
{
  "characters": [{ "name": "", "new_facts": [] }],
  "relationships": [{ "from": "", "to": "", "sentiment": "", "intensity": 0.0, "evidence": "" }],
  "events": [{ "summary": "", "participants": [], "location": "", "significance": 0 }],
  "world_state": [{ "key": "", "value": "", "reason": "" }],
  "knowledge_updates": [
    { "character": "", "learned": "", "source": "" },
    { "character": "", "does_not_know": "" }
  ]
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

  const endpoint = settings.ollamaEndpoint || "http://localhost:11434/v1";
  const model = settings.extractionModel || "qwen3:8b";

  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    throw new Error(`Extraction LLM error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
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

async function embed(settings, text) {
  const endpoint = settings.ollamaEndpoint || "http://localhost:11434/v1";
  const model = settings.embeddingModel || "nomic-embed-text";

  const res = await fetch(`${endpoint}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) throw new Error(`Embedding error: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

module.exports = { extract, embed };
