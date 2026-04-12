/**
 * Extraction prompts for the cheap local LLM.
 * These prompts are designed to work with smaller models (Qwen 8B, Llama 8B, etc.)
 * and produce structured JSON output for graph ingestion.
 */

export const EXTRACTION_SYSTEM_PROMPT = `You are a narrative analyst for a roleplay memory system. Your job is to extract structured information from roleplay messages.

You will receive a batch of messages from a roleplay conversation. Each message has a speaker name and content. Some messages are from the user (player character), others are from AI characters or narrators.

Extract the following categories of information:

1. **Characters**: Any named characters mentioned or present. Note if they're a player character or NPC.
2. **Relationships**: How characters feel about each other. Include sentiment (-1.0 hostile to 1.0 loving), a descriptor (e.g., "trusts", "fears", "attracted to"), and intensity (0.0-1.0).
3. **Events**: Significant things that happened. Rate importance 1-10.
4. **Locations**: Named places mentioned or where the scene takes place.
5. **Items**: Notable objects, especially ones that belong to or are carried by characters.
6. **Facts**: World-building details, lore, secrets, rules of the setting.
7. **Knowledge updates**: Which character learned what new information in these messages. CRITICAL: Only attribute knowledge to a character if they were present and could have perceived it. Do NOT give a character knowledge of events they weren't there for. Also note what characters explicitly do NOT know if there's a secret or hidden info.
8. **Location changes**: If anyone moved to a new location.
9. **World state changes**: Key-value changes to the world/setting (e.g., "temple_barrier" → "broken", "time_of_day" → "night"). These are environmental facts that affect all characters.

IMPORTANT RULES:
- Distinguish between what different characters know. If Character A does something while Character B is not present, Character B does NOT know about it.
- Narrator descriptions are omniscient — characters only know what they directly witnessed or were told.
- Track the active/selected swipe only. Ignore alternative swipes.
- If something was already established in earlier context, don't re-extract it unless it changed.

Respond with ONLY valid JSON matching this schema:`;

export const EXTRACTION_JSON_SCHEMA = `{
  "characters": [
    {
      "name": "string",
      "aliases": ["string"],
      "description": "string (brief, what we learned about them)",
      "faction": "string | null",
      "isPlayerCharacter": "boolean"
    }
  ],
  "relationships": [
    {
      "from": "character name",
      "to": "character name",
      "descriptor": "string (e.g., trusts, fears, loves)",
      "sentiment": "number (-1.0 to 1.0)",
      "intensity": "number (0.0 to 1.0)"
    }
  ],
  "events": [
    {
      "summary": "string (what happened)",
      "participants": ["character names who were involved"],
      "witnesses": ["character names who saw it but weren't directly involved"],
      "importance": "number (1-10)",
      "inWorldTimestamp": "string | null (in-story time if mentioned)"
    }
  ],
  "locations": [
    {
      "name": "string",
      "description": "string",
      "parentLocation": "string | null"
    }
  ],
  "items": [
    {
      "name": "string",
      "description": "string",
      "owner": "character name | null",
      "location": "location name | null"
    }
  ],
  "facts": [
    {
      "content": "string (the fact)",
      "category": "lore | secret | rule | backstory | other"
    }
  ],
  "knowledgeUpdates": [
    {
      "character": "character name",
      "learned": "string (what they now know)",
      "source": "witnessed | told | discovered | overheard"
    }
  ],
  "locationChanges": [
    {
      "entity": "character or item name",
      "entityType": "character | item",
      "from": "location name | null",
      "to": "location name"
    }
  ],
  "worldStateChanges": [
    {
      "key": "string (descriptive key, e.g., temple_barrier, time_of_day)",
      "value": "string (current value)",
      "reason": "string (what caused the change)"
    }
  ]
}`;

export function buildExtractionPrompt(
  characterName: string,
  userName: string,
  messages: { speaker: string; text: string; isUser: boolean }[],
): string {
  const msgBlock = messages
    .map(
      (m) =>
        `[${m.isUser ? "USER" : "CHARACTER"}] ${m.speaker}: ${m.text.slice(0, 2000)}`,
    )
    .join("\n\n---\n\n");

  return `${EXTRACTION_SYSTEM_PROMPT}

${EXTRACTION_JSON_SCHEMA}

---

Context: This is a roleplay between user "${userName}" and character "${characterName}".
The user's character name in the story may differ from their username — infer it from the messages.

Messages to analyze:

${msgBlock}

Respond with ONLY the JSON object. No markdown fencing, no explanation.`;
}
