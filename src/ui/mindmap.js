// ChronicleDB Mind Map — Obsidian-style force graph with Shift5 aesthetic
// Dark charcoal background, coral-red highlights, fCoSE physics

// ── API base ────────────────────────────────────────────────────
const IS_ST_PLUGIN = window.location.pathname.includes("/api/plugins/chronicle-db");
const API_BASE = IS_ST_PLUGIN
  ? `${window.location.origin}/api/plugins/chronicle-db`
  : window.location.origin;

const fetchOpts = { credentials: "include" };

// ── SHIFT5 Operational palette ──────────────────────────────────
// Reduced to 4 tonal levels + accent. Hierarchy from shape/size/opacity,
// not hue. Coral reserved for PCs, arcs, and causal edges.
const COLORS = {
  bg: "#181818",

  // Signal — coral reserved for arcs and causal chains
  accent:      "#FF5841",
  accentHover: "#ff7057",
  accentDim:   "rgba(255, 88, 65, 0.2)",

  // Color-coded types — muted but distinguishable
  character:  "#e8e8e8",   // bright white — characters are the stars
  event:      "#d4a574",   // warm amber — narrative beats
  eventMajor: "#FF5841",   // coral — major beats
  location:   "#7d9a82",   // muted sage — places
  item:       "#a88b6a",   // muted tan — objects
  plot_thread:"#c77d5c",   // dusty terracotta — unresolved threads
  story_arc:  "#FF5841",   // coral — narrative containers
  fact:       "#555",      // dim grey — facts
  trait:      "#7a8aa5",   // dusty blue — traits (innate)

  // Status
  positive: "#6ac47a",
  negative: "#e05555",
  neutral:  "#7a8594",

  // Edges
  edge:        "#2c2c2c",
  edgeBright:  "#4a4a4a",
  edgeCausal:  "#FF5841",

  // Text
  text:    "#f5f5f5",
  textDim: "#6a6a6a",

  // Tonal tiers — neutral brightness levels for legend dots
  // (legacy aliases used by detail-panel rendering)
  tier1: "#f0f0f0",
  tier2: "#b8b8b8",
  tier3: "#6a6a6a",
  tier4: "#3a3a3a",
};

// ── State ───────────────────────────────────────────────────────
let cy = null;
let allData = { nodes: [], edges: [] };
let activeCharacter = null;
let activeEdgeTypes = new Set([
  "FEELS_ABOUT",
  "KNOWS",
  "PARTICIPATED_IN",
  "OCCURRED_AT",
  "OWNS",
  "LOCATED_AT",
  "INVOLVED_IN",
  "CONTAINS_EVENT",
  "CAUSED",
]);

// Map of normalized character name -> actual ST avatar filename.
// Populated from /character-cards; only names present here get an avatarUrl,
// which eliminates 404 spam for DB characters with no matching ST card.
let avatarFileByName = new Map();

function normalizeCharName(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function avatarUrlFor(name) {
  if (!name) return undefined;
  const file = avatarFileByName.get(normalizeCharName(name));
  if (!file) return undefined;
  return `${API_BASE}/character-image/${encodeURIComponent(file)}`;
}

// Register fCoSE layout if available
if (typeof cytoscape !== "undefined" && typeof cytoscapeFcose !== "undefined") {
  cytoscape.use(cytoscapeFcose);
}

// ── Cytoscape init ──────────────────────────────────────────────

function initCytoscape() {
  cy = cytoscape({
    container: document.getElementById("cy"),
    wheelSensitivity: 0.3,
    minZoom: 0.05,
    maxZoom: 8,
    style: [
      // ──────────────────────────────────────────────────────
      // DEFAULT NODE — flat dim disc, hidden label
      // ──────────────────────────────────────────────────────
      {
        selector: "node",
        style: {
          "background-color": COLORS.fact,
          "background-opacity": 0.85,
          width: "data(size)",
          height: "data(size)",
          label: "data(label)",
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 4,
          "font-size": "0px",
          "font-family": "Inter",
          "font-weight": "400",
          color: COLORS.textDim,
          "text-outline-width": 2,
          "text-outline-color": COLORS.bg,
          "text-outline-opacity": 1,
          "border-width": 0,
          "border-color": COLORS.edge,
          "transition-property":
            "opacity, border-width, border-color, width, height, font-size, background-opacity",
          "transition-duration": "0.18s",
        },
      },

      // ── Facts (tiny grey dots) ─────────────────────────────
      {
        selector: "node[type='fact']",
        style: {
          "background-color": COLORS.fact,
          "background-opacity": 0.6,
          shape: "ellipse",
        },
      },

      // ── Items (tan hexagons) ───────────────────────────────
      {
        selector: "node[type='item']",
        style: {
          "background-color": COLORS.item,
          "background-opacity": 0.9,
          shape: "hexagon",
        },
      },

      // ── Plot threads (terracotta diamonds) ─────────────────
      {
        selector: "node[type='plot_thread']",
        style: {
          "background-color": COLORS.plot_thread,
          "background-opacity": 0.9,
          shape: "diamond",
        },
      },

      // ── Locations (sage round rects) ───────────────────────
      {
        selector: "node[type='location']",
        style: {
          "background-color": COLORS.location,
          "background-opacity": 0.9,
          shape: "round-rectangle",
        },
      },

      // ── Events (amber rectangles) — minor by default ─────
      {
        selector: "node[type='event']",
        style: {
          "background-color": COLORS.event,
          "background-opacity": 0.85,
          shape: "round-rectangle",
        },
      },

      // ── MAJOR events (coral, highlighted) ──────────────────
      {
        selector: "node[type='event'][significance >= 4]",
        style: {
          "background-color": COLORS.eventMajor,
          "background-opacity": 1,
          shape: "round-rectangle",
          "border-width": 1,
          "border-color": COLORS.accentHover,
        },
      },

      // ── Characters (white ellipses with avatars) ───────────
      {
        selector: "node[type='character']",
        style: {
          "background-color": COLORS.character,
          "background-opacity": 1,
          "background-fit": "cover",
          "background-clip": "node",
          shape: "ellipse",
          "border-width": 1,
          "border-color": COLORS.edgeBright,
        },
      },
      // Only apply background-image when an avatarUrl actually exists;
      // Cytoscape fetches the URL eagerly, so an undefined value would
      // otherwise spam 404s for DB characters without matching ST cards.
      {
        selector: "node[type='character'][avatarUrl]",
        style: {
          "background-image": "data(avatarUrl)",
        },
      },

      // ── Story arcs (coral outlined rectangles) ─────────────
      {
        selector: "node[type='story_arc']",
        style: {
          "background-color": COLORS.bg,
          "background-opacity": 1,
          shape: "round-rectangle",
          "font-weight": "700",
          "border-width": 2,
          "border-color": COLORS.accent,
          "text-outline-color": COLORS.bg,
        },
      },

      // ── RP group (compound parent grouping nodes per chat_id) ─
      // Visually subdued container that fCoSE uses to cluster an RP's
      // characters, events, and arcs together so multi-RP graphs don't
      // overlap.
      {
        selector: "node[type='rp_group']",
        style: {
          shape: "round-rectangle",
          "background-color": "#222",
          "background-opacity": 0.08,
          "border-width": 1,
          "border-color": COLORS.edgeBright,
          "border-opacity": 0.5,
          "border-style": "dashed",
          label: "data(label)",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -4,
          "font-size": "6px",
          "font-weight": "500",
          color: COLORS.textDim,
          "text-outline-width": 2,
          "text-outline-color": COLORS.bg,
          padding: "18px",
          "min-width": "40px",
          "min-height": "40px",
          "z-compound-depth": "bottom",
          "events": "no",
        },
      },

      // ── Player character (coral ring) ──────────────────────
      {
        selector: "node[?isPC]",
        style: {
          "border-width": 2,
          "border-color": COLORS.accent,
        },
      },

      // ──────────────────────────────────────────────────────
      // EDGES — thin dim lines by default
      // ──────────────────────────────────────────────────────
      {
        selector: "edge",
        style: {
          "curve-style": "straight",
          "target-arrow-shape": "none",
          "line-color": COLORS.edge,
          width: 1,
          opacity: 0.7,
          "transition-property": "opacity, line-color, width",
          "transition-duration": "0.18s",
        },
      },
      // CAUSED — directional coral chains
      {
        selector: "edge[type='CAUSED']",
        style: {
          "line-color": COLORS.edgeCausal,
          "target-arrow-color": COLORS.edgeCausal,
          "target-arrow-shape": "triangle",
          "arrow-scale": 1.1,
          width: 1.5,
          opacity: 0.85,
          "curve-style": "bezier",
        },
      },
      // CONTAINS_EVENT — arc skeleton
      {
        selector: "edge[type='CONTAINS_EVENT']",
        style: {
          "line-color": COLORS.accent,
          opacity: 0.25,
          width: 1,
          "line-style": "dashed",
        },
      },
      {
        selector: "edge[type='CONTAINS_EVENT'][?isAnchor]",
        style: {
          "line-color": COLORS.accent,
          opacity: 0.9,
          width: 2,
          "line-style": "solid",
        },
      },
      // FEELS_ABOUT — status-coded (subtle)
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment > 0.3]",
        style: {
          "line-color": COLORS.positive,
          opacity: 0.55,
          width: "mapData(intensity, 0, 1, 1, 2.5)",
        },
      },
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment < -0.3]",
        style: {
          "line-color": COLORS.negative,
          opacity: 0.55,
          width: "mapData(intensity, 0, 1, 1, 2.5)",
        },
      },
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment >= -0.3][sentiment <= 0.3]",
        style: {
          "line-color": COLORS.neutral,
          opacity: 0.4,
        },
      },

      // ──────────────────────────────────────────────────────
      // INTERACTION STATES
      // ──────────────────────────────────────────────────────
      {
        selector: ".hovered",
        style: {
          "border-width": 2,
          "border-color": COLORS.accent,
          "background-opacity": 1,
          "font-size": "5px",
        },
      },
      {
        selector: ".neighbor",
        style: {
          "border-width": 1,
          "border-color": COLORS.accent,
          "background-opacity": 1,
          "font-size": "4px",
        },
      },
      {
        selector: "edge.neighbor-edge",
        style: {
          "line-color": COLORS.accent,
          opacity: 1,
          width: 1.5,
        },
      },
      {
        selector: ".dimmed",
        style: { opacity: 0.06 },
      },
      {
        selector: ".search-match",
        style: {
          "border-width": 2,
          "border-color": COLORS.accent,
          "background-opacity": 1,
          "font-size": "6px",
        },
      },
    ],
    layout: { name: "preset" },
  });

  // Tap handlers
  cy.on("tap", "node", (evt) => {
    const d = evt.target.data();
    if (d.type === "rp_group") return;
    showDetailPanel(d);
  });
  cy.on("tap", "edge", (evt) => showEdgeDetail(evt.target.data()));
  cy.on("tap", (evt) => { if (evt.target === cy) hideDetailPanel(); });

  // Hover: highlight neighborhood
  cy.on("mouseover", "node", (evt) => {
    const node = evt.target;
    const nbh = node.closedNeighborhood();
    cy.elements().not(nbh).addClass("dimmed");
    nbh.nodes().not(node).addClass("neighbor");
    nbh.edges().addClass("neighbor-edge");
    node.addClass("hovered");
  });
  cy.on("mouseout", "node", (evt) => {
    cy.elements().removeClass("dimmed neighbor hovered neighbor-edge");
    if (activeCharacter) applyCharacterFilter();
  });

  // Progressive label reveal — important nodes first, then all.
  // Font sizes halved to track the smaller icons (Bug 3).
  // RP group labels stay visible once zoomed in so an RP boundary is legible.
  cy.on("zoom", () => {
    const zoom = cy.zoom();
    const s = cy.style();
    if (zoom > 3.0) {
      s.selector("node").style({ "font-size": "4px" }).update();
      s.selector("node[type='rp_group']").style({ "font-size": "7px" }).update();
    } else if (zoom > 1.8) {
      s.selector("node").style({ "font-size": "0px" }).update();
      s.selector("node[type='character']").style({ "font-size": "4px" }).update();
      s.selector("node[type='story_arc']").style({ "font-size": "5px" }).update();
      s.selector("node[type='event'][significance >= 4]").style({ "font-size": "3px" }).update();
      s.selector("node[type='rp_group']").style({ "font-size": "6px" }).update();
    } else if (zoom > 1.0) {
      s.selector("node").style({ "font-size": "0px" }).update();
      s.selector("node[type='story_arc']").style({ "font-size": "4px" }).update();
      s.selector("node[type='rp_group']").style({ "font-size": "6px" }).update();
    } else {
      s.selector("node").style({ "font-size": "0px" }).update();
      s.selector("node[type='rp_group']").style({ "font-size": "5px" }).update();
    }
  });
}

// ── Data loading ────────────────────────────────────────────────

let activeChatFilter = "";

async function loadGraphData(scope = "global", params = {}) {
  showLoading(true);
  try {
    const url = new URL(`${API_BASE}/graph`, window.location.origin);
    url.searchParams.set("scope", scope);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    if (activeChatFilter) url.searchParams.set("chat_id", activeChatFilter);

    const res = await fetch(url, fetchOpts);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    allData = data;
    renderGraph(data);
  } catch (err) {
    console.error("[ChronicleDB] Graph load error:", err);
  } finally {
    showLoading(false);
  }
}

// Populate the chat filter dropdown from /chats. User can pick a single chat
// to scope every subsequent /graph query; "" means unscoped (all chats).
// Default selection is the most recent chat (remembered via localStorage)
// so opening the mindmap auto-scopes to the chat the user is actively
// working in. "All chats" stays available as an explicit opt-out.
async function loadChatFilterOptions() {
  const select = document.getElementById("chat-filter");
  if (!select) return;
  let chats = [];
  try {
    const res = await fetch(`${API_BASE}/chats`, fetchOpts);
    if (res.ok) chats = await res.json();
  } catch (err) {
    console.warn("[ChronicleDB] Failed to load chat filter options:", err);
  }
  for (const chat of chats) {
    const opt = document.createElement("option");
    opt.value = chat.chatId || chat.id || chat.filename || "";
    opt.textContent = chat.label || chat.chatId || chat.filename || "(unnamed)";
    select.appendChild(opt);
  }

  const remembered = localStorage.getItem("chronicledb_chat_filter");
  const validValues = new Set(Array.from(select.options).map((o) => o.value));
  if (remembered !== null && validValues.has(remembered)) {
    select.value = remembered;
  } else if (chats.length > 0) {
    select.value = chats[0].chatId || chats[0].id || chats[0].filename || "";
  }
  activeChatFilter = select.value;

  select.addEventListener("change", async () => {
    activeChatFilter = select.value;
    localStorage.setItem("chronicledb_chat_filter", activeChatFilter);
    if (activeCharacter) {
      await loadGraphData("character", { character: activeCharacter, depth: 3 });
    } else {
      await loadGraphData("global");
    }
  });
}

function renderGraph(data) {
  cy.elements().remove();

  // Build set of valid node IDs
  const nodeIds = new Set(data.nodes.map((n) => n.id));

  // Filter edges to only ones where both endpoints exist
  const validEdges = data.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  // Calculate node sizes by connection count
  const connectionCount = new Map();
  for (const e of validEdges) {
    connectionCount.set(e.source, (connectionCount.get(e.source) || 0) + 1);
    connectionCount.set(e.target, (connectionCount.get(e.target) || 0) + 1);
  }

  // ── RP grouping ──────────────────────────────────────────────
  // Characters have no chat_id of their own, so derive it from their
  // connected events/arcs (which do). Events/arcs use their own chat_id.
  // Compound parent nodes per chat_id let fCoSE cluster each RP together.
  const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
  const charChatVotes = new Map(); // charId -> Map<chatId, count>

  function voteChat(charId, chatId) {
    if (!charId || !chatId) return;
    if (!charChatVotes.has(charId)) charChatVotes.set(charId, new Map());
    const tally = charChatVotes.get(charId);
    tally.set(chatId, (tally.get(chatId) || 0) + 1);
  }

  for (const edge of validEdges) {
    if (edge.type !== "PARTICIPATED_IN" && edge.type !== "INVOLVED_IN") continue;
    const a = nodeById.get(edge.source);
    const b = nodeById.get(edge.target);
    if (!a || !b) continue;
    if (a.type === "character") voteChat(a.id, b.metadata?.chat_id);
    if (b.type === "character") voteChat(b.id, a.metadata?.chat_id);
  }

  const chatIdForChar = new Map();
  for (const [cid, tally] of charChatVotes) {
    let best = null;
    let bestN = 0;
    for (const [chat, n] of tally) {
      if (n > bestN) { best = chat; bestN = n; }
    }
    if (best) chatIdForChar.set(cid, best);
  }

  function groupIdFor(node) {
    if (node.type === "character") return chatIdForChar.get(node.id) || null;
    if (node.type === "event" || node.type === "story_arc") {
      return node.metadata?.chat_id || null;
    }
    return null;
  }

  const groupIdsUsed = new Set();
  for (const n of data.nodes) {
    const g = groupIdFor(n);
    if (g) groupIdsUsed.add(g);
  }

  const elements = [];

  for (const gid of groupIdsUsed) {
    const short = String(gid).split(/[\/\\ ]/).pop().slice(0, 48);
    elements.push({
      group: "nodes",
      data: {
        id: `rp:${gid}`,
        label: short,
        fullLabel: gid,
        type: "rp_group",
      },
    });
  }

  for (const node of data.nodes) {
    const degree = connectionCount.get(node.id) || 0;
    const isCharacter = node.type === "character";
    const isEvent = node.type === "event";
    const isArc = node.type === "story_arc";
    const significance = node.metadata?.significance || node.metadata?.importance || 3;

    // Compact sizing — roughly half of the pre-fix values to reduce
    // the visual footprint of character icons (Bug 3).
    let size;
    if (isArc) {
      size = Math.min(20, 12 + (significance - 3) * 2 + Math.log(degree + 1) * 1.2);
    } else if (isEvent) {
      if (significance >= 4) {
        size = 9 + (significance - 4) * 4;
      } else {
        size = 4 + significance * 0.7;
      }
    } else if (isCharacter) {
      size = Math.min(14, 8 + Math.log(degree + 1) * 1.2);
    } else {
      size = Math.min(6, 3 + Math.log(degree + 1) * 0.9);
    }

    // Labels: characters and story arcs always visible; events visible for significance >= 4
    const fullLabel = node.label || "";
    let canvasLabel = "";
    if (isCharacter) canvasLabel = fullLabel;
    else if (isArc) canvasLabel = fullLabel;
    else if (isEvent && significance >= 4) canvasLabel = (fullLabel || "").slice(0, 30);

    const gid = groupIdFor(node);

    const nodeData = {
      ...node.metadata,
      id: node.id,
      label: canvasLabel,
      fullLabel: fullLabel,
      type: node.type,
      size,
      degree,
      significance,
      isPC: node.metadata?.is_player_character ?? false,
      avatarUrl: isCharacter ? avatarUrlFor(fullLabel) : undefined,
    };
    if (gid) nodeData.parent = `rp:${gid}`;

    elements.push({ group: "nodes", data: nodeData });
  }

  for (const edge of validEdges) {
    elements.push({
      group: "edges",
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        label: edge.label || "",
        sentiment: edge.sentiment ?? 0,
        intensity: edge.intensity ?? 0.5,
      },
    });
  }

  cy.add(elements);
  runLayout();
}

function runLayout() {
  // gravityCompound + gravityRangeCompound tuned so fCoSE pulls each
  // rp_group's children tight and pushes different groups apart.
  const layoutConfig = cytoscape("layout", "fcose")
    ? {
        name: "fcose",
        quality: "default",
        animate: true,
        animationDuration: 800,
        randomize: true,
        nodeRepulsion: 6000,
        idealEdgeLength: 80,
        edgeElasticity: 0.45,
        gravity: 0.35,
        gravityCompound: 1.5,
        gravityRangeCompound: 3.0,
        nestingFactor: 0.1,
        numIter: 2500,
        tile: true,
        packComponents: true,
        padding: 60,
      }
    : {
        name: "cose",
        animate: true,
        animationDuration: 800,
        nodeRepulsion: 8000,
        idealEdgeLength: 80,
        edgeElasticity: 0.45,
        gravity: 0.35,
        numIter: 2500,
        padding: 60,
      };

  const layout = cy.layout(layoutConfig);
  layout.on("layoutstop", () => {
    // Force initial label state based on current zoom
    cy.emit("zoom");
  });
  layout.run();
}

function showLoading(visible) {
  let el = document.getElementById("chronicle-loading");
  if (!el) {
    el = document.createElement("div");
    el.id = "chronicle-loading";
    el.innerHTML = '<div class="spinner"></div><span>Loading graph...</span>';
    document.getElementById("main").appendChild(el);
  }
  el.style.display = visible ? "flex" : "none";
}

// ── Detail panel ────────────────────────────────────────────────

async function showDetailPanel(data) {
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");
  const title = data.fullLabel || data.label || data.id;

  let html = "";
  if (data.type === "character") {
    const avatarUrl = avatarUrlFor(title);
    if (avatarUrl) {
      html += `<div class="detail-avatar"><img src="${avatarUrl}" onerror="this.style.display='none'; this.parentElement.classList.add('no-img');"></div>`;
    } else {
      html += `<div class="detail-avatar no-img"></div>`;
    }
  }
  html += `<h2>${escapeHtml(title)}</h2>`;
  html += `<div class="detail-type">${data.type || "node"}</div>`;

  if (data.description) html += `<p class="detail-desc">${escapeHtml(data.description)}</p>`;
  if (data.content && data.type === "fact") html += `<p class="detail-desc">${escapeHtml(data.content)}</p>`;
  if (data.summary && data.type === "event") html += `<p class="detail-desc">${escapeHtml(data.summary)}</p>`;
  if (data.role) html += `<div class="detail-row"><span class="detail-key">Role</span><span class="detail-val">${escapeHtml(data.role)}</span></div>`;
  if (data.status) html += `<div class="detail-row"><span class="detail-key">Status</span><span class="detail-val">${escapeHtml(data.status)}</span></div>`;
  if (data.significance) html += `<div class="detail-row"><span class="detail-key">Significance</span><span class="detail-val">${data.significance}/5</span></div>`;
  if (data.degree !== undefined) html += `<div class="detail-row"><span class="detail-key">Connections</span><span class="detail-val">${data.degree}</span></div>`;

  // Connected nodes — grouped by edge type
  const node = cy.getElementById(data.id);
  if (node.length) {
    const edges = node.connectedEdges();
    if (edges.length > 0) {
      // Group by edge type, dedupe by (type, neighbor_id)
      // Prevents showing "Antagonist" twice when feels_about exists both directions
      const groups = new Map();
      const seenByType = new Map(); // type -> Set<neighborId>
      edges.forEach((edge) => {
        const ed = edge.data();
        const otherId = edge.source().id() === data.id ? edge.target().id() : edge.source().id();
        const otherNode = cy.getElementById(otherId);
        if (!otherNode.length) return;

        if (!seenByType.has(ed.type)) seenByType.set(ed.type, new Set());
        const seenSet = seenByType.get(ed.type);
        if (seenSet.has(otherId)) return; // already shown this neighbor for this edge type
        seenSet.add(otherId);

        const otherData = otherNode.data();
        const otherLabel = otherData.fullLabel || otherData.label || otherData.content || otherData.summary || otherId;

        if (!groups.has(ed.type)) groups.set(ed.type, []);
        groups.get(ed.type).push({
          label: otherLabel.slice(0, 80),
          type: otherData.type,
          sentiment: ed.sentiment,
          edgeLabel: ed.label,
          significance: otherData.significance || 0,
          neighborId: otherId,
        });
      });

      // Sort PARTICIPATED_IN events by significance (descending) — major events first
      if (groups.has("PARTICIPATED_IN")) {
        groups.get("PARTICIPATED_IN").sort((a, b) => (b.significance || 0) - (a.significance || 0));
      }

      const typeDisplayNames = {
        FEELS_ABOUT: "Relationships",
        KNOWS: "Knows",
        PARTICIPATED_IN: "Events",
        WITNESSED: "Witnessed",
        LOCATED_AT: "Locations",
      };

      for (const [edgeType, items] of groups) {
        html += `<h3>${typeDisplayNames[edgeType] || edgeType} <span class="detail-count">${items.length}</span></h3>`;
        html += `<ul class="detail-list">`;
        // Limit to first 15 to avoid flooding
        const shown = items.slice(0, 15);
        for (const it of shown) {
          const sentClass = sentimentClass(it.sentiment);
          // Tiered neutral dots — differentiation via brightness, not hue
          const dotColor =
            it.type === "character"   ? COLORS.tier1 :
            it.type === "story_arc"   ? COLORS.accent :
            it.type === "event"       ? COLORS.tier2 :
            it.type === "location"    ? COLORS.tier2 :
            it.type === "item"        ? COLORS.tier3 :
            it.type === "plot_thread" ? COLORS.tier3 :
            it.type === "fact"        ? COLORS.tier4 :
            COLORS.tier3;
          // Mark high-significance events as "major" — coral left border
          const isMajor = edgeType === "PARTICIPATED_IN" && (it.significance || 0) >= 4;
          const liClass = `${sentClass}${isMajor ? " major-event" : ""}`;
          html += `<li class="${liClass}"><span class="detail-dot" style="background:${dotColor}"></span><span class="detail-item-label">${escapeHtml(it.label)}</span></li>`;
        }
        if (items.length > 15) {
          html += `<li class="detail-more">+ ${items.length - 15} more</li>`;
        }
        html += `</ul>`;
      }
    }

    // ── Story Arcs section (character nodes) ─────────────────────
    // Find arcs in the graph that contain any of this character's events
    if (data.type === "character") {
      const charEventIds = new Set();
      node.connectedEdges().forEach((e) => {
        if (e.data("type") === "PARTICIPATED_IN") {
          const otherId = e.source().id() === data.id ? e.target().id() : e.source().id();
          const other = cy.getElementById(otherId);
          if (other.length && other.data("type") === "event") charEventIds.add(otherId);
        }
      });

      const arcs = [];
      const seenArcs = new Set();
      cy.nodes().forEach((n) => {
        if (n.data("type") !== "story_arc" || seenArcs.has(n.id())) return;
        // Does this arc contain any of the character's events?
        const containsCharEvent = n.connectedEdges().some((e) => {
          if (e.data("type") !== "CONTAINS_EVENT") return false;
          const evId = e.source().id() === n.id() ? e.target().id() : e.source().id();
          return charEventIds.has(evId);
        });
        if (containsCharEvent) {
          seenArcs.add(n.id());
          const ad = n.data();
          arcs.push({
            title: ad.fullLabel || ad.label || ad.title || n.id(),
            importance: ad.importance || 3,
          });
        }
      });

      if (arcs.length > 0) {
        arcs.sort((a, b) => (b.importance || 0) - (a.importance || 0));
        html += `<h3>Story Arcs <span class="detail-count">${arcs.length}</span></h3>`;
        html += `<ul class="detail-list">`;
        for (const arc of arcs) {
          html += `<li><span class="detail-dot" style="background:${COLORS.accent}"></span><span class="detail-item-label">${escapeHtml(arc.title)} <span class="detail-meta">★${arc.importance}</span></span></li>`;
        }
        html += `</ul>`;
      }
    }
  }

  // ── Traits section (character nodes only) ──────────────────────
  if (data.type === "character") {
    try {
      const traitUrl = new URL(`${API_BASE}/character/${encodeURIComponent(title)}/traits`, window.location.origin);
      if (activeChatFilter) traitUrl.searchParams.set("chat_id", activeChatFilter);
      const res = await fetch(traitUrl, fetchOpts);
      if (res.ok) {
        const traits = await res.json();
        if (traits.length > 0) {
          // Group by category (preserve insertion order from server's ORDER BY)
          const byCategory = {};
          for (const t of traits) {
            if (!byCategory[t.category]) byCategory[t.category] = [];
            byCategory[t.category].push(t.content);
          }
          html += `<h3>Traits <span class="detail-count">${traits.length}</span></h3>`;
          html += `<ul class="detail-list">`;
          for (const [cat, items] of Object.entries(byCategory)) {
            for (const traitContent of items) {
              const dotColor = {
                personality: "#c77d5c",
                skill: "#7d9a82",
                background: "#a88b6a",
                physical: "#b8b8b8",
                faction: "#FF5841",
              }[cat] || "#6a6a6a";
              html += `<li><span class="detail-dot" style="background:${dotColor}"></span><span class="detail-item-label">${escapeHtml(traitContent)} <span class="detail-meta">${cat}</span></span></li>`;
            }
          }
          html += `</ul>`;
        }
      }
    } catch (err) {
      console.warn("[mindmap] Failed to load traits:", err);
    }
  }

  content.innerHTML = html;
  panel.classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showEdgeDetail(data) {
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");

  const src = cy.getElementById(data.source).data("label") || data.source;
  const tgt = cy.getElementById(data.target).data("label") || data.target;
  const sentClass = sentimentClass(data.sentiment);

  let html = `<h2>${src} → ${tgt}</h2>`;
  html += `<div class="detail-type">${data.type}</div>`;
  if (data.label) html += `<p class="detail-desc">${data.label}</p>`;
  if (data.sentiment !== undefined) html += `<div class="detail-row"><span>Sentiment</span><b class="${sentClass}">${data.sentiment.toFixed(2)}</b></div>`;
  if (data.intensity !== undefined) {
    html += `<div class="detail-row"><span>Intensity</span><b>${(data.intensity * 100).toFixed(0)}%</b></div>`;
    html += `<div class="intensity-bar"><div class="intensity-bar-inner" style="width:${data.intensity * 100}%"></div></div>`;
  }

  content.innerHTML = html;
  panel.classList.remove("hidden");
}

function hideDetailPanel() {
  document.getElementById("detail-panel").classList.add("hidden");
}

function sentimentClass(s) {
  if (s > 0.3) return "sentiment-positive";
  if (s < -0.3) return "sentiment-negative";
  return "sentiment-neutral";
}

// ── Character sidebar (ST character cards) ──────────────────────

async function loadCharacterSidebar() {
  try {
    const res = await fetch(`${API_BASE}/character-cards`, fetchOpts);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const cards = await res.json();
    renderCharacterSidebar(cards);
  } catch (err) {
    console.error("[ChronicleDB] Failed to load character cards:", err);
    document.getElementById("character-list").innerHTML =
      '<div style="padding: 12px; font-size: 11px; color: #666; text-align: center;">No cards found</div>';
  }
}

function renderCharacterSidebar(cards) {
  const container = document.getElementById("character-list");
  container.innerHTML = "";

  // Rebuild the avatar filename lookup used by the graph and detail panel.
  avatarFileByName = new Map();
  for (const card of cards) {
    avatarFileByName.set(normalizeCharName(card.name), card.filename);
  }

  for (const card of cards) {
    const div = document.createElement("div");
    div.className = "char-card";
    div.dataset.name = card.name;
    div.innerHTML = `
      <img class="char-card-img" src="${API_BASE}/character-image/${encodeURIComponent(card.filename)}"
           onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
      <div class="char-card-placeholder" style="display:none;">${card.name.charAt(0).toUpperCase()}</div>
      <div class="char-card-name">${card.name}</div>
    `;
    div.addEventListener("click", () => selectCharacter(card.name));
    container.appendChild(div);
  }
}

function selectCharacter(name) {
  activeCharacter = name;
  document.querySelectorAll(".char-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.name === name);
  });
  document.getElementById("btn-show-all").classList.remove("active");

  // Load this character's neighborhood
  loadGraphData("character", { character: name, depth: 3 });
}

function clearCharacterSelection() {
  activeCharacter = null;
  document.querySelectorAll(".char-card").forEach((c) => c.classList.remove("active"));
  document.getElementById("btn-show-all").classList.add("active");
  loadGraphData("global");
}

function applyCharacterFilter() {
  if (!activeCharacter) return;
  // Additional in-graph filtering if needed
}

// ── Edge filter chips ───────────────────────────────────────────

function initEdgeChips() {
  document.querySelectorAll(".chip[data-edge]").forEach((chip) => {
    chip.addEventListener("click", () => {
      // data-edge can be comma-separated (e.g., "PARTICIPATED_IN,OCCURRED_AT")
      const types = chip.dataset.edge.split(",").map((t) => t.trim());
      const isActive = chip.classList.contains("active");
      if (isActive) {
        types.forEach((t) => activeEdgeTypes.delete(t));
        chip.classList.remove("active");
      } else {
        types.forEach((t) => activeEdgeTypes.add(t));
        chip.classList.add("active");
      }
      applyEdgeFilter();
    });
  });
}

function applyEdgeFilter() {
  cy.edges().forEach((edge) => {
    const show = activeEdgeTypes.has(edge.data("type"));
    edge.style("display", show ? "element" : "none");
  });
}

// ── Toolbar wiring ──────────────────────────────────────────────

function initToolbar() {
  document.getElementById("btn-show-all").addEventListener("click", clearCharacterSelection);
  document.getElementById("btn-fit").addEventListener("click", () => {
    cy.animate({ fit: { padding: 60 }, duration: 400 });
  });
  document.getElementById("btn-layout").addEventListener("click", runLayout);
  document.getElementById("btn-export").addEventListener("click", () => {
    const png = cy.png({ bg: COLORS.bg, full: true, scale: 2 });
    const link = document.createElement("a");
    link.download = "chronicledb-graph.png";
    link.href = png;
    link.click();
  });

  // Search
  document.getElementById("search-input").addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase().trim();
    cy.elements().removeClass("search-match dimmed");

    if (!query) return;

    const matches = cy.nodes().filter((n) => {
      const label = (n.data("label") || "").toLowerCase();
      return label.includes(query);
    });

    if (matches.length > 0) {
      cy.elements().not(matches.closedNeighborhood()).addClass("dimmed");
      matches.addClass("search-match");
      cy.animate({ fit: { eles: matches, padding: 80 }, duration: 500 });
    }
  });

  // Close detail panel
  document.getElementById("btn-close-panel").addEventListener("click", hideDetailPanel);

  // Timeline slider (basic percentage-based filter for now)
  document.getElementById("time-slider").addEventListener("input", (e) => {
    const pct = Number(e.target.value);
    const label = document.getElementById("time-label");
    if (pct >= 100) {
      label.textContent = "All time";
      cy.elements().removeClass("dimmed");
      return;
    }
    label.textContent = `${pct}%`;
  });
}

// ── Init ────────────────────────────────────────────────────────

(async function bootstrap() {
  initCytoscape();
  initEdgeChips();
  initToolbar();
  // Await sidebar load first so avatarFileByName is populated before the
  // graph renders — otherwise the first layout fires off 404s.
  await loadCharacterSidebar();
  await loadChatFilterOptions();
  await loadGraphData("global");
})();
