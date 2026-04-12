import type { ChronicleConfig } from "../config.js";
import type { NarrativeChunk } from "../types.js";
import { withClient } from "./connection.js";

export async function storeChunk(
  config: ChronicleConfig,
  chunk: Omit<NarrativeChunk, "id">,
): Promise<string> {
  return withClient(config, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO narrative_chunks
        (text, embedding, scene_id, character_ids, session_id, chat_id, character_name, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        chunk.text,
        JSON.stringify(chunk.embedding),
        chunk.sceneId,
        chunk.characterIds,
        chunk.sessionId,
        chunk.sessionId, // chatId defaults to sessionId for now
        chunk.characterIds[0] ?? "unknown",
        chunk.timestamp,
      ],
    );
    return rows[0].id;
  });
}

/**
 * Semantic search: find narrative chunks most similar to the query embedding.
 * Supports scoping by session (for isolated mode) or character.
 */
export async function searchSimilar(
  config: ChronicleConfig,
  queryEmbedding: number[],
  opts: {
    limit?: number;
    sessionId?: string;
    characterName?: string;
    excludeSessionId?: string; // for "fresh" sessions that shouldn't see past memories
  } = {},
): Promise<(NarrativeChunk & { similarity: number })[]> {
  const limit = opts.limit ?? 10;
  const conditions: string[] = [];
  const params: unknown[] = [JSON.stringify(queryEmbedding), limit];
  let paramIdx = 3;

  if (opts.sessionId) {
    conditions.push(`session_id = $${paramIdx}`);
    params.push(opts.sessionId);
    paramIdx++;
  }

  if (opts.characterName) {
    conditions.push(`character_name = $${paramIdx}`);
    params.push(opts.characterName);
    paramIdx++;
  }

  if (opts.excludeSessionId) {
    conditions.push(`session_id != $${paramIdx}`);
    params.push(opts.excludeSessionId);
    paramIdx++;
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return withClient(config, async (client) => {
    const { rows } = await client.query(
      `SELECT
        id, text, embedding, scene_id, character_ids, session_id,
        chat_id, character_name, timestamp,
        1 - (embedding <=> $1::vector) as similarity
       FROM narrative_chunks
       ${where}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      params,
    );

    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      embedding: row.embedding,
      sceneId: row.scene_id,
      characterIds: row.character_ids,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      similarity: row.similarity,
    }));
  });
}
