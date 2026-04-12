import { z } from "zod";

// ── Zod schemas for extraction output validation ───────────────

const CharacterSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  description: z.string().default(""),
  faction: z.string().nullable().default(null),
  isPlayerCharacter: z.boolean().default(false),
});

const RelationshipSchema = z.object({
  from: z.string(),
  to: z.string(),
  descriptor: z.string(),
  sentiment: z.number().min(-1).max(1),
  intensity: z.number().min(0).max(1),
});

const EventSchema = z.object({
  summary: z.string(),
  participants: z.array(z.string()).default([]),
  witnesses: z.array(z.string()).default([]),
  importance: z.number().min(1).max(10),
  inWorldTimestamp: z.string().nullable().default(null),
});

const LocationSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  parentLocation: z.string().nullable().default(null),
});

const ItemSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  owner: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
});

const FactSchema = z.object({
  content: z.string(),
  category: z
    .enum(["lore", "secret", "rule", "backstory", "other"])
    .default("other"),
});

const KnowledgeUpdateSchema = z.object({
  character: z.string(),
  learned: z.string(),
  source: z
    .enum(["witnessed", "told", "discovered", "overheard"])
    .default("witnessed"),
});

const LocationChangeSchema = z.object({
  entity: z.string(),
  entityType: z.enum(["character", "item"]),
  from: z.string().nullable().default(null),
  to: z.string(),
});

const ExtractionOutputSchema = z.object({
  characters: z.array(CharacterSchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  events: z.array(EventSchema).default([]),
  locations: z.array(LocationSchema).default([]),
  items: z.array(ItemSchema).default([]),
  facts: z.array(FactSchema).default([]),
  knowledgeUpdates: z.array(KnowledgeUpdateSchema).default([]),
  locationChanges: z.array(LocationChangeSchema).default([]),
});

export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

/**
 * Parse the LLM's extraction response into a validated structure.
 * Handles:
 * - Clean JSON
 * - JSON wrapped in markdown fences
 * - Partial/malformed JSON (best-effort)
 */
export function parseExtractionResponse(raw: string): ExtractionOutput {
  const jsonStr = extractJsonFromResponse(raw);
  const parsed = JSON.parse(jsonStr);
  return ExtractionOutputSchema.parse(parsed);
}

function extractJsonFromResponse(raw: string): string {
  // Try raw first
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;

  // Try markdown fenced block
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try finding first { to last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error(`Could not extract JSON from LLM response: ${trimmed.slice(0, 200)}`);
}
