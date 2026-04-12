// ChronicleDB Mind Map — Cytoscape.js interactive visualization
// Polished Moonlit Echoes themed UI with character picker sidebar

// ── API base detection ──────────────────────────────────────────
const IS_ST_PLUGIN = window.location.pathname.includes("/api/plugins/chronicle-db");
const API_BASE = IS_ST_PLUGIN
  ? `${window.location.origin}/api/plugins/chronicle-db`
  : window.location.origin;

// All fetches include credentials for ST auth cookies
const fetchOpts = { credentials: "include" };

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

// ── State ───────────────────────────────────────────────────────
let cy = null;
let allData = { nodes: [], edges: [] };
let activeCharacter = null;        // currently selected in sidebar
let characterNames = [];           // list from API
let activeEdgeTypes = new Set(["FEELS_ABOUT", "KNOWS", "LOCATED_AT"]);

// ── Cytoscape initialization ────────────────────────────────────

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
          "font-family": "'Inter', sans-serif",
          color: "#c4cee4",
          "text-margin-y": 7,
          "background-color": "#58a6ff",
          width: 36,
          height: 36,
          "border-width": 2,
          "border-color": "rgba(100, 130, 220, 0.2)",
          "text-outline-width": 2,
          "text-outline-color": "#0a0e1a",
          "transition-property": "opacity, border-color, border-width, width, height",
          "transition-duration": "0.25s",
        },
      },
      // Character nodes — larger, with avatar images
      {
        selector: "node[type='character']",
        style: {
          "background-color": NODE_COLORS.character,
          "background-image": "data(avatarUrl)",
          "background-fit": "cover",
          "background-clip": "node",
          width: 48,
          height: 48,
          "font-size": "12px",
          "font-weight": "bold",
          shape: "ellipse",
          "border-width": 2,
          "border-color": "rgba(88, 166, 255, 0.4)",
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
      // Location nodes — green rounded-rect
      {
        selector: "node[type='location']",
        style: {
          "background-color": NODE_COLORS.location,
          shape: "round-rectangle",
          width: 42,
          height: 28,
          "font-size": "10px",
          "border-color": "rgba(63, 185, 80, 0.3)",
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
          "border-color": "rgba(210, 168, 255, 0.3)",
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
          "border-color": "rgba(240, 136, 62, 0.3)",
        },
      },
      // Fact nodes — small gray
      {
        selector: "node[type='fact']",
        style: {
          "background-color": NODE_COLORS.fact,
          width: 20,
          height: 20,
          "font-size": "8px",
          color: "#5a6580",
          "border-color": "rgba(139, 148, 158, 0.2)",
        },
      },
      // Default edge style
      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.8,
          "line-color": "rgba(100, 130, 220, 0.2)",
          "target-arrow-color": "rgba(100, 130, 220, 0.2)",
          width: 1.5,
          label: "data(label)",
          "font-size": "8px",
          "font-family": "'Inter', sans-serif",
          color: "#5a6580",
          "text-rotation": "autorotate",
          "text-outline-width": 1.5,
          "text-outline-color": "#0a0e1a",
          "transition-property": "opacity, line-color, width",
          "transition-duration": "0.25s",
        },
      },
      // FEELS_ABOUT — positive
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment > 0.3]",
        style: {
          "line-color": SENTIMENT_COLORS.positive,
          "target-arrow-color": SENTIMENT_COLORS.positive,
          width: "mapData(intensity, 0, 1, 1, 5)",
        },
      },
      // FEELS_ABOUT — negative
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment < -0.3]",
        style: {
          "line-color": SENTIMENT_COLORS.negative,
          "target-arrow-color": SENTIMENT_COLORS.negative,
          width: "mapData(intensity, 0, 1, 1, 5)",
          "line-style": "dashed",
        },
      },
      // FEELS_ABOUT — neutral
      {
        selector: "edge[type='FEELS_ABOUT'][sentiment >= -0.3][sentiment <= 0.3]",
        style: {
          "line-color": SENTIMENT_COLORS.neutral,
          "target-arrow-color": SENTIMENT_COLORS.neutral,
          width: "mapData(intensity, 0, 1, 1, 3)",
        },
      },
      // Highlight on select/active
      {
        selector: "node:active, node:selected",
        style: {
          "border-color": "#7c6af5",
          "border-width": 3,
          "overlay-color": "#7c6af5",
          "overlay-opacity": 0.12,
        },
      },
      // Dimmed (filtering)
      {
        selector: ".dimmed",
        style: {
          opacity: 0.1,
        },
      },
      // Search highlight
      {
        selector: ".search-match",
        style: {
          "border-color": "#e3b341",
          "border-width": 4,
          "overlay-color": "#e3b341",
          "overlay-opacity": 0.15,
        },
      },
      // Neighbor highlight for character picker
      {
        selector: ".neighbor-highlight",
        style: {
          "border-color": "#7c6af5",
          "border-width": 3,
          "overlay-color": "#7c6af5",
          "overlay-opacity": 0.08,
        },
      },
    ],
    layout: { name: "preset" },
    minZoom: 0.1,
    maxZoom: 5,
    wheelSensitivity: 0.3,
  });

  // ── Node tap -> detail panel ────────────────────────────────
  cy.on("tap", "node", function (evt) {
    showDetailPanel(evt.target.data());
  });

  // ── Edge tap -> edge detail ─────────────────────────────────
  cy.on("tap", "edge", function (evt) {
    showEdgeDetail(evt.target.data());
  });

  // ── Background tap -> close panel ──────────────────────────
  cy.on("tap", function (evt) {
    if (evt.target === cy) {
      hideDetailPanel();
    }
  });

  // ── Hover -> highlight neighborhood ────────────────────────
  cy.on("mouseover", "node", function (evt) {
    const neighborhood = evt.target.closedNeighborhood();
    cy.elements().not(neighborhood).addClass("dimmed");
  });

  cy.on("mouseout", "node", function () {
    cy.elements().removeClass("dimmed");
    // Re-apply character filter if active
    if (activeCharacter) {
      applyCharacterFilter(activeCharacter);
    }
  });
}

// ── Data loading ────────────────────────────────────────────────

async function loadGraphData(scope, params) {
  scope = scope || "global";
  params = params || {};
  showLoading(true);

  const url = new URL(`${API_BASE}/graph`);
  url.searchParams.set("scope", scope);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  try {
    const res = await fetch(url, fetchOpts);
    if (!res.ok) throw new Error("API error: " + res.status);
    const data = await res.json();
    allData = data;
    renderGraph(data);
  } catch (err) {
    console.error("Failed to load graph data:", err);
  } finally {
    showLoading(false);
  }
}

function renderGraph(data) {
  cy.elements().remove();

  var elements = [];

  for (var i = 0; i < data.nodes.length; i++) {
    var node = data.nodes[i];
    var avatarUrl = node.type === "character"
      ? "/characters/" + encodeURIComponent(node.label || node.id) + ".png"
      : "";

    elements.push({
      group: "nodes",
      data: Object.assign({
        id: node.id,
        label: node.label || node.id,
        type: node.type,
        isPC: (node.metadata && node.metadata.is_player_character) || false,
        avatarUrl: avatarUrl,
        timestamp: (node.metadata && node.metadata.timestamp) || null,
      }, node.metadata || {}),
    });
  }

  for (var j = 0; j < data.edges.length; j++) {
    var edge = data.edges[j];
    elements.push({
      group: "edges",
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edge.type,
        label: edge.label || edge.type,
        sentiment: edge.sentiment != null ? edge.sentiment : 0,
        intensity: edge.intensity != null ? edge.intensity : 0.5,
        timestamp: edge.timestamp || null,
      },
    });
  }

  cy.add(elements);
  applyEdgeFilter();
  runLayout();
}

function runLayout() {
  var layout = cy.layout({
    name: "cose",
    animate: true,
    animationDuration: 800,
    animationEasing: "ease-out",
    nodeRepulsion: 8000,
    idealEdgeLength: 120,
    edgeElasticity: 0.45,
    gravity: 0.25,
    numIter: 300,
    randomize: true,
    padding: 50,
  });
  layout.run();
}

// ── Loading spinner ─────────────────────────────────────────────

function showLoading(show) {
  var spinner = document.querySelector(".loading-spinner");
  if (show && !spinner) {
    spinner = document.createElement("div");
    spinner.className = "loading-spinner";
    spinner.innerHTML = '<div class="spinner-ring"></div><span>Loading graph...</span>';
    document.getElementById("main").appendChild(spinner);
  } else if (!show && spinner) {
    spinner.remove();
  }
}

// ── Character sidebar ───────────────────────────────────────────

async function loadCharacterList() {
  try {
    var res = await fetch(API_BASE + "/characters", fetchOpts);
    if (!res.ok) throw new Error("API error: " + res.status);
    characterNames = await res.json();
    renderCharacterSidebar(characterNames);
  } catch (err) {
    console.warn("Could not load character list:", err);
  }
}

function renderCharacterSidebar(names) {
  var list = document.getElementById("character-list");
  list.innerHTML = "";

  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var card = document.createElement("div");
    card.className = "char-card";
    card.dataset.name = name;
    card.title = name;

    // Try to load PNG avatar
    var img = document.createElement("img");
    img.className = "char-card-img";
    img.alt = name;
    img.loading = "lazy";
    img.src = "/characters/" + encodeURIComponent(name) + ".png";

    // On error, replace with initials placeholder
    img.onerror = (function (cardEl, charName) {
      return function () {
        this.remove();
        var placeholder = document.createElement("div");
        placeholder.className = "char-card-placeholder";
        placeholder.textContent = getInitials(charName);
        cardEl.prepend(placeholder);
      };
    })(card, name);

    var label = document.createElement("div");
    label.className = "char-card-name";
    label.textContent = name;

    card.appendChild(img);
    card.appendChild(label);

    // Click handler — filter graph
    card.addEventListener("click", (function (charName) {
      return function () {
        selectCharacter(charName);
      };
    })(name));

    list.appendChild(card);
  }
}

function getInitials(name) {
  return name
    .split(/[\s_-]+/)
    .slice(0, 2)
    .map(function (w) { return w.charAt(0).toUpperCase(); })
    .join("");
}

function selectCharacter(name) {
  // Toggle if clicking already-active character
  if (activeCharacter === name) {
    clearCharacterSelection();
    return;
  }

  activeCharacter = name;

  // Update sidebar highlights
  document.querySelectorAll(".char-card").forEach(function (c) {
    c.classList.toggle("active", c.dataset.name === name);
  });
  document.getElementById("btn-show-all").classList.remove("active");

  // Filter graph to character's neighborhood
  applyCharacterFilter(name);
}

function clearCharacterSelection() {
  activeCharacter = null;
  document.querySelectorAll(".char-card").forEach(function (c) {
    c.classList.remove("active");
  });
  document.getElementById("btn-show-all").classList.add("active");
  cy.elements().removeClass("dimmed").removeClass("neighbor-highlight");
}

function applyCharacterFilter(name) {
  // Find the character node
  var charNode = cy.nodes().filter(function (n) {
    var label = (n.data("label") || "").toLowerCase();
    return label === name.toLowerCase();
  });

  if (charNode.length === 0) return;

  var neighborhood = charNode.closedNeighborhood();
  cy.elements().addClass("dimmed").removeClass("neighbor-highlight");
  neighborhood.removeClass("dimmed");
  charNode.addClass("neighbor-highlight");

  // Fit view to neighborhood
  cy.animate({
    fit: { eles: neighborhood, padding: 60 },
    duration: 500,
    easing: "ease-out",
  });
}

// Show All button
document.getElementById("btn-show-all").addEventListener("click", function () {
  clearCharacterSelection();
  cy.animate({ fit: { padding: 40 }, duration: 400, easing: "ease-out" });
});

// ── Detail panel ────────────────────────────────────────────────

function showDetailPanel(data) {
  var panel = document.getElementById("detail-panel");
  var content = document.getElementById("detail-content");

  var typeColor = NODE_COLORS[data.type] || "#8b949e";
  var html = "";

  // Character avatar at top
  if (data.type === "character") {
    var imgSrc = "/characters/" + encodeURIComponent(data.label || data.id) + ".png";
    html += '<img class="detail-avatar" src="' + imgSrc + '" alt="' + (data.label || "") + '"'
      + ' onerror="this.outerHTML=\'<div class=\\\'detail-avatar-placeholder\\\'>' + getInitials(data.label || data.id) + '</div>\'">';
  }

  html += "<h2>" + (data.label || data.id) + "</h2>";
  html += '<span class="detail-type-badge" style="background:' + typeColor + '20; color:' + typeColor + '">' + data.type + "</span>";

  if (data.description) {
    html += "<h3>Description</h3><p>" + data.description + "</p>";
  }

  if (data.aliases && data.aliases.length > 0) {
    try {
      var aliasArr = typeof data.aliases === "string" ? JSON.parse(data.aliases) : data.aliases;
      if (aliasArr.length) {
        html += "<h3>Aliases</h3><p>" + aliasArr.join(", ") + "</p>";
      }
    } catch (_) { /* skip */ }
  }

  if (data.faction) {
    html += "<h3>Faction</h3><p>" + data.faction + "</p>";
  }

  // Connected edges
  var node = cy.getElementById(data.id);
  if (node.length) {
    var edges = node.connectedEdges();
    if (edges.length > 0) {
      html += "<h3>Connections (" + edges.length + ")</h3><ul>";
      edges.forEach(function (edge) {
        var edgeData = edge.data();
        var other = edge.source().id() === data.id
          ? edge.target().data("label")
          : edge.source().data("label");
        var sentClass = sentimentClass(edgeData.sentiment);
        html += "<li>" + edgeData.label + ' <span class="sentiment-badge ' + sentClass + '">' + other + "</span></li>";
      });
      html += "</ul>";
    }
  }

  content.innerHTML = html;
  panel.classList.remove("hidden");
}

function showEdgeDetail(data) {
  var panel = document.getElementById("detail-panel");
  var content = document.getElementById("detail-content");

  var sourceName = cy.getElementById(data.source).data("label") || data.source;
  var targetName = cy.getElementById(data.target).data("label") || data.target;
  var sentClass = sentimentClass(data.sentiment);

  var html = '<div class="detail-arrow">'
    + "<span>" + sourceName + "</span>"
    + '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'
    + "</svg>"
    + "<span>" + targetName + "</span>"
    + "</div>";

  html += '<span class="detail-type-badge" style="background:rgba(124,106,245,0.12); color:#7c6af5">' + data.type + "</span>";
  html += "<h3>Relationship</h3><p>" + data.label + "</p>";

  if (data.sentiment !== undefined) {
    var sentValue = Number(data.sentiment).toFixed(2);
    html += '<h3>Sentiment</h3><p><span class="sentiment-badge ' + sentClass + '">' + sentValue + "</span></p>";
  }
  if (data.intensity !== undefined) {
    var pct = (data.intensity * 100).toFixed(0);
    html += "<h3>Intensity</h3>"
      + '<div class="intensity-bar-outer">'
      + '<div class="intensity-bar-inner" style="width:' + pct + '%"></div>'
      + "</div>"
      + '<p style="margin-top:4px; font-size:11px; color:var(--text-muted)">' + pct + "%</p>";
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

// Close panel button
document.getElementById("btn-close-panel").addEventListener("click", hideDetailPanel);

// ── Edge filter chips ───────────────────────────────────────────

function initEdgeChips() {
  document.querySelectorAll(".chip[data-edge]").forEach(function (chip) {
    // Set initial state from activeEdgeTypes
    if (activeEdgeTypes.has(chip.dataset.edge)) {
      chip.classList.add("active");
    } else {
      chip.classList.remove("active");
    }

    chip.addEventListener("click", function () {
      var edgeType = chip.dataset.edge;
      if (activeEdgeTypes.has(edgeType)) {
        activeEdgeTypes.delete(edgeType);
        chip.classList.remove("active");
      } else {
        activeEdgeTypes.add(edgeType);
        chip.classList.add("active");
      }
      applyEdgeFilter();
    });
  });
}

function applyEdgeFilter() {
  if (!cy) return;
  cy.edges().forEach(function (edge) {
    if (activeEdgeTypes.has(edge.data("type"))) {
      edge.removeClass("dimmed");
    } else {
      edge.addClass("dimmed");
    }
  });
}

// ── Search ──────────────────────────────────────────────────────

document.getElementById("search-input").addEventListener("input", function (e) {
  var query = e.target.value.toLowerCase().trim();
  cy.elements().removeClass("search-match").removeClass("dimmed");

  // Re-apply character filter if active
  if (activeCharacter) {
    applyCharacterFilter(activeCharacter);
  }

  if (!query) return;

  var matches = cy.nodes().filter(function (n) {
    var label = (n.data("label") || "").toLowerCase();
    return label.includes(query);
  });

  if (matches.length > 0) {
    cy.elements().not(matches.closedNeighborhood()).addClass("dimmed");
    matches.addClass("search-match");
    cy.animate({
      fit: { eles: matches, padding: 80 },
      duration: 500,
      easing: "ease-out",
    });
  }
});

// ── Toolbar action buttons ──────────────────────────────────────

// Fit
document.getElementById("btn-fit").addEventListener("click", function () {
  cy.animate({ fit: { padding: 40 }, duration: 400, easing: "ease-out" });
});

// Export PNG
document.getElementById("btn-export").addEventListener("click", function () {
  var png = cy.png({ bg: "#0a0e1a", full: true, scale: 2 });
  var link = document.createElement("a");
  link.download = "chronicledb-mindmap.png";
  link.href = png;
  link.click();
});

// Re-layout
document.getElementById("btn-layout").addEventListener("click", function () {
  runLayout();
});

// ── Timeline slider ─────────────────────────────────────────────

document.getElementById("time-slider").addEventListener("input", function (e) {
  var pct = Number(e.target.value);
  var label = document.getElementById("time-label");

  if (pct >= 100) {
    label.textContent = "All time";
    cy.elements().removeClass("dimmed");
    applyEdgeFilter(); // re-apply edge filtering
    if (activeCharacter) applyCharacterFilter(activeCharacter);
    return;
  }

  // Try to derive a date label from node timestamps
  var allNodes = cy.nodes();
  var sorted = allNodes.sort(function (a, b) {
    return (a.data("index") || 0) - (b.data("index") || 0);
  });
  var cutoff = Math.floor((allNodes.length * pct) / 100);

  // Try to get a timestamp from the cutoff node
  var cutoffNode = sorted[cutoff];
  var ts = cutoffNode ? cutoffNode.data("timestamp") : null;
  if (ts) {
    try {
      var date = new Date(ts);
      label.textContent = date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch (_) {
      label.textContent = pct + "%";
    }
  } else {
    label.textContent = pct + "%";
  }

  sorted.forEach(function (node, i) {
    if (i <= cutoff) {
      node.removeClass("dimmed");
      node.connectedEdges().removeClass("dimmed");
    } else {
      node.addClass("dimmed");
      node.connectedEdges().addClass("dimmed");
    }
  });
});

// ── Initialize ──────────────────────────────────────────────────

initCytoscape();
initEdgeChips();
loadCharacterList();
loadGraphData("global").catch(function (err) {
  console.error("[ChronicleDB MindMap] Failed to load graph data:", err);
});
