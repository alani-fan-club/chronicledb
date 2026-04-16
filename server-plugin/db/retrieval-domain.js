const { createHash } = require("crypto");
const { buildOrTsquery } = require("../../shared/ts-query");

function createRetrievalDomain({ getPool, slugify }) {
  async function storeEmbedding(settings, { chatId, nodeType, nodeId, content, embedding, characterScope, messageIndex, rawText }) {
    const p = getPool(settings);
    await p.query(
      `INSERT INTO memory_embeddings (chat_id, node_type, node_id, content, embedding, character_scope, message_index, raw_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [chatId, nodeType, nodeId, content, JSON.stringify(embedding), characterScope || [], messageIndex || null, rawText || null],
    );
  }

  async function upsertMemoryEmbedding(settings, { chatId, nodeType, nodeId, content, embedding, characterScope, messageIndex, rawText, contextPrefix }) {
    const p = getPool(settings);
    // Dedupe by (chat_id, node_type, node_id) so re-ingest replaces rather than appends.
    await p.query(
      `DELETE FROM memory_embeddings WHERE chat_id = $1 AND node_type = $2 AND node_id = $3`,
      [chatId, nodeType, nodeId],
    );
    await p.query(
      `INSERT INTO memory_embeddings (chat_id, node_type, node_id, content, embedding, character_scope, message_index, raw_text, context_prefix)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [chatId, nodeType, nodeId, content, JSON.stringify(embedding), characterScope || [], messageIndex ?? null, rawText || null, contextPrefix || null],
    );
  }

  async function upsertDialogueQuote(settings, { chatId, sessionId, speaker, quote, messageIndex }) {
    const p = getPool(settings);
    const id = createHash("sha1")
      .update(`${chatId}|${messageIndex ?? ""}|${speaker}|${quote}`)
      .digest("hex")
      .slice(0, 16);
    await p.query(
      `INSERT INTO dialogue_quotes (id, chat_id, session_id, speaker, quote, message_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, chatId, sessionId || null, speaker, quote, messageIndex ?? null],
    );
    return id;
  }

  async function vectorSearch(settings, { embedding, chatId, limit, characterScope }) {
    const p = getPool(settings);
    const conditions = [];
    const params = [JSON.stringify(embedding), limit || 10];
    let idx = 3;

    if (chatId) { conditions.push(`chat_id = $${idx}`); params.push(chatId); idx++; }
    if (characterScope) { conditions.push(`character_scope && $${idx}::text[]`); params.push(characterScope); idx++; }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await p.query(
      `SELECT id, chat_id, node_type, node_id, content, COALESCE(raw_text, content) as raw_text,
              character_scope, message_index, context_prefix,
              1 - (embedding <=> $1::vector) as similarity
       FROM memory_embeddings ${where}
       ORDER BY embedding <=> $1::vector LIMIT $2`,
      params,
    );
    return rows;
  }

  async function vectorSearchScoped(settings, { embedding, chatIds, limit }) {
    const p = getPool(settings);
    const { rows } = await p.query(
      `SELECT id, chat_id, node_type, node_id, content, COALESCE(raw_text, content) as raw_text,
              character_scope, message_index, context_prefix,
              1 - (embedding <=> $1::vector) as similarity
       FROM memory_embeddings
       WHERE chat_id = ANY($3::text[])
       ORDER BY embedding <=> $1::vector LIMIT $2`,
      [JSON.stringify(embedding), limit || 10, chatIds],
    );
    return rows;
  }

  /**
   * PostgreSQL full-text lexical search on memory_embeddings.
   * Uses the GENERATED tsv column + GIN index. Returns rows ordered
   * by ts_rank descending. chatIds may be an array (scoped) or a
   * single string; if falsy, searches globally.
   *
   * Uses OR semantics via `buildOrTsquery` (from shared/ts-query.js).
   * Aligned with the eval-side lexical search so ST retrieval recall
   * matches what the eval harness measures - see REVIEW section 2a. Previously
   * used `plainto_tsquery` (AND), which was ~30% less recall on multi-
   * term queries like "what did X say about Y".
   *
   * Kept in db.js as a standalone entry point even though the canonical
   * retrieval pipeline in retriever.js now goes through shared/retrieval-
   * core.js directly. Retained for db.hybridSearch legacy callers and
   * for the test suite.
   */
  async function lexicalSearch(settings, { query, chatId, chatIds, limit }) {
    const p = getPool(settings);
    const tsquery = buildOrTsquery(query);
    if (!tsquery) return [];
    const scopedIds = Array.isArray(chatIds) && chatIds.length > 0
      ? chatIds
      : (chatId ? [chatId] : null);
    const conditions = ["tsv @@ to_tsquery('english', $1)"];
    const params = [tsquery, limit || 20];
    let idx = 3;
    if (scopedIds) {
      conditions.push(`chat_id = ANY($${idx}::text[])`);
      params.push(scopedIds);
      idx++;
    }
    const { rows } = await p.query(
      `SELECT id, chat_id, node_type, node_id, content, COALESCE(raw_text, content) as raw_text,
              character_scope, message_index, context_prefix,
              ts_headline('english', COALESCE(raw_text, content),
                to_tsquery('english', $1),
                'MaxWords=150, MinWords=30, MaxFragments=5, FragmentDelimiter=" ... "') as headline,
              ts_rank(tsv, to_tsquery('english', $1)) as rank
       FROM memory_embeddings
       WHERE ${conditions.join(" AND ")}
       ORDER BY rank DESC
       LIMIT $2`,
      params,
    );
    return rows;
  }

  /**
   * Hybrid vector + lexical search fused via Reciprocal Rank Fusion.
   * RRF formula: score = sum(1 / (k + rank)) across result lists, where
   * `rank` is the 1-indexed position in each list and k=60 (standard).
   * Overfetches each source by ~3x to give fusion material to work with.
   */
  async function hybridSearch(settings, { embedding, query, chatId, chatIds, limit, characterScope }) {
    const k = 60; // RRF constant
    const finalLimit = limit || 8;
    const fetchSize = finalLimit * 3;

    const scopedIds = Array.isArray(chatIds) && chatIds.length > 0
      ? chatIds
      : (chatId ? [chatId] : null);

    const vectorPromise = scopedIds
      ? vectorSearchScoped(settings, { embedding, chatIds: scopedIds, limit: fetchSize })
      : vectorSearch(settings, { embedding, limit: fetchSize, characterScope });

    const [vectorResults, lexicalResults] = await Promise.all([
      vectorPromise,
      lexicalSearch(settings, { query, chatIds: scopedIds, limit: fetchSize }),
    ]);

    const scores = new Map(); // id -> { score, item }
    vectorResults.forEach((r, i) => {
      const s = 1 / (k + i + 1);
      scores.set(r.id, { score: s, item: r });
    });
    lexicalResults.forEach((r, i) => {
      const s = 1 / (k + i + 1);
      if (scores.has(r.id)) {
        const existing = scores.get(r.id);
        existing.score += s;
        if (r.headline && !existing.item.headline) existing.item.headline = r.headline;
      } else {
        scores.set(r.id, { score: s, item: r });
      }
    });

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, finalLimit)
      .map((x) => x.item);
  }

  async function getRelationships(settings, characters, chatIds) {
    const p = getPool(settings);
    const charIds = characters.map(slugify);
    const scoped = Array.isArray(chatIds) && chatIds.length > 0;
    const params = scoped ? [charIds, chatIds] : [charIds];
    const sessionFilter = scoped ? ` AND fa.session_id = ANY($2::text[])` : "";
    const { rows } = await p.query(
      `SELECT c1.name as from_name, c2.name as to_name,
              fa.sentiment, fa.intensity, fa.description
       FROM feels_about fa
       JOIN characters c1 ON fa.from_char = c1.id
       JOIN characters c2 ON fa.to_char = c2.id
       WHERE (fa.from_char = ANY($1::text[]) OR fa.to_char = ANY($1::text[]))${sessionFilter}`,
      params,
    );
    return rows.map((r) => ({
      from: r.from_name,
      to: r.to_name,
      sentiment: r.sentiment,
      intensity: r.intensity,
      description: r.description,
    }));
  }

  async function getKnowledgeBoundaries(settings, characters, chatIds) {
    // Two queries total (not 2*N) - REVIEW section 5a N+1 collapse.
    //
    // C2 fix:
    // Previous scoping went through
    //   `f.id IN (SELECT node_id FROM memory_embeddings
    //             WHERE node_type = 'fact' AND chat_id = ANY($2))`
    // but nothing ever writes memory_embeddings rows with
    // node_type='fact' - upsertFact writes facts + knows and never
    // embeds. So both arrays came back empty on every scoped call and
    // the Character Knowledge Boundaries section was silently dead.
    //
    // Now we scope by `knows.chat_id` directly. The extractor stamps
    // chat_id on `knows` at write time and idx_knows_chat supports the
    // lookup. For `doesNotKnow`, since `facts` is global-scoped, we
    // restrict the candidate fact set to secrets/backstory that at
    // least one OTHER character in the same chat knows - "secrets in
    // play in this chat that the target doesn't know yet". Tradeoff:
    // a secret that no one in the chat knows yet is invisible, which
    // matches the intent (only surface secrets that are actually
    // narratively in play).
    //
    // Note: the shared retrieval-core.js copy of this function is the
    // one actually called by retriever.js. This in-db.js copy is kept
    // consistent so any direct caller (tests, admin tooling) sees the
    // same fixed behavior.
    if (!characters || characters.length === 0) return [];
    const p = getPool(settings);
    const scoped = Array.isArray(chatIds) && chatIds.length > 0;
    const charIds = characters.map(slugify);
    const nameById = new Map();
    characters.forEach((n, i) => nameById.set(charIds[i], n));

    // `known` - one query, all characters, scoped via knows.chat_id.
    const knownChatFilter = scoped ? ` AND k.chat_id = ANY($2::text[])` : "";
    const knownParams = scoped ? [charIds, chatIds] : [charIds];
    const { rows: knownRows } = await p.query(
      `SELECT DISTINCT k.character_id, f.content
       FROM knows k JOIN facts f ON k.fact_id = f.id
       WHERE k.character_id = ANY($1::text[])${knownChatFilter}`,
      knownParams,
    );

    // `doesNotKnow` - one query; cross product of the character list and
    // secret/backstory facts that at least one other character in the
    // same chat knows, minus what the target already knows. The EXISTS
    // clause is what replaces the dead memory_embeddings filter; when
    // unscoped we fall back to the old "all secrets/backstory" shape.
    const unknownExists = scoped
      ? ` AND EXISTS (
             SELECT 1 FROM knows other_k
             WHERE other_k.fact_id = f.id
               AND other_k.chat_id = ANY($2::text[])
           )`
      : "";
    const { rows: unknownRows } = await p.query(
      `SELECT DISTINCT target.c_param AS character_id, f.content
       FROM UNNEST($1::text[]) AS target(c_param)
       CROSS JOIN facts f
       WHERE f.domain IN ('secret', 'backstory')
         AND NOT EXISTS (
           SELECT 1 FROM knows k WHERE k.character_id = target.c_param AND k.fact_id = f.id
         )${unknownExists}`,
      knownParams,
    );

    const knownByChar = new Map();
    for (const r of knownRows) {
      let arr = knownByChar.get(r.character_id);
      if (!arr) {
        arr = [];
        knownByChar.set(r.character_id, arr);
      }
      arr.push(r.content);
    }
    const unknownByChar = new Map();
    for (const r of unknownRows) {
      let arr = unknownByChar.get(r.character_id);
      if (!arr) {
        arr = [];
        unknownByChar.set(r.character_id, arr);
      }
      arr.push(r.content);
    }

    return charIds.map((cid) => ({
      character: nameById.get(cid),
      knows: knownByChar.get(cid) || [],
      doesNotKnow: unknownByChar.get(cid) || [],
    }));
  }

  async function getRecentEvents(settings, chatId, limit, chatIds) {
    const p = getPool(settings);
    // Build chat-scope filter. Prefer the explicit chatIds list if provided,
    // otherwise fall back to the single chatId. If neither is set we return
    // events globally (legacy behavior - only happens when callers haven't
    // been migrated yet).
    const scopeIds = (Array.isArray(chatIds) && chatIds.length > 0)
      ? chatIds
      : (chatId ? [chatId] : null);
    const params = scopeIds ? [limit || 5, scopeIds] : [limit || 5];
    const where = scopeIds ? `WHERE e.chat_id = ANY($2::text[])` : "";
    const { rows } = await p.query(
      `SELECT e.summary, e.source_text, e.significance, e.timestamp, e.message_index,
              array_agg(c.name) as participants
       FROM events e
       LEFT JOIN participated_in pi ON e.id = pi.event_id
       LEFT JOIN characters c ON pi.character_id = c.id
       ${where}
       GROUP BY e.id ORDER BY e.timestamp DESC LIMIT $1`,
      params,
    );
    return rows;
  }

  async function getWorldState(settings, chatIds) {
    const p = getPool(settings);
    const scoped = Array.isArray(chatIds) && chatIds.length > 0;
    // Legacy world_state rows lack chat_id (upsertWorldState only started
    // writing it after this was flagged). NULL chat_id is treated as global
    // so pre-fix data remains visible. Cap at 20 newest so a runaway
    // extraction can't eat the entire token budget.
    const sql = scoped
      ? `SELECT key, value, valid_from as since FROM world_state
         WHERE valid_until IS NULL AND (chat_id = ANY($1::text[]) OR chat_id IS NULL)
         ORDER BY valid_from DESC
         LIMIT 20`
      : `SELECT key, value, valid_from as since FROM world_state
         WHERE valid_until IS NULL
         ORDER BY valid_from DESC
         LIMIT 20`;
    const { rows } = await p.query(sql, scoped ? [chatIds] : []);
    return rows;
  }

  return {
    storeEmbedding,
    upsertMemoryEmbedding,
    upsertDialogueQuote,
    vectorSearch,
    vectorSearchScoped,
    lexicalSearch,
    hybridSearch,
    getRelationships,
    getKnowledgeBoundaries,
    getRecentEvents,
    getWorldState,
  };
}

module.exports = {
  createRetrievalDomain,
};
