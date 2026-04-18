function createGraphDomain({ getPool, slugify, chatScopedId }) {
  /**
   * N-hop recursive traversal from a starting character.
   * Finds all connected entities within `depth` hops through any edge type.
   */
  async function traverseFromCharacter(settings, characterName, depth = 3, overrideChatIds) {
    const p = getPool(settings);
    const globalStartId = slugify(characterName);

    // If the caller provided an explicit chat scope (e.g. the mindmap is
    // filtering to the current chat), use it directly. Otherwise fall back to
    // discovering every chat this character has appeared in, which is the
    // "show me everything about X" behavior the standalone mindmap page wants.
    let chatIds;
    if (Array.isArray(overrideChatIds) && overrideChatIds.length > 0) {
      chatIds = overrideChatIds;
    } else {
      // Discover every chat this character has events in. Joins through
      // participated_in via either the canonical name or any alias, which
      // works for both global character rows (chr-{slug}) and the new
      // per-chat variants (chr-{chatHash}-{slug}). Whitespace is
      // collapsed on both sides so a card filename with double-spacing
      // still matches a single-spaced canonical name in the DB.
      const { rows: chats } = await p.query(
        `WITH n(target) AS (
           SELECT lower(regexp_replace(trim($1), '\\s+', ' ', 'g'))
         )
         SELECT DISTINCT e.chat_id
         FROM events e
         JOIN participated_in pi ON pi.event_id = e.id
         JOIN characters c ON c.id = pi.character_id
         CROSS JOIN n
         WHERE lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g')) = n.target
            OR EXISTS (
              SELECT 1 FROM unnest(c.aliases) a
              WHERE lower(regexp_replace(trim(a), '\\s+', ' ', 'g')) = n.target
            )`,
        [characterName],
      );
      chatIds = chats.map((c) => c.chat_id).filter(Boolean);
    }

    if (chatIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    // Resolve the requested character name to every actual character_id
    // row that matches by canonical name or alias (whitespace-tolerant).
    // Pure slugify(name) isn't enough: a name-variant merge can collapse
    // chr-foo-bar into chr-foo, leaving the raw slugify pointing at a
    // node that no longer exists and returning an empty walk. The
    // chat-scoped variants are added in case any per-chat rows exist for
    // the requested character. Duplicates are deduped.
    const { rows: idRows } = await p.query(
      `WITH n(target) AS (
         SELECT lower(regexp_replace(trim($1), '\\s+', ' ', 'g'))
       )
       SELECT DISTINCT id FROM characters c CROSS JOIN n
       WHERE lower(regexp_replace(trim(c.name), '\\s+', ' ', 'g')) = n.target
          OR EXISTS (
            SELECT 1 FROM unnest(c.aliases) a
            WHERE lower(regexp_replace(trim(a), '\\s+', ' ', 'g')) = n.target
          )`,
      [characterName],
    );
    const startIds = Array.from(new Set([
      globalStartId, // keep as ultimate fallback if no rows match
      ...idRows.map((r) => r.id),
      ...chatIds.map((cid) => chatScopedId(characterName, cid)),
    ]));

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
        -- Character knows facts (chat-scoped via knows.chat_id)
        SELECT k.character_id, 'character', k.fact_id, 'fact'
        FROM knows k WHERE k.chat_id = ANY($3)
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
        -- Characters own items (chat-scoped via items.chat_id)
        SELECT i.owner_id, 'character', i.id, 'item'
        FROM items i WHERE i.owner_id IS NOT NULL AND i.chat_id = ANY($3)
        UNION ALL
        -- Items at locations (chat-scoped)
        SELECT i.id, 'item', i.location_id, 'location'
        FROM items i WHERE i.location_id IS NOT NULL AND i.chat_id = ANY($3)
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
        SELECT unnest($1::text[]) as node_id, 'character'::text as node_type, 0 as hop
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
    `, [startIds, depth, chatIds]);

    // Hydrate the node IDs into full objects
    const nodes = [];
    const edges = [];
    const charIds = rows.filter((r) => r.node_type === "character").map((r) => r.node_id);
    const factIds = rows.filter((r) => r.node_type === "fact").map((r) => r.node_id);
    const eventIds = rows.filter((r) => r.node_type === "event").map((r) => r.node_id);
    const locIds = rows.filter((r) => r.node_type === "location").map((r) => r.node_id);
    const itemIds = rows.filter((r) => r.node_type === "item").map((r) => r.node_id);
    const plotIds = rows.filter((r) => r.node_type === "plot_thread").map((r) => r.node_id);
    const arcIds = rows.filter((r) => r.node_type === "story_arc").map((r) => r.node_id);

    // M7: every post-CTE query depends only on the id arrays above, not
    // on any earlier hydration/edge result, so they can all run on the
    // pg pool concurrently instead of serializing over a single
    // connection. The empty-guard `.length > 0` checks are kept so empty
    // arrays still short-circuit; guarded calls resolve to an empty
    // rowset without touching the pool. Order inside `nodes`/`edges`
    // does not matter to the mindmap consumer.
    const EMPTY = Promise.resolve({ rows: [] });

    const [
      charsRes,
      factsRes,
      eventsRes,
      locsRes,
      itemNodesRes,
      plotsRes,
      arcsRes,
      relsRes,
      knowsRes,
      partRowsRes,
      elocsRes,
      itemEdgesRes,
      plotEdgesRes,
      arcEdgesRes,
      chainsRes,
    ] = await Promise.all([
      // Node hydration.
      charIds.length > 0
        ? p.query(`SELECT * FROM characters WHERE id = ANY($1)`, [charIds])
        : EMPTY,
      factIds.length > 0
        ? p.query(`SELECT * FROM facts WHERE id = ANY($1)`, [factIds])
        : EMPTY,
      eventIds.length > 0
        ? p.query(`SELECT * FROM events WHERE id = ANY($1)`, [eventIds])
        : EMPTY,
      locIds.length > 0
        ? p.query(`SELECT * FROM locations WHERE id = ANY($1)`, [locIds])
        : EMPTY,
      itemIds.length > 0
        ? p.query(`SELECT * FROM items WHERE id = ANY($1)`, [itemIds])
        : EMPTY,
      plotIds.length > 0
        ? p.query(`SELECT * FROM plot_threads WHERE id = ANY($1)`, [plotIds])
        : EMPTY,
      arcIds.length > 0
        ? p.query(`SELECT * FROM story_arcs WHERE id = ANY($1)`, [arcIds])
        : EMPTY,
      // Edge queries scoped by (charIds, factIds, ..., chatIds).
      charIds.length > 0
        ? p.query(
            `SELECT from_char as source, to_char as target, sentiment, intensity, description
             FROM feels_about
             WHERE from_char = ANY($1) AND to_char = ANY($1) AND session_id = ANY($2)`,
            [charIds, chatIds],
          )
        : EMPTY,
      charIds.length > 0 && factIds.length > 0
        ? p.query(
            `SELECT character_id, fact_id FROM knows WHERE character_id = ANY($1) AND fact_id = ANY($2)`,
            [charIds, factIds],
          )
        : EMPTY,
      charIds.length > 0 && eventIds.length > 0
        ? p.query(
            `SELECT pi.character_id, pi.event_id, pi.role
             FROM participated_in pi
             JOIN events e ON e.id = pi.event_id
             WHERE pi.character_id = ANY($1) AND pi.event_id = ANY($2) AND e.chat_id = ANY($3)`,
            [charIds, eventIds, chatIds],
          )
        : EMPTY,
      eventIds.length > 0 && locIds.length > 0
        ? p.query(
            `SELECT id, location_id FROM events WHERE id = ANY($1) AND location_id = ANY($2)`,
            [eventIds, locIds],
          )
        : EMPTY,
      itemIds.length > 0
        ? p.query(
            `SELECT id, owner_id, location_id FROM items WHERE id = ANY($1)`,
            [itemIds],
          )
        : EMPTY,
      plotIds.length > 0 && charIds.length > 0
        ? p.query(
            `SELECT plot_id, character_id FROM plot_thread_characters WHERE plot_id = ANY($1) AND character_id = ANY($2)`,
            [plotIds, charIds],
          )
        : EMPTY,
      arcIds.length > 0 && eventIds.length > 0
        ? p.query(
            `SELECT arc_id, event_id, is_anchor FROM arc_events WHERE arc_id = ANY($1) AND event_id = ANY($2)`,
            [arcIds, eventIds],
          )
        : EMPTY,
      eventIds.length > 0
        ? p.query(
            `SELECT ec.from_event_id, ec.to_event_id, ec.chain_type, ec.description
             FROM event_chains ec
             JOIN events e ON e.id = ec.from_event_id
             WHERE ec.from_event_id = ANY($1) AND ec.to_event_id = ANY($1) AND e.chat_id = ANY($2)`,
            [eventIds, chatIds],
          )
        : EMPTY,
    ]);

    for (const c of charsRes.rows) nodes.push({ id: c.id, label: c.name, type: "character", metadata: c });
    for (const f of factsRes.rows) nodes.push({ id: f.id, label: (f.content || "").slice(0, 60), type: "fact", metadata: f });
    for (const e of eventsRes.rows) nodes.push({ id: e.id, label: (e.summary || "").slice(0, 60), type: "event", metadata: e });
    for (const l of locsRes.rows) nodes.push({ id: l.id, label: l.name, type: "location", metadata: l });
    for (const i of itemNodesRes.rows) nodes.push({ id: i.id, label: i.name, type: "item", metadata: i });
    for (const pt of plotsRes.rows) nodes.push({ id: pt.id, label: pt.title, type: "plot_thread", metadata: pt });
    for (const arc of arcsRes.rows) nodes.push({ id: arc.id, label: arc.title, type: "story_arc", metadata: arc });

    for (const r of relsRes.rows) {
      edges.push({ id: `fa-${r.source}-${r.target}`, source: r.source, target: r.target,
        type: "FEELS_ABOUT", label: r.description || "",
        sentiment: parseFloat(r.sentiment) || 0, intensity: parseFloat(r.intensity) || 0.5 });
    }
    for (const k of knowsRes.rows) {
      edges.push({ id: `kn-${k.character_id}-${k.fact_id}`, source: k.character_id, target: k.fact_id,
        type: "KNOWS", label: "knows", sentiment: 0, intensity: 0.3 });
    }
    for (const pr of partRowsRes.rows) {
      edges.push({ id: `pi-${pr.character_id}-${pr.event_id}`, source: pr.character_id, target: pr.event_id,
        type: "PARTICIPATED_IN", label: pr.role || "participated", sentiment: 0, intensity: 0.5 });
    }
    for (const e of elocsRes.rows) {
      edges.push({ id: `at-${e.id}-${e.location_id}`, source: e.id, target: e.location_id,
        type: "OCCURRED_AT", label: "at", sentiment: 0, intensity: 0.3 });
    }
    for (const it of itemEdgesRes.rows) {
      if (it.owner_id) edges.push({ id: `own-${it.owner_id}-${it.id}`, source: it.owner_id, target: it.id,
        type: "OWNS", label: "owns", sentiment: 0, intensity: 0.4 });
      if (it.location_id) edges.push({ id: `at-${it.id}-${it.location_id}`, source: it.id, target: it.location_id,
        type: "LOCATED_AT", label: "located at", sentiment: 0, intensity: 0.3 });
    }
    for (const pt of plotEdgesRes.rows) {
      edges.push({ id: `pt-${pt.character_id}-${pt.plot_id}`, source: pt.character_id, target: pt.plot_id,
        type: "INVOLVED_IN", label: "involved in", sentiment: 0, intensity: 0.4 });
    }
    for (const ae of arcEdgesRes.rows) {
      edges.push({ id: `ae-${ae.arc_id}-${ae.event_id}`, source: ae.arc_id, target: ae.event_id,
        type: "CONTAINS_EVENT", label: ae.is_anchor ? "anchor" : "contains",
        sentiment: 0, intensity: ae.is_anchor ? 0.9 : 0.5, isAnchor: ae.is_anchor });
    }
    for (const c of chainsRes.rows) {
      edges.push({ id: `ch-${c.from_event_id}-${c.to_event_id}`, source: c.from_event_id, target: c.to_event_id,
        type: "CAUSED", label: c.chain_type || "caused", description: c.description,
        sentiment: 0, intensity: 0.7 });
    }

    return { nodes, edges };
  }

  async function getGraphData(settings, { scope, character, chatIds }) {
    // H5a: global traversal without a chat filter previously SELECTed
    // every row in every graph table and produced multi-MB payloads for
    // users with many chats — the mindmap tab would hit the browser
    // message limit before the layout engine ran. Global is only
    // meaningful when scoped to at least one chat, so bail early.
    // /graph must include a chat_id query param; see index.js::/graph
    // handler (owned by another agent) for the route-side change.
    if (scope === "global" && (!Array.isArray(chatIds) || chatIds.length === 0)) {
      return { nodes: [], edges: [] };
    }

    const p = getPool(settings);
    const nodes = [];
    const edges = [];
    const connectedIds = new Set();

    // When chatIds is provided, every edge query is filtered by chat scope.
    // Tables that carry chat id directly: events.chat_id, feels_about.session_id,
    // plot_threads.chat_id, story_arcs.chat_id. Tables without one (participated_in,
    // plot_thread_characters, arc_events, event_chains, items) are scoped
    // indirectly by joining an in-scope table and only keeping rows whose
    // foreign ids are in the resulting set.
    const scoped = Array.isArray(chatIds) && chatIds.length > 0;

    // feels_about: direct scope via session_id
    const relsSql = scoped
      ? `SELECT from_char, to_char, sentiment, intensity, description
         FROM feels_about WHERE session_id = ANY($1::text[])`
      : `SELECT from_char, to_char, sentiment, intensity, description FROM feels_about`;
    const relsParams = scoped ? [chatIds] : [];
    const { rows: rels } = await p.query(relsSql, relsParams);
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

    // Collect the set of in-scope event ids once so every edge type keyed on
    // event_id can filter against it without an extra round-trip per query.
    let inScopeEventIds = null;
    if (scoped) {
      const { rows: evs } = await p.query(
        `SELECT id FROM events WHERE chat_id = ANY($1::text[])`,
        [chatIds],
      );
      inScopeEventIds = new Set(evs.map((r) => r.id));
    }
    const eventInScope = (id) => !scoped || inScopeEventIds.has(id);

    // participated_in: scope indirectly via events.chat_id join
    const partsSql = scoped
      ? `SELECT pi.character_id, pi.event_id, pi.role
         FROM participated_in pi
         JOIN events e ON e.id = pi.event_id
         WHERE e.chat_id = ANY($1::text[])`
      : `SELECT character_id, event_id, role FROM participated_in`;
    const { rows: parts } = await p.query(partsSql, scoped ? [chatIds] : []);
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

    // Items: directly scoped by chat_id. Legacy rows with NULL chat_id are
    // dropped under scoped mode (same pattern as feels_about.session_id).
    // Unscoped mode keeps the old behavior of showing everything with an
    // owner/location regardless of chat.
    const itemSql = scoped
      ? `SELECT id, name, owner_id, location_id FROM items
         WHERE chat_id = ANY($1::text[])
           AND (owner_id IS NOT NULL OR location_id IS NOT NULL)`
      : `SELECT id, name, owner_id, location_id FROM items
         WHERE owner_id IS NOT NULL OR location_id IS NOT NULL`;
    const { rows: itemOwners } = await p.query(itemSql, scoped ? [chatIds] : []);
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

    // Events at locations: directly scoped by events.chat_id
    const evtLocSql = scoped
      ? `SELECT id, location_id FROM events
         WHERE location_id IS NOT NULL AND chat_id = ANY($1::text[])`
      : `SELECT id, location_id FROM events WHERE location_id IS NOT NULL`;
    const { rows: evtLocs } = await p.query(evtLocSql, scoped ? [chatIds] : []);
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

    // Plot thread characters: plot_threads has chat_id so join to it
    const plotSql = scoped
      ? `SELECT ptc.plot_id, ptc.character_id
         FROM plot_thread_characters ptc
         JOIN plot_threads pt ON pt.id = ptc.plot_id
         WHERE pt.chat_id = ANY($1::text[])`
      : `SELECT plot_id, character_id FROM plot_thread_characters`;
    const { rows: plotChars } = await p.query(plotSql, scoped ? [chatIds] : []);
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

    // Story arc events: story_arcs has chat_id
    const arcSql = scoped
      ? `SELECT ae.arc_id, ae.event_id, ae.is_anchor
         FROM arc_events ae
         JOIN story_arcs sa ON sa.id = ae.arc_id
         WHERE sa.chat_id = ANY($1::text[])`
      : `SELECT ae.arc_id, ae.event_id, ae.is_anchor FROM arc_events ae`;
    const { rows: arcEvents } = await p.query(arcSql, scoped ? [chatIds] : []);
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

    // Event chains: scope by requiring both endpoints to be in-scope events.
    const { rows: chains } = await p.query(
      `SELECT from_event_id, to_event_id, chain_type, description FROM event_chains`,
    );
    for (const c of chains) {
      if (!eventInScope(c.from_event_id) || !eventInScope(c.to_event_id)) continue;
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

    // Hydrate all nodes. CRITICAL: explicit SELECT lists, never `SELECT *`.
    // characters.summary_embedding and events.embedding are 768-float vector
    // columns. With `SELECT *` they ship as ~11 KB per row in the JSON
    // payload, which on a real chat (800+ nodes) blows the response up to
    // ~10 MB and crashes the mindmap browser tab before the layout runs.
    // The mindmap UI never reads the embedding bytes — it only needs the
    // human-readable columns for tooltips / labels / coloring — so we just
    // omit them here.
    if (connectedIds.size > 0) {
      const idArray = [...connectedIds];

      const { rows: chars } = await p.query(
        `SELECT id, name, aliases, description, faction, role, status, significance, first_seen, created_at, updated_at
         FROM characters WHERE id = ANY($1)`,
        [idArray],
      );
      for (const c of chars) nodes.push({ id: c.id, label: c.name, type: "character", metadata: c });

      const { rows: locs } = await p.query(
        `SELECT id, name, description, importance, current_state, parent_location, created_at
         FROM locations WHERE id = ANY($1)`,
        [idArray],
      );
      for (const l of locs) nodes.push({ id: l.id, label: l.name, type: "location", metadata: l });

      const { rows: evts } = await p.query(
        `SELECT id, summary, source_text, significance, message_index, location_id, chat_id, timestamp, tier, condensed_summary, is_major
         FROM events WHERE id = ANY($1)`,
        [idArray],
      );
      for (const e of evts) nodes.push({ id: e.id, label: (e.summary || "").slice(0, 60), type: "event", metadata: e });

      const { rows: its } = await p.query(
        `SELECT id, name, description, powers, significance, owner_id, location_id, status, created_at, chat_id
         FROM items WHERE id = ANY($1)`,
        [idArray],
      );
      for (const i of its) nodes.push({ id: i.id, label: i.name, type: "item", metadata: i });

      const { rows: pts } = await p.query(
        `SELECT id, chat_id, thread_type, title, description, involved_chars, planted_at, resolved_at, importance, created_at, updated_at
         FROM plot_threads WHERE id = ANY($1)`,
        [idArray],
      );
      for (const pt of pts) nodes.push({ id: pt.id, label: pt.title, type: "plot_thread", metadata: pt });

      const { rows: arcs } = await p.query(
        `SELECT id, chat_id, title, description, arc_type, status, importance, start_msg_idx, end_msg_idx, spine_event_id, source, parent_arc_id, hierarchy_level, created_at, updated_at
         FROM story_arcs WHERE id = ANY($1)`,
        [idArray],
      );
      for (const arc of arcs) nodes.push({ id: arc.id, label: arc.title, type: "story_arc", metadata: arc });
    }

    return { nodes, edges };
  }

  return {
    traverseFromCharacter,
    getGraphData,
  };
}

module.exports = {
  createGraphDomain,
};
