/**
 * Direct ChronicleDB retrieval client.
 *
 * Bypasses the SillyTavern plugin HTTP layer entirely. Connects to
 * PostgreSQL directly and runs the same queries the retriever.js would
 * run, then formats the memory block the same way.
 *
 * This is what the eval harness uses — no CSRF, no ST running required,
 * no network overhead.
 */

import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

const DB_CONFIG = {
  host: process.env.PGHOST || "localhost",
  port: parseInt(process.env.PGPORT || "5432"),
  database: process.env.PGDATABASE || "chronicledb",
  user: process.env.PGUSER || process.env.USER || "chronicledb",
  password: process.env.PGPASSWORD || "",
  max: 5,
};

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) pool = new Pool(DB_CONFIG);
  return pool;
}

function slugify(name: string): string {
  return "chr-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface RetrieveRequest {
  chatId: string;
  activeCharacters: string[];
  recentText: string;
  maxTokens?: number;
}

export interface RetrieveResult {
  memoryBlock: string;
  relationships: RelationshipRow[];
  events: EventRow[];
  knowledge: KnowledgeBoundary[];
  worldState: WorldStateRow[];
  plotThreads: PlotThreadRow[];
  snapshots: SnapshotRow[];
  locations: LocationRow[];
}

interface RelationshipRow {
  from_name: string;
  to_name: string;
  sentiment: number;
  intensity: number;
  description: string;
}
interface EventRow {
  summary: string;
  significance: number;
  participants: string[];
  timestamp: string;
}
interface KnowledgeBoundary {
  character: string;
  knows: string[];
  doesNotKnow: string[];
}
interface WorldStateRow {
  key: string;
  value: string;
  since: string;
}
interface PlotThreadRow {
  title: string;
  description: string;
  thread_type: string;
  importance: number;
}
interface SnapshotRow {
  summary: string;
  location_name: string | null;
  emotional_tone: string;
  present_chars: string[];
}
interface LocationRow {
  entity: string;
  location: string;
}

// ── Retrieval queries ──────────────────────────────────────────

async function getRelationships(chatId: string, characters: string[]): Promise<RelationshipRow[]> {
  const charIds = characters.map(slugify);
  const { rows } = await getPool().query(
    `SELECT c1.name as from_name, c2.name as to_name, fa.sentiment, fa.intensity, fa.description
     FROM feels_about fa
     JOIN characters c1 ON fa.from_char = c1.id
     JOIN characters c2 ON fa.to_char = c2.id
     WHERE fa.session_id = $1
       AND (fa.from_char = ANY($2::text[]) OR fa.to_char = ANY($2::text[]))
     ORDER BY fa.intensity DESC
     LIMIT 20`,
    [chatId, charIds],
  );
  return rows;
}

async function getRecentEvents(chatId: string, limit = 8): Promise<EventRow[]> {
  const { rows } = await getPool().query(
    `SELECT e.summary, e.significance, e.timestamp,
            array_agg(c.name) FILTER (WHERE c.name IS NOT NULL) as participants
     FROM events e
     LEFT JOIN participated_in pi ON pi.event_id = e.id
     LEFT JOIN characters c ON c.id = pi.character_id
     WHERE e.chat_id = $1
     GROUP BY e.id
     ORDER BY e.significance DESC, e.timestamp DESC
     LIMIT $2`,
    [chatId, limit],
  );
  return rows.map((r) => ({
    summary: r.summary,
    significance: r.significance,
    participants: r.participants ?? [],
    timestamp: r.timestamp,
  }));
}

async function getKnowledgeBoundaries(chatId: string, characters: string[]): Promise<KnowledgeBoundary[]> {
  const boundaries: KnowledgeBoundary[] = [];
  for (const name of characters) {
    const charId = slugify(name);
    const { rows: known } = await getPool().query(
      `SELECT DISTINCT f.content
       FROM knows k
       JOIN facts f ON k.fact_id = f.id
       WHERE k.character_id = $1
         AND f.id IN (
           SELECT node_id FROM memory_embeddings WHERE chat_id = $2 AND node_type = 'fact'
         )
       LIMIT 20`,
      [charId, chatId],
    );
    const { rows: unknown } = await getPool().query(
      `SELECT DISTINCT f.content
       FROM facts f
       WHERE f.domain IN ('secret', 'backstory')
         AND f.id NOT IN (SELECT fact_id FROM knows WHERE character_id = $1)
         AND f.id IN (
           SELECT node_id FROM memory_embeddings WHERE chat_id = $2 AND node_type = 'fact'
         )
       LIMIT 10`,
      [charId, chatId],
    );
    boundaries.push({
      character: name,
      knows: known.map((r) => r.content),
      doesNotKnow: unknown.map((r) => r.content),
    });
  }
  return boundaries;
}

async function getWorldState(chatId: string): Promise<WorldStateRow[]> {
  const { rows } = await getPool().query(
    `SELECT key, value, valid_from as since FROM world_state
     WHERE valid_until IS NULL AND chat_id = $1`,
    [chatId],
  );
  return rows;
}

async function getPlotThreads(chatId: string): Promise<PlotThreadRow[]> {
  const { rows } = await getPool().query(
    `SELECT title, description, thread_type, importance FROM plot_threads
     WHERE chat_id = $1 AND resolved_at IS NULL
     ORDER BY importance DESC
     LIMIT 10`,
    [chatId],
  );
  return rows;
}

async function getRecentSnapshots(chatId: string, limit = 3): Promise<SnapshotRow[]> {
  const { rows } = await getPool().query(
    `SELECT cs.summary, l.name as location_name, cs.emotional_tone, cs.present_chars
     FROM context_snapshots cs
     LEFT JOIN locations l ON cs.location_id = l.id
     WHERE cs.chat_id = $1
     ORDER BY cs.message_index DESC
     LIMIT $2`,
    [chatId, limit],
  );
  return rows;
}

async function getLocations(characters: string[]): Promise<LocationRow[]> {
  if (characters.length === 0) return [];
  const charIds = characters.map(slugify);
  const { rows } = await getPool().query(
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
 * Vector similarity search on memory_embeddings, scoped to a chat.
 * Returns the top-K most-similar content snippets.
 */
async function vectorSearch(
  chatId: string,
  queryEmbedding: number[],
  limit = 5,
): Promise<{ content: string; similarity: number }[]> {
  const { rows } = await getPool().query(
    `SELECT content, 1 - (embedding <=> $1::vector) as similarity
     FROM memory_embeddings
     WHERE chat_id = $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [JSON.stringify(queryEmbedding), chatId, limit],
  );
  return rows;
}

// ── Embedding via navy proxy (for vector search) ───────────────

async function embedText(text: string): Promise<number[]> {
  const base = process.env.NAVY_BASE_URL || "https://api.navy/v1";
  const key = process.env.NAVY_API_KEY;
  if (!key) throw new Error("NAVY_API_KEY not set");

  const res = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gemini-embedding-2-preview",
      input: text,
      dimensions: 768,
    }),
  });
  if (!res.ok) throw new Error(`embed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding;
}

// ── Format memory block ────────────────────────────────────────

function sentimentLabel(s: number): string {
  if (s >= 0.7) return "very positive";
  if (s >= 0.3) return "positive";
  if (s >= -0.3) return "neutral";
  if (s >= -0.7) return "negative";
  return "very negative";
}

function formatMemoryBlock(r: Omit<RetrieveResult, "memoryBlock"> & { vectorResults?: { content: string; similarity: number }[] }, maxChars: number): string {
  const sections: string[] = [];

  if (r.locations.length > 0) {
    sections.push(
      `## Current Scene\n${r.locations.map((l) => `- ${l.entity}: ${l.location}`).join("\n")}`,
    );
  }

  if (r.snapshots.length > 0) {
    const lines = r.snapshots.map((s) => {
      let line = `- ${s.summary}`;
      if (s.location_name) line += ` [at ${s.location_name}]`;
      if (s.emotional_tone) line += ` (${s.emotional_tone})`;
      return line;
    }).join("\n");
    sections.push(`## Scene Context\n${lines}`);
  }

  if (r.relationships.length > 0) {
    const lines = r.relationships.map((rel) => {
      const sent = sentimentLabel(rel.sentiment);
      const desc = rel.description ? ` — ${rel.description}` : "";
      return `- ${rel.from_name} → ${rel.to_name}: ${sent} (intensity ${(rel.intensity * 100).toFixed(0)}%)${desc}`;
    }).join("\n");
    sections.push(`## Relationships\n${lines}`);
  }

  if (r.events.length > 0) {
    const lines = r.events.map((e, i) =>
      `${i + 1}. [sig ${e.significance}/5] ${e.summary}${e.participants.length ? ` (${e.participants.join(", ")})` : ""}`
    ).join("\n");
    sections.push(`## Recent Events\n${lines}`);
  }

  if (r.knowledge.length > 0) {
    const lines = r.knowledge.map((kb) => {
      const parts: string[] = [];
      if (kb.knows.length > 0) parts.push(`- ${kb.character} knows: ${kb.knows.slice(0, 5).join("; ")}`);
      if (kb.doesNotKnow.length > 0) parts.push(`- ${kb.character} does NOT know: ${kb.doesNotKnow.slice(0, 3).join("; ")}`);
      return parts.join("\n");
    }).filter(Boolean).join("\n");
    if (lines) sections.push(`## Character Knowledge Boundaries\n${lines}`);
  }

  if (r.worldState.length > 0) {
    sections.push(
      `## World State\n${r.worldState.map((ws) => `- ${ws.key}: ${ws.value}`).join("\n")}`,
    );
  }

  if (r.plotThreads.length > 0) {
    const lines = r.plotThreads.map((pt) => {
      const icon = { pending: "⏳", foreshadowing: "🔮", unresolved: "❓" }[pt.thread_type] || "📌";
      return `- ${icon} [${pt.thread_type}] ${pt.title}: ${pt.description}`;
    }).join("\n");
    sections.push(`## Active Plot Threads\n${lines}`);
  }

  if (r.vectorResults && r.vectorResults.length > 0) {
    const lines = r.vectorResults
      .map((v) => `- (${(v.similarity * 100).toFixed(0)}%) ${v.content.slice(0, 250)}`)
      .join("\n");
    sections.push(`## Relevant Past Context\n${lines}`);
  }

  const block = `[ChronicleDB Memory Context]\n\n${sections.join("\n\n")}\n\n[/ChronicleDB Memory Context]`;

  if (block.length > maxChars) {
    return block.slice(0, maxChars) + "\n[...truncated]";
  }
  return block;
}

// ── Main entry ─────────────────────────────────────────────────

export async function retrieve(req: RetrieveRequest): Promise<RetrieveResult> {
  const { chatId, activeCharacters, recentText, maxTokens = 2000 } = req;
  const maxChars = maxTokens * 4;

  // Run graph queries in parallel
  const [relationships, events, knowledge, worldState, plotThreads, snapshots, locations] = await Promise.all([
    getRelationships(chatId, activeCharacters),
    getRecentEvents(chatId, 8),
    getKnowledgeBoundaries(chatId, activeCharacters),
    getWorldState(chatId),
    getPlotThreads(chatId),
    getRecentSnapshots(chatId, 3),
    getLocations(activeCharacters),
  ]);

  // Vector search if we have recent text
  let vectorResults: { content: string; similarity: number }[] = [];
  if (recentText) {
    try {
      const embedding = await embedText(recentText);
      vectorResults = await vectorSearch(chatId, embedding, 5);
    } catch (err) {
      console.warn("[cdb] vector search failed:", (err as Error).message);
    }
  }

  const memoryBlock = formatMemoryBlock(
    { relationships, events, knowledge, worldState, plotThreads, snapshots, locations, vectorResults },
    maxChars,
  );

  return {
    memoryBlock,
    relationships,
    events,
    knowledge,
    worldState,
    plotThreads,
    snapshots,
    locations,
  };
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
