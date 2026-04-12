const { Pool } = require("pg");
const { readFileSync } = require("fs");
const { resolve } = require("path");

let pool = null;

function getPool(settings) {
  if (!pool) {
    pool = new Pool({
      host: settings.pgHost || "localhost",
      port: settings.pgPort || 5432,
      database: settings.pgDatabase || "chronicledb",
      user: settings.pgUser || "chronicledb",
      password: settings.pgPassword || "",
      max: 10,
    });
  }
  return pool;
}

async function initSchema(settings) {
  const p = getPool(settings);
  const sql = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");

  // Split on semicolons, respecting $$ blocks
  const stmts = splitStatements(sql);
  for (const stmt of stmts) {
    const trimmed = stmt.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;
    try {
      await p.query(trimmed);
    } catch (err) {
      if (!err.message.includes("already exists")) {
        console.warn(`[ChronicleDB] Schema warning: ${err.message}`);
      }
    }
  }
  console.log("[ChronicleDB] Schema initialized.");
}

function splitStatements(sql) {
  const stmts = [];
  let current = "";
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "$" && sql[i + 1] === "$") {
      inDollar = !inDollar;
      current += "$$";
      i++;
      continue;
    }
    if (sql[i] === ";" && !inDollar) {
      if (current.trim()) stmts.push(current.trim());
      current = "";
      continue;
    }
    current += sql[i];
  }
  if (current.trim()) stmts.push(current.trim());
  return stmts;
}

// ── Cypher helper ──────────────────────────────────────────────

async function cypher(settings, query, params = {}) {
  const p = getPool(settings);
  let interpolated = query;
  for (const [key, value] of Object.entries(params)) {
    const escaped =
      typeof value === "string"
        ? `'${value.replace(/'/g, "''")}'`
        : String(value);
    interpolated = interpolated.replace(new RegExp(`\\$${key}`, "g"), escaped);
  }

  const sql = `SET search_path = ag_catalog, "$user", public; SELECT * FROM cypher('chronicle', $$ ${interpolated} $$) as (result agtype);`;
  const { rows } = await p.query(sql);
  return rows.map((row) => {
    if (typeof row.result === "string") {
      try {
        return JSON.parse(row.result.replace(/::vertex|::edge|::path/g, ""));
      } catch {
        return row.result;
      }
    }
    return row.result;
  });
}

// ── Node upserts ───────────────────────────────────────────────

async function upsertCharacter(settings, { name, aliases, description, firstSeen }) {
  await cypher(settings, `
    MERGE (c:Character {name: $name})
    SET c.aliases = $aliases, c.description = $desc, c.first_seen = $firstSeen
  `, { name, aliases: JSON.stringify(aliases || []), desc: description || "", firstSeen: firstSeen || "" });
}

async function upsertRelationship(settings, { from, to, sentiment, intensity, description, sessionId }) {
  await cypher(settings, `
    MATCH (a:Character {name: $from}), (b:Character {name: $to})
    MERGE (a)-[r:FEELS_ABOUT]->(b)
    SET r.sentiment = $sentiment, r.intensity = $intensity,
        r.description = $desc, r.session_id = $sid, r.updated_at = $now
  `, {
    from, to,
    sentiment: String(sentiment),
    intensity: String(intensity),
    desc: description || "",
    sid: sessionId || "",
    now: new Date().toISOString(),
  });
}

async function insertEvent(settings, { summary, participants, location, significance, messageIndex, sessionId }) {
  const eventId = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await cypher(settings, `
    CREATE (e:Event {
      id: $id, summary: $summary, significance: $sig,
      message_index: $msgIdx, timestamp: $now
    })
  `, {
    id: eventId, summary, sig: String(significance || 3),
    msgIdx: String(messageIndex || 0), now: new Date().toISOString(),
  });

  // Link participants
  for (const p of (participants || [])) {
    await cypher(settings, `
      MATCH (c:Character {name: $name}), (e:Event {id: $eid})
      MERGE (c)-[:CAUSED]->(e)
    `, { name: p, eid: eventId });
  }

  // Link location
  if (location) {
    await cypher(settings, `
      MERGE (l:Location {name: $loc})
      WITH l
      MATCH (e:Event {id: $eid})
      MERGE (e)-[:OCCURRED_AT]->(l)
    `, { loc: location, eid: eventId });
  }

  return eventId;
}

async function upsertFact(settings, { content, domain, confidence, characterScope }) {
  const factId = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await cypher(settings, `
    CREATE (f:Fact {
      id: $id, content: $content, domain: $domain, confidence: $conf
    })
  `, { id: factId, content, domain: domain || "other", conf: String(confidence || 0.8) });

  // Link to characters who know this
  for (const char of (characterScope || [])) {
    await cypher(settings, `
      MATCH (c:Character {name: $name}), (f:Fact {id: $fid})
      MERGE (c)-[:KNOWS {learned_at: $now}]->(f)
    `, { name: char, fid: factId, now: new Date().toISOString() });
  }

  return factId;
}

async function upsertWorldState(settings, { key, value, reason }) {
  // Expire old value
  await cypher(settings, `
    MATCH (ws:WorldState {key: $key})
    WHERE ws.valid_until IS NULL OR ws.valid_until = ''
    SET ws.valid_until = $now
  `, { key, now: new Date().toISOString() });

  // Insert new value
  await cypher(settings, `
    CREATE (ws:WorldState {
      key: $key, value: $value, reason: $reason,
      valid_from: $now, valid_until: ''
    })
  `, { key, value, reason: reason || "", now: new Date().toISOString() });
}

// ── Vector operations ──────────────────────────────────────────

async function storeEmbedding(settings, { chatId, nodeType, nodeId, content, embedding, characterScope, messageIndex }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO memory_embeddings (chat_id, node_type, node_id, content, embedding, character_scope, message_index)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [chatId, nodeType, nodeId, content, JSON.stringify(embedding), characterScope || [], messageIndex || null],
  );
}

async function vectorSearch(settings, { embedding, chatId, limit, characterScope }) {
  const p = getPool(settings);
  const conditions = ["TRUE"];
  const params = [JSON.stringify(embedding), limit || 10];
  let idx = 3;

  if (chatId) {
    conditions.push(`chat_id = $${idx}`);
    params.push(chatId);
    idx++;
  }
  if (characterScope) {
    conditions.push(`character_scope && $${idx}::text[]`);
    params.push(characterScope);
    idx++;
  }

  const { rows } = await p.query(
    `SELECT id, chat_id, node_type, node_id, content, character_scope, message_index,
            1 - (embedding <=> $1::vector) as similarity
     FROM memory_embeddings
     WHERE ${conditions.join(" AND ")}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    params,
  );
  return rows;
}

// ── Query helpers for retrieval ────────────────────────────────

async function getRelationships(settings, characters) {
  const results = [];
  for (const name of characters) {
    const rows = await cypher(settings, `
      MATCH (a:Character {name: $name})-[r:FEELS_ABOUT]->(b:Character)
      RETURN a.name as from_name, b.name as to_name,
             r.sentiment as sentiment, r.intensity as intensity,
             r.description as description
    `, { name });
    for (const r of rows) {
      results.push({
        from: r.from_name, to: r.to_name,
        sentiment: r.sentiment, intensity: r.intensity,
        description: r.description,
      });
    }
  }
  return results;
}

async function getKnowledgeBoundaries(settings, characters) {
  const boundaries = [];
  for (const name of characters) {
    const known = await cypher(settings, `
      MATCH (c:Character {name: $name})-[:KNOWS]->(f:Fact)
      RETURN f.content as content
    `, { name });

    const unknown = await cypher(settings, `
      MATCH (f:Fact)
      WHERE NOT ((:Character {name: $name})-[:KNOWS]->(f))
        AND f.domain IN ['secret', 'lore', 'backstory']
      RETURN f.content as content
    `, { name });

    boundaries.push({
      character: name,
      knows: known.map((r) => r.content),
      doesNotKnow: unknown.map((r) => r.content),
    });
  }
  return boundaries;
}

async function getRecentEvents(settings, chatId, limit) {
  const rows = await cypher(settings, `
    MATCH (e:Event)
    RETURN e.summary as summary, e.significance as significance,
           e.timestamp as timestamp, e.message_index as message_index
    ORDER BY e.timestamp DESC
    LIMIT ${limit || 5}
  `);
  return rows;
}

async function getWorldState(settings) {
  const rows = await cypher(settings, `
    MATCH (ws:WorldState)
    WHERE ws.valid_until IS NULL OR ws.valid_until = ''
    RETURN ws.key as key, ws.value as value, ws.valid_from as since
  `);
  return rows;
}

async function getGraphData(settings, { scope, character, chatId, nodeId, depth }) {
  const nodes = [];
  const edges = [];

  if (scope === "character" && character) {
    const rows = await cypher(settings, `
      MATCH (c:Character {name: $name})-[r]-(n)
      RETURN c, r, n
    `, { name: character });
    // Parse into nodes/edges (simplified)
    for (const row of rows) {
      if (row.c) nodes.push(row.c);
      if (row.n) nodes.push(row.n);
    }
  } else {
    // Global: all characters + relationships
    const chars = await cypher(settings, `MATCH (c:Character) RETURN c`);
    for (const c of chars) nodes.push(c);

    const rels = await cypher(settings, `
      MATCH (a:Character)-[r:FEELS_ABOUT]->(b:Character)
      RETURN a.name as source, b.name as target, r.sentiment as sentiment,
             r.intensity as intensity, r.description as description
    `);
    for (const r of rels) edges.push(r);
  }

  return { nodes, edges };
}

// ── Per-character memory config ────────────────────────────────

async function getCharacterMemoryConfig(settings, characterName) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT * FROM character_memory_config WHERE character_name = $1`,
    [characterName],
  );
  if (rows.length === 0) {
    return { characterName, sessionMode: "persistent", selectedChats: [] };
  }
  return {
    characterName: rows[0].character_name,
    sessionMode: rows[0].session_mode,
    selectedChats: rows[0].selected_chats || [],
  };
}

async function saveCharacterMemoryConfig(settings, { characterName, sessionMode, selectedChats }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO character_memory_config (character_name, session_mode, selected_chats, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (character_name) DO UPDATE
     SET session_mode = $2, selected_chats = $3, updated_at = NOW()`,
    [characterName, sessionMode || "persistent", selectedChats || []],
  );
}

// ── Chat-scoped vector search ──────────────────────────────────

async function vectorSearchScoped(settings, { embedding, chatIds, limit, characterScope }) {
  const p = getPool(settings);
  const conditions = [];
  const params = [JSON.stringify(embedding), limit || 10];
  let idx = 3;

  if (chatIds && chatIds.length > 0) {
    conditions.push(`chat_id = ANY($${idx}::text[])`);
    params.push(chatIds);
    idx++;
  }
  if (characterScope) {
    conditions.push(`character_scope && $${idx}::text[]`);
    params.push(characterScope);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await p.query(
    `SELECT id, chat_id, node_type, node_id, content, character_scope, message_index,
            1 - (embedding <=> $1::vector) as similarity
     FROM memory_embeddings
     ${where}
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    params,
  );
  return rows;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool, initSchema, cypher,
  upsertCharacter, upsertRelationship, insertEvent, upsertFact, upsertWorldState,
  storeEmbedding, vectorSearch, vectorSearchScoped,
  getRelationships, getKnowledgeBoundaries, getRecentEvents, getWorldState,
  getGraphData, getCharacterMemoryConfig, saveCharacterMemoryConfig, closePool,
};
