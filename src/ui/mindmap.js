// ChronicleDB Mind Map — Cytoscape.js interactive visualization
// Runs in browser, fetches data from ChronicleDB API

const API_BASE = window.location.origin;

// ── Colors by node type ─────────────────────────────────────────
const NODE_COLORS = {
  character: "#58a6ff",
  location:  "#3fb950",
  item:      "#d2a8ff",
  event:     "#f0883e",
  fact:      "#8b949e",
  scene:     "#484f58",
  worldstate:"#e3b341",
};

const SENTIMENT_COLORS = {
  positive: "#3fb950",
  neutral:  "#8b949e",
  negative: "#f85149",
};

// ── Cytoscape instance ──────────────────────────────────────────

let cy = null;
let allData = { nodes: [], edges: [] };

function initCytoscape() {
  cy = cytoscape({
    container: document.getElementById("cy"),
    style: [
      // Default node style
      {
        selector: "node",
        style: {
          label: "data(label)",
          "text-valign": "bottom",
          "text-halign": "center",
          "font-size": "11px",
          color: "#c9d1d9",
          "text-margin-y": 6,
          "background-color": "#58a6ff",
          width: 36,
          height: 36,
          "border-width": 2,
          "border-color": "#30363d",
          "text-outline-width": 2,
          "text-outline-color": "#0d1117",
        },
      },
      // Character nodes — larger, blue
      {
        selector: "node[type='character']",
        style: {
          "background-color": NODE_COLORS.character,
          width: 48,
          height: 48,
          "font-size": "13px",
          "font-weight": "bold",
        },
      },
      // Player character — even larger, bright ring
      {
        selector: "node[?isPC]",
        style: {
          width: 56,
          height: 56,
          "border-width": 3,
          "border-color": "#f0883e",
        },
      },
      // Location nodes — green squares
      {
        selector: "node[type='location']",
        style: {
          "background-color": NODE_COLORS.location,
          shape: "round-rectangle",
          width: 40,
          height: 28,
          "font-size": "10px",
        },
      },
      // Item nodes — purple diamonds
      {
        selector: "node[type='item']",
        style: {
          "background-color": NODE_COLORS.item,
          shape: "diamond",
          width: 28,
          height: 28,
          "font-size": "10px",
        },
      },
      // Event nodes — orange hexagons
      {
        selector: "node[type='event']",
        style: {
          "background-color": NODE_COLORS.event,
          shape: "hexagon",
          width: 32,
          height: 32,
          "font-size": "9px",
        },
      },
      // Fact nodes — small gray circles
      {
        selector: "node[type='fact']",
        style: {
          "background-color": NODE_COLORS.fact,
          width: 20,
          height: 20,
          "font-size": "8px",
          color: "#6e7681",
        },
      },
      // Default edge style
      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.8,
          "line-color": "#30363d",
          "target-arrow-color": "#30363d",
          width: 1.5,
          label: "data(label)",
          "font-size": "8px",
          color: "#6e7681",
          "text-rotation": "autorotate",
          "text-outline-width": 1.5,
          "text-outline-color": "#0d1117",
        },
      },
      // FEELS_ABOUT — color by sentiment
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment > 0.3]",
        style: {
          "line-color": SENTIMENT_COLORS.positive,
          "target-arrow-color": SENTIMENT_COLORS.positive,
          width: "mapData(intensity, 0, 1, 1, 5)",
        },
      },
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment < -0.3]",
        style: {
          "line-color": SENTIMENT_COLORS.negative,
          "target-arrow-color": SENTIMENT_COLORS.negative,
          width: "mapData(intensity, 0, 1, 1, 5)",
          "line-style": "dashed",
        },
      },
      {
        selector:
          "edge[type='FEELS_ABOUT'][sentiment >= -0.3][sentiment <= 0.3]",
        style: {
          "line-color": SENTIMENT_COLORS.neutral,
          "target-arrow-color": SENTIMENT_COLORS.neutral,
          width: "mapData(intensity, 0, 1, 1, 3)",
        },
      },
      // Highlight on hover
      {
        selector: "node:active, node:selected",
        style: {
          "border-color": "#f0883e",
          "border-width": 3,
          "overlay-color": "#f0883e",
          "overlay-opacity": 0.15,
        },
      },
      // Dimmed nodes (when filtering)
      {
        selector: ".dimmed",
        style: {
          opacity: 0.15,
        },
      },
      // Search highlight
      {
        selector: ".search-match",
        style: {
          "border-color": "#e3b341",
          "border-width": 4,
          "overlay-color": "#e3b341",
          "overlay-opacity": 0.2,
        },
      },
    ],
    layout: { name: "preset" }, // we'll run layout after data loads
    minZoom: 0.1,
    maxZoom: 5,
    wheelSensitivity: 0.3,
  });

  // ── Event handlers ────────────────────────────────────────────

  // Click node → show detail panel
  cy.on("tap", "node", function (evt) {
    const node = evt.target;
    showDetailPanel(node.data());
  });

  // Click edge → show relationship detail
  cy.on("tap", "edge", function (evt) {
    const edge = evt.target;
    showEdgeDetail(edge.data());
  });

  // Click background → close panel
  cy.on("tap", function (evt) {
    if (evt.target === cy) {
      hideDetailPanel();
    }
  });

  // Hover → highlight connected
  cy.on("mouseover", "node", function (evt) {
    const node = evt.target;
    const neighborhood = node.closedNeighborhood();
    cy.elements().not(neighborhood).addClass("dimmed");
  });

  cy.on("mouseout", "node", function () {
    cy.elements().removeClass("dimmed");
  });
}

// ── Data loading ────────────────────────────────────────────────

async function loadGraphData(scope = "global", params = {}) {
  const url = new URL(`${API_BASE}/api/graph`);
  url.searchParams.set("scope", scope);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  allData = data;
  renderGraph(data);
}

function renderGraph(data) {
  cy.elements().remove();

  const elements = [];

  for (const node of data.nodes) {
    elements.push({
      group: "nodes",
      data: {
        id: node.id,
        label: node.label || node.id,
        type: node.type,
        isPC: node.metadata?.is_player_character ?? false,
        ...node.metadata,
      },
    });
  }

  for (const edge of data.edges) {
    elements.push({
      group: "edges",
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        label: edge.label || edge.type,
        sentiment: edge.sentiment ?? 0,
        intensity: edge.intensity ?? 0.5,
      },
    });
  }

  cy.add(elements);
  runLayout();
}

function runLayout() {
  const layout = cy.layout({
    name: "cose",
    animate: true,
    animationDuration: 800,
    nodeRepulsion: 8000,
    idealEdgeLength: 120,
    edgeElasticity: 0.45,
    gravity: 0.25,
    numIter: 300,
    randomize: true,
    padding: 40,
  });
  layout.run();
}

// ── Detail panel ────────────────────────────────────────────────

function showDetailPanel(data) {
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");

  let html = `<h2>${data.label || data.id}</h2>`;
  html += `<p style="color: ${NODE_COLORS[data.type] ?? "#8b949e"}; font-size: 11px; text-transform: uppercase; margin-bottom: 12px;">${data.type}</p>`;

  if (data.description) {
    html += `<p>${data.description}</p>`;
  }

  if (data.aliases && data.aliases.length > 0) {
    html += `<h3>Aliases</h3><p>${JSON.parse(data.aliases || "[]").join(", ")}</p>`;
  }

  if (data.faction) {
    html += `<h3>Faction</h3><p>${data.faction}</p>`;
  }

  // Show connected edges
  const node = cy.getElementById(data.id);
  if (node.length) {
    const edges = node.connectedEdges();
    if (edges.length > 0) {
      html += `<h3>Connections (${edges.length})</h3><ul>`;
      edges.forEach((edge) => {
        const edgeData = edge.data();
        const other =
          edge.source().id() === data.id
            ? edge.target().data("label")
            : edge.source().data("label");
        const sentClass = sentimentClass(edgeData.sentiment);
        html += `<li>${edgeData.label} <span class="sentiment-badge ${sentClass}">${other}</span></li>`;
      });
      html += `</ul>`;
    }
  }

  content.innerHTML = html;
  panel.classList.remove("hidden");
}

function showEdgeDetail(data) {
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");

  const sourceName =
    cy.getElementById(data.source).data("label") || data.source;
  const targetName =
    cy.getElementById(data.target).data("label") || data.target;
  const sentClass = sentimentClass(data.sentiment);

  let html = `<h2>${sourceName} &rarr; ${targetName}</h2>`;
  html += `<p style="color: #8b949e; font-size: 11px; text-transform: uppercase; margin-bottom: 12px;">${data.type}</p>`;
  html += `<h3>Relationship</h3>`;
  html += `<p>${data.label}</p>`;

  if (data.sentiment !== undefined) {
    html += `<p>Sentiment: <span class="sentiment-badge ${sentClass}">${data.sentiment.toFixed(2)}</span></p>`;
  }
  if (data.intensity !== undefined) {
    html += `<p>Intensity: ${(data.intensity * 100).toFixed(0)}%</p>`;
  }

  content.innerHTML = html;
  panel.classList.remove("hidden");
}

function hideDetailPanel() {
  document.getElementById("detail-panel").classList.add("hidden");
}

function sentimentClass(sentiment) {
  if (sentiment > 0.3) return "sentiment-positive";
  if (sentiment < -0.3) return "sentiment-negative";
  return "sentiment-neutral";
}

// ── Toolbar controls ────────────────────────────────────────────

async function loadCharacterList() {
  try {
    const res = await fetch(`${API_BASE}/api/characters`);
    const characters = await res.json();
    const select = document.getElementById("scope-select");

    for (const name of characters) {
      const opt = document.createElement("option");
      opt.value = `character:${name}`;
      opt.textContent = name;
      select.appendChild(opt);
    }
  } catch (err) {
    console.warn("Could not load character list:", err);
  }
}

// Scope selector
document.getElementById("scope-select").addEventListener("change", (e) => {
  const val = e.target.value;
  if (val === "global") {
    loadGraphData("global");
  } else if (val.startsWith("character:")) {
    loadGraphData("character", { character: val.split(":")[1] });
  } else if (val.startsWith("session:")) {
    loadGraphData("session", { session: val.split(":")[1] });
  }
});

// Edge type filter
document.getElementById("edge-filter").addEventListener("change", () => {
  const selected = Array.from(
    document.getElementById("edge-filter").selectedOptions,
  ).map((o) => o.value);

  cy.edges().forEach((edge) => {
    if (selected.includes(edge.data("type"))) {
      edge.removeClass("dimmed");
    } else {
      edge.addClass("dimmed");
    }
  });
});

// Search
document.getElementById("search-input").addEventListener("input", (e) => {
  const query = e.target.value.toLowerCase().trim();
  cy.elements().removeClass("search-match").removeClass("dimmed");

  if (!query) return;

  const matches = cy.nodes().filter((n) => {
    const label = (n.data("label") || "").toLowerCase();
    return label.includes(query);
  });

  if (matches.length > 0) {
    cy.elements().not(matches.closedNeighborhood()).addClass("dimmed");
    matches.addClass("search-match");
    cy.animate({
      fit: { eles: matches, padding: 80 },
      duration: 500,
    });
  }
});

// Fit button
document.getElementById("btn-fit").addEventListener("click", () => {
  cy.animate({ fit: { padding: 40 }, duration: 400 });
});

// Export PNG
document.getElementById("btn-export").addEventListener("click", () => {
  const png = cy.png({ bg: "#0d1117", full: true, scale: 2 });
  const link = document.createElement("a");
  link.download = "chronicledb-mindmap.png";
  link.href = png;
  link.click();
});

// Re-layout
document.getElementById("btn-layout").addEventListener("click", () => {
  runLayout();
});

// Timeline slider
document.getElementById("time-slider").addEventListener("input", (e) => {
  const pct = Number(e.target.value);
  const label = document.getElementById("time-label");

  if (pct >= 100) {
    label.textContent = "All time";
    cy.elements().removeClass("dimmed");
    return;
  }

  label.textContent = `${pct}%`;

  // Filter nodes by index position (rough chronological ordering)
  const allNodes = cy.nodes();
  const cutoff = Math.floor((allNodes.length * pct) / 100);
  const sorted = allNodes.sort(
    (a, b) => (a.data("index") ?? 0) - (b.data("index") ?? 0),
  );

  sorted.forEach((node, i) => {
    if (i <= cutoff) {
      node.removeClass("dimmed");
      node.connectedEdges().removeClass("dimmed");
    } else {
      node.addClass("dimmed");
      node.connectedEdges().addClass("dimmed");
    }
  });
});

// Close panel button
document
  .getElementById("btn-close-panel")
  .addEventListener("click", hideDetailPanel);

// ── Initialize ──────────────────────────────────────────────────

initCytoscape();
loadCharacterList();
loadGraphData("global");
