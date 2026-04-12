/**
 * Hybrid graph+vector retrieval for ChronicleDB.
 * Queries AGE graph for structured data, pgvector for semantic similarity,
 * then merges and formats into a prompt injection block.
 */

const db = require("./db");
const { embed } = require("./extractor");

async function retrieve(settings, { chatId, activeCharacters, recentText, sessionMode, sessionId, selectedChats }) {
  // Compute the chat-id scope once and thread it through every helper.
  // - explicit selectedChats wins (per-character preference from the chat picker UI)
  // - otherwise default to the current chatId (always scope to the current chat)
  // Vector search keeps the same scope; passing null falls back to global only when
  // no chatId is available at all (e.g. ad-hoc tooling calls).
  const chatIds = (selectedChats && selectedChats.length > 0)
    ? selectedChats
    : (chatId ? [chatId] : null);
  const chatScope = chatIds; // vector search uses the same scope

  // Run all queries in parallel
  const [relationships, events, knowledge, worldState, vectorResults, locations, snapshots, plotThreads] = await Promise.all([
    db.getRelationships(settings, activeCharacters, chatIds),
    db.getRecentEvents(settings, chatId, 5, chatIds),
    db.getKnowledgeBoundaries(settings, activeCharacters, chatIds),
    db.getWorldState(settings, chatIds),
    recentText ? semanticSearchScoped(settings, recentText, chatScope) : [],
    getLocations(settings, activeCharacters),
    db.getRecentSnapshots(settings, chatId, 2),
    db.getActivePlotThreads(settings, chatId),
  ]);

  return {
    relationships,
    events,
    knowledge,
    worldState,
    vectorResults,
    locations,
    snapshots,
    plotThreads,
  };
}

async function semanticSearchScoped(settings, text, chatIds) {
  const embedding = await embed(settings, text);
  if (chatIds && chatIds.length > 0) {
    return db.vectorSearchScoped(settings, { embedding, chatIds, limit: 5 });
  }
  return db.vectorSearch(settings, { embedding, limit: 5 });
}

async function getLocations(settings, characters) {
  if (!characters || characters.length === 0) return [];
  const p = db.getPool(settings);
  const charIds = characters.map((n) => db.slugify(n));
  const { rows } = await p.query(
    `SELECT c.name as entity, l.name as location
     FROM present_at pa
     JOIN characters c ON c.id = pa.character_id
     JOIN locations l ON l.id = pa.location_id
     WHERE pa.character_id = ANY($1::text[]) AND pa.is_current = TRUE`,
    [charIds],
  );
  return rows;
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

  // Context snapshots (recent scene state)
  if (result.snapshots && result.snapshots.length > 0) {
    const lines = result.snapshots.map((s) => {
      let line = `- ${s.summary}`;
      if (s.location_name) line += ` [at: ${s.location_name}]`;
      if (s.emotional_tone) line += ` (tone: ${s.emotional_tone})`;
      if (s.present_chars && s.present_chars.length > 0) line += ` — present: ${s.present_chars.join(", ")}`;
      return line;
    }).join("\n");
    sections.push(`## Scene Context\n${lines}`);
  }

  // Active plot threads
  if (result.plotThreads && result.plotThreads.length > 0) {
    const lines = result.plotThreads.map((pt) => {
      const typeIcon = { pending: "⏳", foreshadowing: "🔮", unresolved: "❓" }[pt.thread_type] || "📌";
      return `- ${typeIcon} [${pt.thread_type}] ${pt.title}: ${pt.description}${pt.involved_chars?.length ? ` (involves: ${pt.involved_chars.join(", ")})` : ""}`;
    }).join("\n");
    sections.push(`## Active Plot Threads\n${lines}`);
  }

  const block = `[ChronicleDB Memory Context]\n\n${sections.join("\n\n")}\n\n[/ChronicleDB Memory Context]`;

  // Rough token budget (4 chars ≈ 1 token)
  if (block.length > maxTokens * 4) {
    return block.slice(0, maxTokens * 4) + "\n\n[/ChronicleDB Memory Context]";
  }
  return block;
}

module.exports = { retrieve, formatMemoryBlock };
