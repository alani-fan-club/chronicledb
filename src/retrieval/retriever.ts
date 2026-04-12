import type { ChronicleConfig } from "../config.js";
import type { SessionMode } from "../types.js";
import { cypher, withClient } from "../db/connection.js";
import { searchSimilar } from "../db/vector.js";
import { embed } from "../extraction/extractor.js";

interface RetrievalContext {
  characterName: string;
  chatId: string;
  sessionId: string;
  sessionMode: SessionMode;
  activeCharacters: string[];
  recentText: string; // last few messages concatenated for embedding
}

interface RelationshipData {
  from: string;
  to: string;
  sentiment: number;
  intensity: number;
  descriptor: string;
}

interface EventData {
  summary: string;
  participants: string[];
  importance: number;
  timestamp: string;
}

interface KnowledgeBoundary {
  character: string;
  knows: string[];
  doesNotKnow: string[];
}

interface WorldStateEntry {
  key: string;
  value: string;
  since: string;
}

export interface RetrievalResult {
  relationships: RelationshipData[];
  recentEvents: EventData[];
  knowledgeBoundaries: KnowledgeBoundary[];
  worldState: WorldStateEntry[];
  relevantNarratives: { text: string; similarity: number }[];
  currentLocations: { entity: string; location: string }[];
}

/**
 * Retrieve all relevant memory context for prompt injection.
 * Combines graph traversal with vector similarity search.
 */
export async function retrieve(
  config: ChronicleConfig,
  ctx: RetrievalContext,
): Promise<RetrievalResult> {
  // In isolated mode, only retrieve from this specific session
  const sessionFilter =
    ctx.sessionMode === "isolated" ? ctx.sessionId : undefined;

  // Run graph and vector queries in parallel
  const [
    relationships,
    recentEvents,
    knowledgeBoundaries,
    worldState,
    relevantNarratives,
    currentLocations,
  ] = await Promise.all([
    getRelationships(config, ctx.activeCharacters, sessionFilter),
    getRecentEvents(config, ctx.chatId, 5, sessionFilter),
    getKnowledgeBoundaries(config, ctx.activeCharacters, sessionFilter),
    getWorldState(config, ctx.chatId, sessionFilter),
    getRelevantNarratives(config, ctx),
    getCurrentLocations(config, ctx.activeCharacters, sessionFilter),
  ]);

  return {
    relationships,
    recentEvents,
    knowledgeBoundaries,
    worldState,
    relevantNarratives,
    currentLocations,
  };
}

async function getRelationships(
  config: ChronicleConfig,
  characters: string[],
  sessionFilter?: string,
): Promise<RelationshipData[]> {
  const results: RelationshipData[] = [];

  for (const charName of characters) {
    const sessionClause = sessionFilter
      ? `AND r.session_id = '${sessionFilter.replace(/'/g, "''")}'`
      : "";

    const rows = await cypher(config, `
      MATCH (a:Character {name: $name})-[r:FEELS_ABOUT]->(b:Character)
      WHERE true ${sessionClause}
      RETURN a.name as from_name, b.name as to_name,
             r.sentiment as sentiment, r.intensity as intensity,
             r.descriptor as descriptor
    `, { name: charName });

    for (const row of rows) {
      const r = row as Record<string, unknown>;
      results.push({
        from: String(r.from_name ?? ""),
        to: String(r.to_name ?? ""),
        sentiment: Number(r.sentiment ?? 0),
        intensity: Number(r.intensity ?? 0.5),
        descriptor: String(r.descriptor ?? ""),
      });
    }
  }

  return results;
}

async function getRecentEvents(
  config: ChronicleConfig,
  chatId: string,
  limit: number,
  sessionFilter?: string,
): Promise<EventData[]> {
  const sessionClause = sessionFilter
    ? `AND e.session_id = '${sessionFilter.replace(/'/g, "''")}'`
    : "";

  const rows = await cypher(config, `
    MATCH (e:Event)<-[:PARTICIPATED_IN]-(c:Character)
    WHERE e.scene_id STARTS WITH $chatPrefix ${sessionClause}
    RETURN e.summary as summary, collect(c.name) as participants,
           e.importance as importance, e.real_timestamp as timestamp
    ORDER BY e.real_timestamp DESC
    LIMIT ${limit}
  `, { chatPrefix: chatId });

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      summary: String(r.summary ?? ""),
      participants: (r.participants as string[]) ?? [],
      importance: Number(r.importance ?? 5),
      timestamp: String(r.timestamp ?? ""),
    };
  });
}

async function getKnowledgeBoundaries(
  config: ChronicleConfig,
  characters: string[],
  sessionFilter?: string,
): Promise<KnowledgeBoundary[]> {
  const boundaries: KnowledgeBoundary[] = [];

  for (const charName of characters) {
    const sessionClause = sessionFilter
      ? `AND r.session_id = '${sessionFilter.replace(/'/g, "''")}'`
      : "";

    // What this character knows
    const known = await cypher(config, `
      MATCH (c:Character {name: $name})-[r:KNOWS]->(f:Fact)
      WHERE true ${sessionClause}
      RETURN f.content as content
    `, { name: charName });

    // All facts in the current story that this character does NOT know
    const allFacts = await cypher(config, `
      MATCH (f:Fact)
      WHERE NOT ((:Character {name: $name})-[:KNOWS]->(f))
        AND f.category IN ['secret', 'lore', 'backstory']
      RETURN f.content as content
    `, { name: charName });

    boundaries.push({
      character: charName,
      knows: known.map((r) => String((r as Record<string, unknown>).content ?? "")),
      doesNotKnow: allFacts.map((r) => String((r as Record<string, unknown>).content ?? "")),
    });
  }

  return boundaries;
}

async function getWorldState(
  config: ChronicleConfig,
  _chatId: string,
  sessionFilter?: string,
): Promise<WorldStateEntry[]> {
  const sessionClause = sessionFilter
    ? `WHERE ws.session_id = '${sessionFilter.replace(/'/g, "''")}'`
    : "WHERE ws.valid_until IS NULL OR ws.valid_until = ''";

  const rows = await cypher(config, `
    MATCH (ws:WorldState)
    ${sessionClause}
    RETURN ws.key as key, ws.value as value, ws.valid_from as since
  `);

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      key: String(r.key ?? ""),
      value: String(r.value ?? ""),
      since: String(r.since ?? ""),
    };
  });
}

async function getRelevantNarratives(
  config: ChronicleConfig,
  ctx: RetrievalContext,
): Promise<{ text: string; similarity: number }[]> {
  if (!ctx.recentText) return [];

  const queryEmbedding = await embed(config, ctx.recentText);

  const results = await searchSimilar(config, queryEmbedding, {
    limit: 5,
    characterName: ctx.characterName,
    ...(ctx.sessionMode === "isolated"
      ? { sessionId: ctx.sessionId }
      : {}),
  });

  return results.map((r) => ({
    text: r.text,
    similarity: r.similarity,
  }));
}

async function getCurrentLocations(
  config: ChronicleConfig,
  characters: string[],
  sessionFilter?: string,
): Promise<{ entity: string; location: string }[]> {
  const results: { entity: string; location: string }[] = [];

  for (const charName of characters) {
    const sessionClause = sessionFilter
      ? `AND r.session_id = '${sessionFilter.replace(/'/g, "''")}'`
      : "";

    const rows = await cypher(config, `
      MATCH (c:Character {name: $name})-[r:LOCATED_AT {is_current: true}]->(l:Location)
      WHERE true ${sessionClause}
      RETURN c.name as entity, l.name as location
    `, { name: charName });

    for (const row of rows) {
      const r = row as Record<string, unknown>;
      results.push({
        entity: String(r.entity ?? ""),
        location: String(r.location ?? ""),
      });
    }
  }

  return results;
}
