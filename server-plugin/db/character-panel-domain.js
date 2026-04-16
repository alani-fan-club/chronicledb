function createCharacterPanelDomain({ getPool, slugify }) {
  async function getCharacterPanelStats(settings, characterName, chatId) {
    const p = getPool(settings);
    const charId = slugify(characterName);
    // When chatId is provided, every count is scoped to that chat. traits.source_chat
    // and feels_about.session_id carry chat scope directly; participated_in is
    // scoped via events.chat_id join. Legacy rows with NULL chat are dropped
    // under scoped mode — they're cross-chat contamination from the old
    // pipeline and surfacing them is exactly what the user reported.
    if (chatId) {
      const { rows } = await p.query(
        `SELECT
           (SELECT COUNT(*) FROM participated_in pi
              JOIN events e ON e.id = pi.event_id
              WHERE pi.character_id = $1 AND e.chat_id = $2)::int AS events,
           (SELECT COUNT(*) FROM traits
              WHERE character_id = $1 AND source_chat = $2
                AND canonical_id IS NULL)::int AS traits,
           (SELECT COUNT(*) FROM feels_about
              WHERE (from_char = $1 OR to_char = $1) AND session_id = $2)::int AS relationships,
           (SELECT MAX(e.message_index) FROM events e
              JOIN participated_in pi ON pi.event_id = e.id
              WHERE pi.character_id = $1 AND e.chat_id = $2) AS last_seen_turn`,
        [charId, chatId],
      );
      const r = rows[0] || {};
      return {
        events: r.events || 0,
        traits: r.traits || 0,
        relationships: r.relationships || 0,
        lastSeenTurn: r.last_seen_turn == null ? null : Number(r.last_seen_turn),
      };
    }
    const { rows } = await p.query(
      `SELECT
         (SELECT COUNT(*) FROM participated_in WHERE character_id = $1)::int AS events,
         (SELECT COUNT(*) FROM traits
            WHERE character_id = $1 AND canonical_id IS NULL)::int AS traits,
         (SELECT COUNT(*) FROM feels_about WHERE from_char = $1 OR to_char = $1)::int AS relationships,
         (SELECT MAX(e.message_index) FROM events e
            JOIN participated_in pi ON pi.event_id = e.id
            WHERE pi.character_id = $1) AS last_seen_turn`,
      [charId],
    );
    const r = rows[0] || {};
    return {
      events: r.events || 0,
      traits: r.traits || 0,
      relationships: r.relationships || 0,
      lastSeenTurn: r.last_seen_turn == null ? null : Number(r.last_seen_turn),
    };
  }

  async function getCharacterRecentEvents(settings, characterName, limit, chatId) {
    const p = getPool(settings);
    const charId = slugify(characterName);
    const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 5));
    const sql = chatId
      ? `SELECT e.id, e.summary, e.source_text, e.message_index, e.significance, e.chat_id
         FROM events e
         JOIN participated_in pi ON pi.event_id = e.id
         WHERE pi.character_id = $1 AND e.chat_id = $3
         ORDER BY e.message_index DESC NULLS LAST, e.timestamp DESC
         LIMIT $2`
      : `SELECT e.id, e.summary, e.source_text, e.message_index, e.significance, e.chat_id
         FROM events e
         JOIN participated_in pi ON pi.event_id = e.id
         WHERE pi.character_id = $1
         ORDER BY e.message_index DESC NULLS LAST, e.timestamp DESC
         LIMIT $2`;
    const params = chatId ? [charId, lim, chatId] : [charId, lim];
    const { rows } = await p.query(sql, params);
    return rows.map((r) => ({
      id: r.id,
      summary: r.summary,
      sourceText: r.source_text || "",
      messageIndex: r.message_index,
      significance: r.significance,
      chatId: r.chat_id,
    }));
  }

  async function getCharacterOutboundRelationships(settings, characterName, chatId) {
    const p = getPool(settings);
    const charId = slugify(characterName);
    // When scoped, pin directly to the session_id so only this-chat feelings
    // show. Unscoped still collapses via DISTINCT ON so the panel stays
    // compact across multi-chat characters.
    if (chatId) {
      const { rows } = await p.query(
        `SELECT c.name AS to_name, f.sentiment, f.intensity, f.description, f.updated_at
         FROM feels_about f
         JOIN characters c ON c.id = f.to_char
         WHERE f.from_char = $1 AND f.session_id = $2
         ORDER BY f.updated_at DESC`,
        [charId, chatId],
      );
      return rows.map((r) => ({
        toName: r.to_name,
        sentiment: Number(r.sentiment) || 0,
        intensity: Number(r.intensity) || 0,
        description: r.description || "",
      }));
    }
    const { rows } = await p.query(
      `SELECT DISTINCT ON (f.to_char)
              c.name AS to_name, f.sentiment, f.intensity, f.description, f.updated_at
       FROM feels_about f
       JOIN characters c ON c.id = f.to_char
       WHERE f.from_char = $1
       ORDER BY f.to_char, f.updated_at DESC`,
      [charId],
    );
    return rows.map((r) => ({
      toName: r.to_name,
      sentiment: Number(r.sentiment) || 0,
      intensity: Number(r.intensity) || 0,
      description: r.description || "",
    }));
  }

  return {
    getCharacterPanelStats,
    getCharacterRecentEvents,
    getCharacterOutboundRelationships,
  };
}

module.exports = {
  createCharacterPanelDomain,
};
