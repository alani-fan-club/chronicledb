/**
 * Hybrid graph+vector retrieval for ChronicleDB.
 * Queries AGE graph for structured data, pgvector for semantic similarity,
 * then merges and formats into a prompt injection block.
 */

const db = require("./db");
const { embed } = require("./extractor");

async function retrieve(settings, { chatId, activeCharacters, recentText, sessionMode, sessionId }) {
  // Run all queries in parallel
  const [relationships, events, knowledge, worldState, vectorResults, locations] = await Promise.all([
    db.getRelationships(settings, activeCharacters),
    db.getRecentEvents(settings, chatId, 5),
    db.getKnowledgeBoundaries(settings, activeCharacters),
    db.getWorldState(settings),
    recentText ? semanticSearch(settings, recentText, chatId) : [],
    getLocations(settings, activeCharacters),
  ]);

  return {
    relationships,
    events,
    knowledge,
    worldState,
    vectorResults,
    locations,
  };
}

async function semanticSearch(settings, text, chatId) {
  const embedding = await embed(settings, text);
  return db.vectorSearch(settings, { embedding, chatId, limit: 5 });
}

async function getLocations(settings, characters) {
  const results = [];
  for (const name of characters) {
    const rows = await db.cypher(settings, `
      MATCH (c:Character {name: $name})-[r:PRESENT_AT]->(l:Location)
      WHERE r.until IS NULL OR r.until = ''
      RETURN c.name as entity, l.name as location
    `, { name });
    for (const r of rows) {
      results.push({ entity: r.entity, location: r.location });
    }
  }
  return results;
}

/**
 * Format retrieval results into the injection block.
 */
function formatMemoryBlock(result, maxTokens = 1500) {
  const sections = [];

  if (result.locations && result.locations.length > 0) {
    const lines = result.locations.map((l) => `- ${l.entity}: ${l.location}`).join("\n");
    sections.push(`## Current Scene\n${lines}`);
  }

  if (result.relationships && result.relationships.length > 0) {
    const lines = result.relationships.map((r) => {
      const sent = typeof r.sentiment === "number" ? ` (${r.sentiment.toFixed(1)})` : "";
      return `- ${r.from} → ${r.to}: ${r.description || "unknown"}${sent}${r.intensity ? ` — intensity ${(r.intensity * 100).toFixed(0)}%` : ""}`;
    }).join("\n");
    sections.push(`## Active Relationships\n${lines}`);
  }

  if (result.events && result.events.length > 0) {
    const lines = result.events.map((e, i) =>
      `${i + 1}. ${e.summary} (significance: ${e.significance || "?"})`
    ).join("\n");
    sections.push(`## Recent Events\n${lines}`);
  }

  if (result.knowledge && result.knowledge.length > 0) {
    const lines = result.knowledge.map((kb) => {
      const parts = [];
      if (kb.knows && kb.knows.length > 0) {
        parts.push(`- ${kb.character} knows: ${kb.knows.join("; ")}`);
      }
      if (kb.doesNotKnow && kb.doesNotKnow.length > 0) {
        parts.push(`- ${kb.character} does NOT know: ${kb.doesNotKnow.join("; ")}`);
      }
      return parts.join("\n");
    }).join("\n");
    sections.push(`## Character Knowledge Boundaries\n${lines}`);
  }

  if (result.worldState && result.worldState.length > 0) {
    const lines = result.worldState.map((ws) => `- ${ws.key}: ${ws.value}`).join("\n");
    sections.push(`## World State\n${lines}`);
  }

  if (result.vectorResults && result.vectorResults.length > 0) {
    const lines = result.vectorResults
      .map((v) => `- (${(v.similarity * 100).toFixed(0)}%) ${v.content.slice(0, 200)}`)
      .join("\n");
    sections.push(`## Relevant Past Context\n${lines}`);
  }

  const block = `[ChronicleDB Memory Context]\n\n${sections.join("\n\n")}\n\n[/ChronicleDB Memory Context]`;

  // Rough token budget (4 chars ≈ 1 token)
  if (block.length > maxTokens * 4) {
    return block.slice(0, maxTokens * 4) + "\n\n[/ChronicleDB Memory Context]";
  }
  return block;
}

module.exports = { retrieve, formatMemoryBlock };
