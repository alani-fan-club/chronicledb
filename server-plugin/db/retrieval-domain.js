const { createHash } = require("crypto");

function createRetrievalDomain({ getPool }) {
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

  return {
    storeEmbedding,
    upsertMemoryEmbedding,
    upsertDialogueQuote,
  };
}

module.exports = {
  createRetrievalDomain,
};
