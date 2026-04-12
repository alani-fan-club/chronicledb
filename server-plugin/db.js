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

// ── Story arcs and event chains ────────────────────────────────

async function upsertStoryArc(settings, { chatId, title, description, arcType, status, importance, startMsgIdx, endMsgIdx, spineEventId }) {
  const p = getPool(settings);
  const { rows: existing } = await p.query(
    `SELECT id FROM story_arcs WHERE chat_id = $1 AND title = $2`,
    [chatId, title],
  );
  let arcId;
  if (existing.length > 0) {
    arcId = existing[0].id;
    await p.query(
      `UPDATE story_arcs SET description = $2, arc_type = $3, status = $4, importance = $5, end_msg_idx = $6, spine_event_id = COALESCE($7, spine_event_id), updated_at = NOW() WHERE id = $1`,
      [arcId, description || "", arcType || "main", status || "active", importance || 3, endMsgIdx, spineEventId],
    );
  } else {
    arcId = `arc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await p.query(
      `INSERT INTO story_arcs (id, chat_id, title, description, arc_type, status, importance, start_msg_idx, end_msg_idx, spine_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [arcId, chatId, title, description || "", arcType || "main", status || "active", importance || 3, startMsgIdx, endMsgIdx, spineEventId],
    );
  }
  return arcId;
}

async function linkEventToArc(settings, { arcId, eventId, position, isAnchor }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO arc_events (arc_id, event_id, position, is_anchor) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [arcId, eventId, position || 0, isAnchor || false],
  ).catch(() => {});
}

async function createEventChain(settings, { fromEventId, toEventId, chainType, description }) {
  const p = getPool(settings);
  await p.query(
    `INSERT INTO event_chains (from_event_id, to_event_id, chain_type, description) VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [fromEventId, toEventId, chainType || "caused", description || ""],
  ).catch(() => {});
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
  let plotId;
  if (existing.length > 0) {
    plotId = existing[0].id;
    await p.query(
      `UPDATE plot_threads SET thread_type = $2, description = $3, involved_chars = $4, resolved_at = $5, importance = $6, updated_at = NOW() WHERE id = $1`,
      [plotId, threadType || "pending", description || "", involvedChars || [], resolvedAt || null, importance || 3],
    );
  } else {
    plotId = `plot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    await p.query(
      `INSERT INTO plot_threads (id, chat_id, thread_type, title, description, involved_chars, planted_at, resolved_at, importance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [plotId, chatId, threadType || "pending", title, description || "", involvedChars || [], plantedAt || null, resolvedAt || null, importance || 3],
    );
  }

  // Link to characters (ensure they exist first)
  for (const charName of (involvedChars || [])) {
    if (!charName) continue;
    const charId = slugify(charName);
    await upsertCharacter(settings, { name: charName });
    await p.query(
      `INSERT INTO plot_thread_characters (plot_id, character_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [plotId, charId],
    ).catch(() => {});
  }

  return plotId;
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
    all_edges AS (
      -- Character relationships
      SELECT from_char as src, 'character'::text as src_type, to_char as dst, 'character'::text as dst_type
      FROM feels_about WHERE session_id = ANY($3)
      UNION ALL
      SELECT to_char, 'character', from_char, 'character'
      FROM feels_about WHERE session_id = ANY($3)
      UNION ALL
      -- Character knows facts
      SELECT k.character_id, 'character', k.fact_id, 'fact' FROM knows k
      UNION ALL
      -- Character participated in events (from this char's chats)
      SELECT pi.character_id, 'character', pi.event_id, 'event'
      FROM participated_in pi
      JOIN events e ON e.id = pi.event_id WHERE e.chat_id = ANY($3)
      UNION ALL
      SELECT pi.event_id, 'event', pi.character_id, 'character'
      FROM participated_in pi
      JOIN events e ON e.id = pi.event_id WHERE e.chat_id = ANY($3)
      UNION ALL
      -- Events at locations
      SELECT e.id, 'event', e.location_id, 'location'
      FROM events e WHERE e.chat_id = ANY($3) AND e.location_id IS NOT NULL
      UNION ALL
      -- Characters own items
      SELECT i.owner_id, 'character', i.id, 'item' FROM items i WHERE i.owner_id IS NOT NULL
      UNION ALL
      -- Items at locations
      SELECT i.id, 'item', i.location_id, 'location' FROM items i WHERE i.location_id IS NOT NULL
      UNION ALL
      -- Characters involved in plot threads
      SELECT ptc.character_id, 'character', ptc.plot_id, 'plot_thread'
      FROM plot_thread_characters ptc
      JOIN plot_threads pt ON pt.id = ptc.plot_id WHERE pt.chat_id = ANY($3)
      UNION ALL
      -- Events in story arcs
      SELECT ae.event_id, 'event', ae.arc_id, 'story_arc'
      FROM arc_events ae
      JOIN story_arcs sa ON sa.id = ae.arc_id WHERE sa.chat_id = ANY($3)
      UNION ALL
      SELECT ae.arc_id, 'story_arc', ae.event_id, 'event'
      FROM arc_events ae
      JOIN story_arcs sa ON sa.id = ae.arc_id WHERE sa.chat_id = ANY($3)
      UNION ALL
      -- Event causal chains
      SELECT ec.from_event_id, 'event', ec.to_event_id, 'event'
      FROM event_chains ec
      JOIN events e1 ON e1.id = ec.from_event_id
      WHERE e1.chat_id = ANY($3)
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
  const itemIds = rows.filter((r) => r.node_type === "item").map((r) => r.node_id);
  const plotIds = rows.filter((r) => r.node_type === "plot_thread").map((r) => r.node_id);
  const arcIds = rows.filter((r) => r.node_type === "story_arc").map((r) => r.node_id);

  if (charIds.length > 0) {
    const { rows: chars } = await p.query(`SELECT * FROM characters WHERE id = ANY($1)`, [charIds]);
    for (const c of chars) nodes.push({ id: c.id, label: c.name, type: "character", metadata: c });
  }
  if (factIds.length > 0) {
    const { rows: fs } = await p.query(`SELECT * FROM facts WHERE id = ANY($1)`, [factIds]);
    for (const f of fs) nodes.push({ id: f.id, label: (f.content || "").slice(0, 60), type: "fact", metadata: f });
  }
  if (eventIds.length > 0) {
    const { rows: es } = await p.query(`SELECT * FROM events WHERE id = ANY($1)`, [eventIds]);
    for (const e of es) nodes.push({ id: e.id, label: (e.summary || "").slice(0, 60), type: "event", metadata: e });
  }
  if (locIds.length > 0) {
    const { rows: ls } = await p.query(`SELECT * FROM locations WHERE id = ANY($1)`, [locIds]);
    for (const l of ls) nodes.push({ id: l.id, label: l.name, type: "location", metadata: l });
  }
  if (itemIds.length > 0) {
    const { rows: its } = await p.query(`SELECT * FROM items WHERE id = ANY($1)`, [itemIds]);
    for (const i of its) nodes.push({ id: i.id, label: i.name, type: "item", metadata: i });
  }
  if (plotIds.length > 0) {
    const { rows: pts } = await p.query(`SELECT * FROM plot_threads WHERE id = ANY($1)`, [plotIds]);
    for (const pt of pts) nodes.push({ id: pt.id, label: pt.title, type: "plot_thread", metadata: pt });
  }
  if (arcIds.length > 0) {
    const { rows: arcs } = await p.query(`SELECT * FROM story_arcs WHERE id = ANY($1)`, [arcIds]);
    for (const arc of arcs) nodes.push({ id: arc.id, label: arc.title, type: "story_arc", metadata: arc });
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
    const { rows: partRows } = await p.query(
      `SELECT pi.character_id, pi.event_id, pi.role
       FROM participated_in pi
       JOIN events e ON e.id = pi.event_id
       WHERE pi.character_id = ANY($1) AND pi.event_id = ANY($2) AND e.chat_id = ANY($3)`,
      [charIds, eventIds, chatIds],
    );
    for (const pr of partRows) {
      edges.push({ id: `pi-${pr.character_id}-${pr.event_id}`, source: pr.character_id, target: pr.event_id,
        type: "PARTICIPATED_IN", label: pr.role || "participated", sentiment: 0, intensity: 0.5 });
    }
  }

  // Event location edges
  if (eventIds.length > 0 && locIds.length > 0) {
    const { rows: elocs } = await p.query(
      `SELECT id, location_id FROM events WHERE id = ANY($1) AND location_id = ANY($2)`,
      [eventIds, locIds],
    );
    for (const e of elocs) {
      edges.push({ id: `at-${e.id}-${e.location_id}`, source: e.id, target: e.location_id,
        type: "OCCURRED_AT", label: "at", sentiment: 0, intensity: 0.3 });
    }
  }

  // Item ownership
  if (itemIds.length > 0) {
    const { rows: its } = await p.query(
      `SELECT id, owner_id, location_id FROM items WHERE id = ANY($1)`, [itemIds],
    );
    for (const it of its) {
      if (it.owner_id) edges.push({ id: `own-${it.owner_id}-${it.id}`, source: it.owner_id, target: it.id,
        type: "OWNS", label: "owns", sentiment: 0, intensity: 0.4 });
      if (it.location_id) edges.push({ id: `at-${it.id}-${it.location_id}`, source: it.id, target: it.location_id,
        type: "LOCATED_AT", label: "located at", sentiment: 0, intensity: 0.3 });
    }
  }

  // Plot thread links
  if (plotIds.length > 0 && charIds.length > 0) {
    const { rows: pts } = await p.query(
      `SELECT plot_id, character_id FROM plot_thread_characters WHERE plot_id = ANY($1) AND character_id = ANY($2)`,
      [plotIds, charIds],
    );
    for (const pt of pts) {
      edges.push({ id: `pt-${pt.character_id}-${pt.plot_id}`, source: pt.character_id, target: pt.plot_id,
        type: "INVOLVED_IN", label: "involved in", sentiment: 0, intensity: 0.4 });
    }
  }

  // Arc containment
  if (arcIds.length > 0 && eventIds.length > 0) {
    const { rows: aes } = await p.query(
      `SELECT arc_id, event_id, is_anchor FROM arc_events WHERE arc_id = ANY($1) AND event_id = ANY($2)`,
      [arcIds, eventIds],
    );
    for (const ae of aes) {
      edges.push({ id: `ae-${ae.arc_id}-${ae.event_id}`, source: ae.arc_id, target: ae.event_id,
        type: "CONTAINS_EVENT", label: ae.is_anchor ? "anchor" : "contains",
        sentiment: 0, intensity: ae.is_anchor ? 0.9 : 0.5, isAnchor: ae.is_anchor });
    }
  }

  // Event chains
  if (eventIds.length > 0) {
    const { rows: chs } = await p.query(
      `SELECT ec.from_event_id, ec.to_event_id, ec.chain_type, ec.description
       FROM event_chains ec
       JOIN events e ON e.id = ec.from_event_id
       WHERE ec.from_event_id = ANY($1) AND ec.to_event_id = ANY($1) AND e.chat_id = ANY($2)`,
      [eventIds, chatIds],
    );
    for (const c of chs) {
      edges.push({ id: `ch-${c.from_event_id}-${c.to_event_id}`, source: c.from_event_id, target: c.to_event_id,
        type: "CAUSED", label: c.chain_type || "caused", description: c.description,
        sentiment: 0, intensity: 0.7 });
    }
  }

  return { nodes, edges };
}

async function getGraphData(settings, { scope, character }) {
  const p = getPool(settings);
  const nodes = [];
  const edges = [];
  const connectedIds = new Set();

  // All edge types
  const { rows: rels } = await p.query(
    `SELECT fa.from_char, fa.to_char, fa.sentiment, fa.intensity, fa.description FROM feels_about fa`,
  );
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

  const { rows: parts } = await p.query(
    `SELECT character_id, event_id, role FROM participated_in`,
  );
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

  // Items: OWNED by characters + LOCATED_AT locations
  const { rows: itemOwners } = await p.query(
    `SELECT id, name, owner_id, location_id FROM items WHERE owner_id IS NOT NULL OR location_id IS NOT NULL`,
  );
  for (const it of itemOwners) {
    connectedIds.add(it.id);
    if (it.owner_id) {
      connectedIds.add(it.owner_id);
      edges.push({
        id: `own-${it.owner_id}-${it.id}`,
        source: it.owner_id, target: it.id,
        type: "OWNS", label: "owns",
        sentiment: 0, intensity: 0.4,
      });
    }
    if (it.location_id) {
      connectedIds.add(it.location_id);
      edges.push({
        id: `at-${it.id}-${it.location_id}`,
        source: it.id, target: it.location_id,
        type: "LOCATED_AT", label: "located at",
        sentiment: 0, intensity: 0.3,
      });
    }
  }

  // Events at locations
  const { rows: evtLocs } = await p.query(
    `SELECT id, location_id FROM events WHERE location_id IS NOT NULL`,
  );
  for (const e of evtLocs) {
    connectedIds.add(e.id);
    connectedIds.add(e.location_id);
    edges.push({
      id: `at-${e.id}-${e.location_id}`,
      source: e.id, target: e.location_id,
      type: "OCCURRED_AT", label: "at",
      sentiment: 0, intensity: 0.3,
    });
  }

  // Plot threads: linked to characters
  const { rows: plotChars } = await p.query(
    `SELECT plot_id, character_id FROM plot_thread_characters`,
  );
  for (const pc of plotChars) {
    connectedIds.add(pc.plot_id);
    connectedIds.add(pc.character_id);
    edges.push({
      id: `pt-${pc.character_id}-${pc.plot_id}`,
      source: pc.character_id, target: pc.plot_id,
      type: "INVOLVED_IN", label: "involved in",
      sentiment: 0, intensity: 0.4,
    });
  }

  // Story arcs: linked to their member events
  const { rows: arcEvents } = await p.query(
    `SELECT ae.arc_id, ae.event_id, ae.is_anchor FROM arc_events ae`,
  );
  for (const ae of arcEvents) {
    connectedIds.add(ae.arc_id);
    connectedIds.add(ae.event_id);
    edges.push({
      id: `ae-${ae.arc_id}-${ae.event_id}`,
      source: ae.arc_id, target: ae.event_id,
      type: "CONTAINS_EVENT",
      label: ae.is_anchor ? "anchor event" : "contains",
      sentiment: 0, intensity: ae.is_anchor ? 0.9 : 0.5,
      isAnchor: ae.is_anchor,
    });
  }

  // Event chains: causal links between events
  const { rows: chains } = await p.query(
    `SELECT from_event_id, to_event_id, chain_type, description FROM event_chains`,
  );
  for (const c of chains) {
    connectedIds.add(c.from_event_id);
    connectedIds.add(c.to_event_id);
    edges.push({
      id: `ch-${c.from_event_id}-${c.to_event_id}`,
      source: c.from_event_id, target: c.to_event_id,
      type: "CAUSED", label: c.chain_type || "caused",
      description: c.description,
      sentiment: 0, intensity: 0.7,
    });
  }

  // Hydrate all nodes
  if (connectedIds.size > 0) {
    const idArray = [...connectedIds];

    const { rows: chars } = await p.query(`SELECT * FROM characters WHERE id = ANY($1)`, [idArray]);
    for (const c of chars) nodes.push({ id: c.id, label: c.name, type: "character", metadata: c });

    const { rows: locs } = await p.query(`SELECT * FROM locations WHERE id = ANY($1)`, [idArray]);
    for (const l of locs) nodes.push({ id: l.id, label: l.name, type: "location", metadata: l });

    const { rows: evts } = await p.query(`SELECT * FROM events WHERE id = ANY($1)`, [idArray]);
    for (const e of evts) nodes.push({ id: e.id, label: (e.summary || "").slice(0, 60), type: "event", metadata: e });

    const { rows: its } = await p.query(`SELECT * FROM items WHERE id = ANY($1)`, [idArray]);
    for (const i of its) nodes.push({ id: i.id, label: i.name, type: "item", metadata: i });

    const { rows: pts } = await p.query(`SELECT * FROM plot_threads WHERE id = ANY($1)`, [idArray]);
    for (const pt of pts) nodes.push({ id: pt.id, label: pt.title, type: "plot_thread", metadata: pt });

    const { rows: arcs } = await p.query(`SELECT * FROM story_arcs WHERE id = ANY($1)`, [idArray]);
    for (const arc of arcs) nodes.push({ id: arc.id, label: arc.title, type: "story_arc", metadata: arc });
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
  upsertStoryArc, linkEventToArc, createEventChain,
  storeEmbedding, vectorSearch, vectorSearchScoped,
  getRelationships, getKnowledgeBoundaries, getRecentEvents, getWorldState,
  getGraphData, traverseFromCharacter, getCharacterMemoryConfig, saveCharacterMemoryConfig, closePool,
};
