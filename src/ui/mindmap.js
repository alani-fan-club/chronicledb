// ChronicleDB Mind Map — Obsidian-style force graph with Shift5 aesthetic
// Dark charcoal background, coral-red highlights, fCoSE physics

// ── API base ────────────────────────────────────────────────────
const IS_ST_PLUGIN = window.location.pathname.includes("/api/plugins/chronicle-db");
const API_BASE = IS_ST_PLUGIN
  ? `${window.location.origin}/api/plugins/chronicle-db`
  : window.location.origin;

const fetchOpts = { credentials: "include" };

// ── Shift5-inverted palette ─────────────────────────────────────
const COLORS = {
  bg: "#1a1a1a",
  accent: "#E8503A",        // coral red
  accentHover: "#ff6347",
  character: "#8b95a8",     // warm grey-blue
  location: "#6b8e7a",      // muted sage
  item: "#b08968",          // warm tan
  event: "#d4a574",         // warm amber
  fact: "#555",             // dim grey
  scene: "#444",
  plot_thread: "#c77d5c",   // dusty orange
  positive: "#4ade80",
  negative: "#ef4444",
  neutral: "#94a3b8",
  edge: "#3a3a3a",
  edgeBright: "#555",
  text: "#f0f0f0",
  textDim: "#666",
};

// ── State ───────────────────────────────────────────────────────
let cy = null;
let allData = { nodes: [], edges: [] };
let activeCharacter = null;
let activeEdgeTypes = new Set(["FEELS_ABOUT", "KNOWS", "LOCATED_AT"]);

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
      // Default node — small dot, Obsidian-style
      {
        selector: "node",
        style: {
          "background-color": COLORS.fact,
          width: "data(size)",
          height: "data(size)",
          label: "data(label)",
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 5,
          "font-size": "0px", // hidden by default, shown on hover/zoom
          "font-family": "Inter",
          "font-weight": "500",
          color: COLORS.text,
          "text-outline-width": 2,
          "text-outline-color": COLORS.bg,
          "border-width": 0,
          "transition-property": "opacity, border-width, border-color, width, height, font-size",
          "transition-duration": "0.2s",
        },
      },
      {
        selector: "node[type='character']",
        style: {
          "background-color": COLORS.character,
          "background-image": "data(avatarUrl)",
          "background-fit": "cover",
          "background-clip": "node",
          shape: "ellipse",
        },
      },
      {
        selector: "node[?isPC]",
        style: {
          "border-width": 2,
          "border-color": COLORS.accent,
        },
      },
      {
        selector: "node[type='location']",
        style: { "background-color": COLORS.location },
      },
      {
        selector: "node[type='item']",
        style: { "background-color": COLORS.item },
      },
      {
        selector: "node[type='event']",
        style: { "background-color": COLORS.event },
      },
      {
        selector: "node[type='fact']",
        style: { "background-color": COLORS.fact },
      },
      {
        selector: "node[type='plot_thread']",
        style: {
          "background-color": COLORS.plot_thread,
          shape: "diamond",
        },
      },
      // Edges — subtle thin lines
      {
        selector: "edge",
        style: {
          "curve-style": "straight",
          "target-arrow-shape": "none",
          "line-color": COLORS.edge,
          width: 1,
          opacity: 0.6,
          "transition-property": "opacity, line-color, width",
          "transition-duration": "0.2s",
        },
      },
      // FEELS_ABOUT edges colored by sentiment
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment > 0.3]",
        style: {
          "line-color": COLORS.positive,
          opacity: 0.5,
          width: "mapData(intensity, 0, 1, 1, 3)",
        },
      },
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment < -0.3]",
        style: {
          "line-color": COLORS.negative,
          opacity: 0.5,
          width: "mapData(intensity, 0, 1, 1, 3)",
        },
      },
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment >= -0.3][sentiment <= 0.3]",
        style: {
          "line-color": COLORS.neutral,
          opacity: 0.4,
        },
      },
      // Highlight states
      {
        selector: ".hovered",
        style: {
          "border-width": 3,
          "border-color": COLORS.accent,
          "font-size": "11px",
        },
      },
      {
        selector: ".neighbor",
        style: {
          "border-width": 2,
          "border-color": COLORS.accentHover,
          "font-size": "10px",
        },
      },
      {
        selector: "edge.neighbor-edge",
        style: {
          "line-color": COLORS.accent,
          opacity: 1,
          width: 2,
        },
      },
      {
        selector: ".dimmed",
        style: { opacity: 0.08 },
      },
      {
        selector: ".search-match",
        style: {
          "border-width": 4,
          "border-color": COLORS.accent,
          "font-size": "12px",
        },
      },
    ],
    layout: { name: "preset" },
  });

  // Tap handlers
  cy.on("tap", "node", (evt) => showDetailPanel(evt.target.data()));
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

  // Show labels on zoom in
  cy.on("zoom", () => {
    const zoom = cy.zoom();
    if (zoom > 1.2) {
      cy.style().selector("node").style({ "font-size": "10px" }).update();
    } else {
      cy.style().selector("node").style({ "font-size": "0px" }).update();
    }
  });
}

// ── Data loading ────────────────────────────────────────────────

async function loadGraphData(scope = "global", params = {}) {
  showLoading(true);
  try {
    const url = new URL(`${API_BASE}/graph`, window.location.origin);
    url.searchParams.set("scope", scope);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

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

  const elements = [];
  for (const node of data.nodes) {
    const degree = connectionCount.get(node.id) || 0;
    // Base size 8, scale up with log of connections (caps at ~40)
    const size = Math.min(40, 8 + Math.log(degree + 1) * 8);
    const isCharacter = node.type === "character";

    // Keep full label in data for detail panel, but show short label on canvas
    const fullLabel = node.label || "";
    const canvasLabel = isCharacter ? fullLabel : ""; // only characters show labels on canvas
    elements.push({
      group: "nodes",
      data: {
        id: node.id,
        label: canvasLabel,
        fullLabel: fullLabel,
        type: node.type,
        size,
        degree,
        isPC: node.metadata?.is_player_character ?? false,
        avatarUrl: isCharacter && fullLabel
          ? `${API_BASE}/character-image/${encodeURIComponent(fullLabel)}.png`
          : undefined,
        ...node.metadata,
      },
    });
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
        gravityRangeCompound: 1.5,
        nestingFactor: 0.1,
        numIter: 2500,
        tile: true,
        packComponents: true, // packs disconnected components neatly
        padding: 60,
      }
    : {
        // Fallback to cose if fcose not loaded
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

  cy.layout(layoutConfig).run();
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

function showDetailPanel(data) {
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");
  const title = data.fullLabel || data.label || data.id;

  let html = "";
  if (data.type === "character") {
    const avatarUrl = `${API_BASE}/character-image/${encodeURIComponent(title)}.png`;
    html += `<div class="detail-avatar"><img src="${avatarUrl}" onerror="this.style.display='none'; this.parentElement.classList.add('no-img');"></div>`;
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
      // Group by edge type
      const groups = new Map();
      edges.forEach((edge) => {
        const ed = edge.data();
        const otherId = edge.source().id() === data.id ? edge.target().id() : edge.source().id();
        const otherNode = cy.getElementById(otherId);
        if (!otherNode.length) return;
        const otherData = otherNode.data();
        const otherLabel = otherData.fullLabel || otherData.label || otherData.content || otherData.summary || otherId;

        if (!groups.has(ed.type)) groups.set(ed.type, []);
        groups.get(ed.type).push({
          label: otherLabel.slice(0, 80),
          type: otherData.type,
          sentiment: ed.sentiment,
          edgeLabel: ed.label,
        });
      });

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
          const dotColor = it.type === "character" ? "#8b95a8" : it.type === "event" ? "#d4a574" : it.type === "fact" ? "#666" : it.type === "location" ? "#6b8e7a" : it.type === "item" ? "#b08968" : it.type === "plot_thread" ? "#c77d5c" : "#999";
          html += `<li class="${sentClass}"><span class="detail-dot" style="background:${dotColor}"></span><span class="detail-item-label">${escapeHtml(it.label)}</span></li>`;
        }
        if (items.length > 15) {
          html += `<li class="detail-more">+ ${items.length - 15} more</li>`;
        }
        html += `</ul>`;
      }
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
      const type = chip.dataset.edge;
      if (activeEdgeTypes.has(type)) {
        activeEdgeTypes.delete(type);
        chip.classList.remove("active");
      } else {
        activeEdgeTypes.add(type);
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

(function bootstrap() {
  initCytoscape();
  initEdgeChips();
  initToolbar();
  loadCharacterSidebar();
  loadGraphData("global");
})();
