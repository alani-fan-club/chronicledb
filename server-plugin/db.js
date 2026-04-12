const { Pool } = require("pg");
const { readFileSync } = require("fs");
const { resolve } = require("path");

let pool = null;
let poolConfigHash = "";

function getPool(settings) {
  const configHash = `${settings.pgHost}:${settings.pgPort}:${settings.pgDatabase}:${settings.pgUser}`;
  if (!pool || configHash !== poolConfigHash) {
    if (pool) pool.end().catch(() => {});
    poolConfigHash = configHash;
    pool = new Pool({
      host: settings.pgHost || "localhost",
      port: settings.pgPort || 5432,
      database: settings.pgDatabase || "chronicledb",
      user: settings.pgUser || process.env.USER,
      password: settings.pgPassword || "",
      max: 10,
    });
  }
  return pool;
}

async function initSchema(settings) {
  const p = getPool(settings);
  const sql = readFileSync(resolve(__dirname, "schema.sql"), "utf-8");
  const stmts = sql.split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith("--"));

  for (const stmt of stmts) {
    try {
      await p.query(stmt);
    } catch (err) {
      if (!err.message.includes("already exists")) {
        console.warn(`[ChronicleDB] Schema warning: ${err.message}`);
      }
    }
  }
  console.log("[ChronicleDB] Schema initialized.");
}

// ── Node upserts ───────────────────────────────────────────────

function slugify(name) {
  return "chr-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function upsertCharacter(settings, { name, aliases, description, firstSeen }) {
  const p = getPool(settings);
  const id = slugify(name);
  await p.query(
    `INSERT INTO characters (id, name, aliases, description, first_seen)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET aliases = $3, description = $4, updated_at = NOW()`,
    [id, name, aliases || [], description || "", firstSeen || ""],
  );
  return id;
}

async function upsertLocation(settings, name, description) {
  const p = getPool(settings);
  const id = "loc-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  await p.query(
    `INSERT INTO locations (id, name, description)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET description = $3`,
    [id, name, description || ""],
  );
  return id;
}

async function upsertRelationship(settings, { from, to, sentiment, intensity, description, sessionId }) {
  const p = getPool(settings);
  const fromId = slugify(from);
  const toId = slugify(to);
  // Ensure both characters exist
  await upsertCharacter(settings, { name: from });
  await upsertCharacter(settings, { name: to });
  await p.query(
    `INSERT INTO feels_about (from_char, to_char, sentiment, intensity, description, session_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (from_char, to_char) DO UPDATE
     SET sentiment = $3, intensity = $4, description = $5, session_id = $6, updated_at = NOW()`,
    [fromId, toId, sentiment || 0, intensity || 0.5, description || "", sessionId || ""],
  );
}

async function insertEvent(settings, { summary, participants, location, significance, messageIndex, sessionId }) {
  const p = getPool(settings);
  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  let locationId = null;
  if (location) {
    locationId = await upsertLocation(settings, location, "");
  }

  await p.query(
    `INSERT INTO events (id, summary, significance, message_index, location_id, chat_id, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [id, summary, significance || 3, messageIndex || 0, locationId, sessionId || ""],
  );

  for (const name of (participants || [])) {
    const charId = await upsertCharacter(settings, { name });
    await p.query(
      `INSERT INTO participated_in (character_id, event_id, role)
       VALUES ($1, $2, 'participant')
       ON CONFLICT (character_id, event_id) DO NOTHING`,
      [charId, id],
    );
  }

  return id;
}

async function upsertFact(settings, { content, domain, confidence, characterScope }) {
  const p = getPool(settings);
  const id = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await p.query(
    `INSERT INTO facts (id, content, domain, confidence)
     VALUES ($1, $2, $3, $4)`,
    [id, content, domain || "other", confidence || 0.8],
  );

  for (const charName of (characterScope || [])) {
    const charId = slugify(charName);
    // Ensure character exists
    await upsertCharacter(settings, { name: charName });
    await p.query(
      `INSERT INTO knows (character_id, fact_id, source)
       VALUES ($1, $2, 'discovered')
       ON CONFLICT (character_id, fact_id) DO NOTHING`,
      [charId, id],
    );
  }

  return id;
}

async function upsertWorldState(settings, { key, value, reason }) {
  const p = getPool(settings);
  await p.query(
    `UPDATE world_state SET valid_until = NOW() WHERE key = $1 AND valid_until IS NULL`,
    [key],
  );
  await p.query(
    `INSERT INTO world_state (key, value, reason) VALUES ($1, $2, $3)`,
    [key, value, reason || ""],
  );
}

// ── Context snapshots ──────────────────────────────────────────

async function insertContextSnapshot(settings, { chatId, messageIndex, summary, locationName, presentChars, emotionalTone, worldStateSnapshot }) {
  const p = getPool(settings);
  const id = `ctx-${chatId}-${messageIndex}`;
  let locationId = null;
  if (locationName) locationId = await upsertLocation(settings, locationName, "");
  await p.query(
    `INSERT INTO context_snapshots (id, chat_id, message_index, summary, location_id, present_chars, emotional_tone, world_state_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET summary = $4, location_id = $5, present_chars = $6, emotional_tone = $7, world_state_snapshot = $8, timestamp = NOW()`,
    [id, chatId, messageIndex, summary, locationId, presentChars || [], emotionalTone || "", JSON.stringify(worldStateSnapshot || {})],
  );
  return id;
}

async function getRecentSnapshots(settings, chatId, limit) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT cs.*, l.name as location_name FROM context_snapshots cs LEFT JOIN locations l ON cs.location_id = l.id WHERE cs.chat_id = $1 ORDER BY cs.message_index DESC LIMIT $2`,
    [chatId, limit || 3],
  );
  return rows;
}

// ── Plot threads ───────────────────────────────────────────────

async function upsertPlotThread(settings, { chatId, title, description, threadType, involvedChars, plantedAt, resolvedAt, importance }) {
  const p = getPool(settings);
  const { rows: existing } = await p.query(
    `SELECT id FROM plot_threads WHERE chat_id = $1 AND title = $2`, [chatId, title],
  );
  if (existing.length > 0) {
    await p.query(
      `UPDATE plot_threads SET thread_type = $2, description = $3, involved_chars = $4, resolved_at = $5, importance = $6, updated_at = NOW() WHERE id = $1`,
      [existing[0].id, threadType || "pending", description || "", involvedChars || [], resolvedAt || null, importance || 3],
    );
    return existing[0].id;
  }
  const id = `plot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await p.query(
    `INSERT INTO plot_threads (id, chat_id, thread_type, title, description, involved_chars, planted_at, resolved_at, importance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, chatId, threadType || "pending", title, description || "", involvedChars || [], plantedAt || null, resolvedAt || null, importance || 3],
  );
  return id;
}

async function getActivePlotThreads(settings, chatId) {
  const p = getPool(settings);
  const { rows } = await p.query(`SELECT * FROM plot_threads WHERE chat_id = $1 AND resolved_at IS NULL ORDER BY importance DESC`, [chatId]);
  return rows;
}

// ── Vector operations ───────────────────────────────────────��──

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
  const conditions = [];
  const params = [JSON.stringify(embedding), limit || 10];
  let idx = 3;

  if (chatId) { conditions.push(`chat_id = $${idx}`); params.push(chatId); idx++; }
  if (characterScope) { conditions.push(`character_scope && $${idx}::text[]`); params.push(characterScope); idx++; }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await p.query(
    `SELECT id, chat_id, node_type, node_id, content, character_scope, message_index,
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
    `SELECT id, chat_id, node_type, node_id, content, character_scope, message_index,
            1 - (embedding <=> $1::vector) as similarity
     FROM memory_embeddings
     WHERE chat_id = ANY($3::text[])
     ORDER BY embedding <=> $1::vector LIMIT $2`,
    [JSON.stringify(embedding), limit || 10, chatIds],
  );
  return rows;
}

// ── Query helpers for retrieval ────────────────────────────────

async function getRelationships(settings, characters) {
  const p = getPool(settings);
  const charIds = characters.map(slugify);
  const { rows } = await p.query(
    `SELECT c1.name as from_name, c2.name as to_name,
            fa.sentiment, fa.intensity, fa.description
     FROM feels_about fa
     JOIN characters c1 ON fa.from_char = c1.id
     JOIN characters c2 ON fa.to_char = c2.id
     WHERE fa.from_char = ANY($1::text[]) OR fa.to_char = ANY($1::text[])`,
    [charIds],
  );
  return rows.map((r) => ({
    from: r.from_name, to: r.to_name,
    sentiment: r.sentiment, intensity: r.intensity,
    description: r.description,
  }));
}

async function getKnowledgeBoundaries(settings, characters) {
  const p = getPool(settings);
  const boundaries = [];
  for (const name of characters) {
    const charId = slugify(name);
    const { rows: known } = await p.query(
      `SELECT f.content FROM knows k JOIN facts f ON k.fact_id = f.id WHERE k.character_id = $1`,
      [charId],
    );
    const { rows: unknown } = await p.query(
      `SELECT f.content FROM facts f
       WHERE f.domain IN ('secret', 'lore', 'backstory')
       AND f.id NOT IN (SELECT fact_id FROM knows WHERE character_id = $1)`,
      [charId],
    );
    boundaries.push({
      character: name,
      knows: known.map((r) => r.content),
      doesNotKnow: unknown.map((r) => r.content),
    });
  }
  return boundaries;
}

async function getRecentEvents(settings, chatId, limit) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT e.summary, e.significance, e.timestamp, e.message_index,
            array_agg(c.name) as participants
     FROM events e
     LEFT JOIN participated_in pi ON e.id = pi.event_id
     LEFT JOIN characters c ON pi.character_id = c.id
     GROUP BY e.id ORDER BY e.timestamp DESC LIMIT $1`,
    [limit || 5],
  );
  return rows;
}

async function getWorldState(settings) {
  const p = getPool(settings);
  const { rows } = await p.query(
    `SELECT key, value, valid_from as since FROM world_state WHERE valid_until IS NULL`,
  );
  return rows;
}

/**
 * N-hop recursive traversal from a starting character.
 * Finds all connected entities within `depth` hops through any edge type.
 */
async function traverseFromCharacter(settings, characterName, depth = 3) {
  const p = getPool(settings);
  const startId = slugify(characterName);

  // Get list of chat IDs that belong to this character.
  // Primary source: ingestion_status table. Fallback: session_id prefix
  // match in feels_about (for data ingested before tracking existed).
  const { rows: chats } = await p.query(
    `SELECT chat_file FROM ingestion_status WHERE character_name = $1 AND status = 'done'`,
    [characterName],
  );
  let chatIds = chats.map((c) => c.chat_file.replace(".jsonl", ""));

  // Fallback: find session_ids that start with the character name
  // (ST chat files are named "Character Name - date.jsonl")
  if (chatIds.length === 0) {
    const { rows: sessions } = await p.query(
      `SELECT DISTINCT session_id FROM feels_about WHERE session_id LIKE $1
       UNION
       SELECT DISTINCT chat_id FROM events WHERE chat_id LIKE $1`,
      [`${characterName}%`],
    );
    chatIds = sessions.map((s) => s.session_id).filter(Boolean);
  }

  // If still nothing, return empty
  if (chatIds.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Recursive CTE: walk through edges scoped to this character's chats
  const { rows } = await p.query(`
    WITH RECURSIVE
    -- Only edges from this character's ingested chats
    all_edges AS (
      SELECT from_char as src, 'character'::text as src_type, to_char as dst, 'character'::text as dst_type
      FROM feels_about WHERE session_id = ANY($3)
      UNION ALL
      SELECT to_char, 'character', from_char, 'character'
      FROM feels_about WHERE session_id = ANY($3)
      UNION ALL
      SELECT k.character_id, 'character', k.fact_id, 'fact'
      FROM knows k
      UNION ALL
      SELECT pi.character_id, 'character', pi.event_id, 'event'
      FROM participated_in pi
      JOIN events e ON e.id = pi.event_id WHERE e.chat_id = ANY($3)
      UNION ALL
      SELECT pi.event_id, 'event', pi.character_id, 'character'
      FROM participated_in pi
      JOIN events e ON e.id = pi.event_id WHERE e.chat_id = ANY($3)
    ),
    graph_walk AS (
      SELECT $1::text as node_id, 'character'::text as node_type, 0 as hop
      UNION
      SELECT ae.dst, ae.dst_type, gw.hop + 1
      FROM graph_walk gw
      JOIN all_edges ae ON ae.src = gw.node_id AND ae.src_type = gw.node_type
      WHERE gw.hop < $2
    )
    SELECT DISTINCT node_id, node_type, min(hop) as hop
    FROM graph_walk
    GROUP BY node_id, node_type
    ORDER BY hop, node_type
  `, [startId, depth, chatIds]);

  // Hydrate the node IDs into full objects
  const nodes = [];
  const charIds = rows.filter((r) => r.node_type === "character").map((r) => r.node_id);
  const factIds = rows.filter((r) => r.node_type === "fact").map((r) => r.node_id);
  const eventIds = rows.filter((r) => r.node_type === "event").map((r) => r.node_id);
  const locIds = rows.filter((r) => r.node_type === "location").map((r) => r.node_id);

  if (charIds.length > 0) {
    const { rows: chars } = await p.query(`SELECT * FROM characters WHERE id = ANY($1)`, [charIds]);
    for (const c of chars) nodes.push({ id: c.id, label: c.name, type: "character", metadata: c });
  }
  if (factIds.length > 0) {
    const { rows: fs } = await p.query(`SELECT * FROM facts WHERE id = ANY($1)`, [factIds]);
    for (const f of fs) nodes.push({ id: f.id, label: f.content.slice(0, 60), type: "fact", metadata: f });
  }
  if (eventIds.length > 0) {
    const { rows: es } = await p.query(`SELECT * FROM events WHERE id = ANY($1)`, [eventIds]);
    for (const e of es) nodes.push({ id: e.id, label: e.summary.slice(0, 60), type: "event", metadata: e });
  }
  if (locIds.length > 0) {
    const { rows: ls } = await p.query(`SELECT * FROM locations WHERE id = ANY($1)`, [locIds]);
    for (const l of ls) nodes.push({ id: l.id, label: l.name, type: "location", metadata: l });
  }

  // Get edges between discovered nodes — scoped to this character's chats
  const edges = [];

  if (charIds.length > 0) {
    const { rows: rels } = await p.query(
      `SELECT from_char as source, to_char as target, sentiment, intensity, description
       FROM feels_about
       WHERE from_char = ANY($1) AND to_char = ANY($1) AND session_id = ANY($2)`,
      [charIds, chatIds],
    );
    for (const r of rels) {
      edges.push({ id: `fa-${r.source}-${r.target}`, source: r.source, target: r.target,
        type: "FEELS_ABOUT", label: r.description || "",
        sentiment: parseFloat(r.sentiment) || 0, intensity: parseFloat(r.intensity) || 0.5 });
    }
  }

  if (charIds.length > 0 && factIds.length > 0) {
    const { rows: kn } = await p.query(
      `SELECT character_id, fact_id FROM knows WHERE character_id = ANY($1) AND fact_id = ANY($2)`,
      [charIds, factIds],
    );
    for (const k of kn) {
      edges.push({ id: `kn-${k.character_id}-${k.fact_id}`, source: k.character_id, target: k.fact_id,
        type: "KNOWS", label: "knows", sentiment: 0, intensity: 0.3 });
    }
  }

  if (charIds.length > 0 && eventIds.length > 0) {
    const { rows: pi } = await p.query(
      `SELECT pi.character_id, pi.event_id, pi.role
       FROM participated_in pi
       JOIN events e ON e.id = pi.event_id
       WHERE pi.character_id = ANY($1) AND pi.event_id = ANY($2) AND e.chat_id = ANY($3)`,
      [charIds, eventIds, chatIds],
    );
    for (const p of pi) {
      edges.push({ id: `pi-${p.character_id}-${p.event_id}`, source: p.character_id, target: p.event_id,
        type: "PARTICIPATED_IN", label: p.role || "participated", sentiment: 0, intensity: 0.5 });
    }
  }

  return { nodes, edges };
}

async function getGraphData(settings, { scope, character }) {
  const p = getPool(settings);
  const nodes = [];
  const edges = [];

  // Get all edges first so we know which nodes are connected
  const { rows: rels } = await p.query(
    `SELECT fa.from_char, fa.to_char, fa.sentiment, fa.intensity, fa.description
     FROM feels_about fa`,
  );
  const { rows: parts } = await p.query(
    `SELECT character_id, event_id, role FROM participated_in`,
  );
  const { rows: knowledgeEdges } = await p.query(
    `SELECT character_id, fact_id FROM knows LIMIT 500`,
  );

  // Collect IDs of all connected nodes
  const connectedIds = new Set();
  for (const r of rels) {
    connectedIds.add(r.from_char);
    connectedIds.add(r.to_char);
    edges.push({
      id: `fa-${r.from_char}-${r.to_char}`,
      source: r.from_char, target: r.to_char,
      type: "FEELS_ABOUT", label: (r.description || "").slice(0, 60),
      sentiment: parseFloat(r.sentiment) || 0,
      intensity: parseFloat(r.intensity) || 0.5,
    });
  }
  for (const pi of parts) {
    connectedIds.add(pi.character_id);
    connectedIds.add(pi.event_id);
    edges.push({
      id: `pi-${pi.character_id}-${pi.event_id}`,
      source: pi.character_id, target: pi.event_id,
      type: "PARTICIPATED_IN", label: pi.role || "participated",
      sentiment: 0, intensity: 0.5,
    });
  }
  for (const k of knowledgeEdges) {
    connectedIds.add(k.character_id);
    connectedIds.add(k.fact_id);
    edges.push({
      id: `kn-${k.character_id}-${k.fact_id}`,
      source: k.character_id, target: k.fact_id,
      type: "KNOWS", label: "knows",
      sentiment: 0, intensity: 0.3,
    });
  }

  // Only include nodes that have at least one edge
  if (connectedIds.size > 0) {
    const idArray = [...connectedIds];
    const { rows: chars } = await p.query(
      `SELECT * FROM characters WHERE id = ANY($1)`, [idArray],
    );
    for (const c of chars) {
      nodes.push({ id: c.id, label: c.name, type: "character", metadata: c });
    }

    const { rows: evts } = await p.query(
      `SELECT * FROM events WHERE id = ANY($1)`, [idArray],
    );
    for (const e of evts) {
      nodes.push({ id: e.id, label: (e.summary || "").slice(0, 40), type: "event", metadata: e });
    }

    const { rows: fcts } = await p.query(
      `SELECT * FROM facts WHERE id = ANY($1) LIMIT 100`, [idArray],
    );
    for (const f of fcts) {
      nodes.push({ id: f.id, label: (f.content || "").slice(0, 40), type: "fact", metadata: f });
    }

    const { rows: locs } = await p.query(
      `SELECT * FROM locations WHERE id = ANY($1)`, [idArray],
    );
    for (const l of locs) {
      nodes.push({ id: l.id, label: l.name, type: "location", metadata: l });
    }
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
  if (rows.length === 0) return { characterName, sessionMode: "persistent", selectedChats: [] };
  return { characterName: rows[0].character_name, sessionMode: rows[0].session_mode, selectedChats: rows[0].selected_chats || [] };
}

async function saveCharacterMemoryConfig(settings, { characterName, sessionMode, selectedChats }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO character_memory_config (character_name, session_mode, selected_chats, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (character_name) DO UPDATE SET session_mode = $2, selected_chats = $3, updated_at = NOW()`,
    [characterName, sessionMode || "persistent", selectedChats || []],
  );
}

async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = {
  getPool, initSchema, slugify,
  upsertCharacter, upsertLocation, upsertRelationship, insertEvent, upsertFact, upsertWorldState,
  insertContextSnapshot, getRecentSnapshots,
  upsertPlotThread, getActivePlotThreads,
  storeEmbedding, vectorSearch, vectorSearchScoped,
  getRelationships, getKnowledgeBoundaries, getRecentEvents, getWorldState,
  getGraphData, traverseFromCharacter, getCharacterMemoryConfig, saveCharacterMemoryConfig, closePool,
};
