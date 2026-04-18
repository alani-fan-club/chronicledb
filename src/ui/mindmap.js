// ChronicleDB Mind Map — 3d-force-graph with bloom post-processing
// Dark charcoal background, coral-red highlights, particle nebula feel

import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
// Bloom removed — was washing out the background
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// ── API base ────────────────────────────────────────────────────
const IS_ST_PLUGIN = window.location.pathname.includes("/api/plugins/chronicle-db");
const API_BASE = IS_ST_PLUGIN
  ? `${window.location.origin}/api/plugins/chronicle-db`
  : window.location.origin;

const fetchOpts = { credentials: "include" };

// ── SHIFT5 Operational palette ──────────────────────────────────
const COLORS = {
  bg: "#181818",
  accent:      "#FF5841",
  accentHover: "#ff7057",
  accentDim:   "rgba(255, 88, 65, 0.2)",
  event:      "#d4a574",
  eventMajor: "#FF5841",
  location:   "#7d9a82",
  item:       "#a88b6a",
  plot_thread:"#c77d5c",
  story_arc:  "#FF5841",
  fact:       "#555",
  trait:      "#7a8aa5",
  positive: "#6ac47a",
  negative: "#e05555",
  neutral:  "#7a8594",
  tier1: "#f0f0f0",
  tier2: "#b8b8b8",
  tier3: "#6a6a6a",
  tier4: "#3a3a3a",
};

// ── State ───────────────────────────────────────────────────────
let allData = { nodes: [], edges: [] };
let activeCharacter = null;
let activeEdgeTypes = new Set([
  "FEELS_ABOUT", "KNOWS", "PARTICIPATED_IN", "OCCURRED_AT",
  "OWNS", "LOCATED_AT", "INVOLVED_IN",
]);
let avatarFileByName = new Map();

// Graph data structures
let graphNodes = [];     // [{id, label, fullLabel, type, degree, significance, isPC, ...metadata}]
let graphEdges = [];     // [{id, source, target, type, label, sentiment, intensity}]
let nodeById = new Map(); // id -> graphNodes index
let adjacency = new Map(); // nodeId -> [{edge, neighborId, neighborData}]

// 3d-force-graph instance
let graph = null;
let labelRenderer = null;
let charLabelObjects = []; // CSS2DObject references for cleanup
let glowTexture = null;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Edges hidden by default, shown only for hovered node's neighborhood
let hoveredNodeId = null;

// Chip edge types → which node types they control
const EDGE_TO_NODE_TYPES = {
  'PARTICIPATED_IN': ['event'],
  'OCCURRED_AT': ['event'],
  'KNOWS': ['fact'],
  'OWNS': ['item'],
  'LOCATED_AT': ['location'],
  'INVOLVED_IN': ['plot_thread'],
  'CONTAINS_EVENT': ['story_arc'],
};

// Which node types are currently visible (characters always visible)
function visibleNodeTypes() {
  const types = new Set(['character']); // always show characters
  for (const edgeType of activeEdgeTypes) {
    const nodeTypes = EDGE_TO_NODE_TYPES[edgeType];
    if (nodeTypes) nodeTypes.forEach(t => types.add(t));
  }
  return types;
}

const nodeVisFn = node => {
  const visible = visibleNodeTypes();
  return visible.has(node.type);
};


// n+2 focus: when a node is selected, dim everything outside 2-hop neighborhood
let focusedNodeId = null;
let focusNeighborhood = null; // Set of node IDs within 2 hops

function computeNeighborhood(nodeId, depth = 2) {
  const visited = new Set([nodeId]);
  let frontier = [nodeId];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const nid of frontier) {
      for (const { neighborId } of (adjacency.get(nid) || [])) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          next.push(neighborId);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

function applyFocus(nodeId) {
  focusedNodeId = nodeId;
  focusNeighborhood = nodeId ? computeNeighborhood(nodeId, 2) : null;

  for (const node of graphNodes) {
    const obj = node.__threeObj;
    if (!obj) continue;
    const sprite = obj.children[0];
    if (!sprite || !sprite.material) continue;

    if (!focusNeighborhood) {
      sprite.material.opacity = 1.0;
    } else {
      sprite.material.opacity = focusNeighborhood.has(node.id) ? 1.0 : 0.15;
    }
  }

}

const HIGHER_ORDER_EDGES = new Set(['FEELS_ABOUT', 'CONTAINS_EVENT', 'CAUSED']);
const HIGHER_ORDER_NODE_TYPES = new Set(['character', 'story_arc']);

const linkVisFn = link => {
  if (!hoveredNodeId) return false;
  const sid = typeof link.source === 'object' ? link.source.id : link.source;
  const tid = typeof link.target === 'object' ? link.target.id : link.target;
  if (!(sid === hoveredNodeId || tid === hoveredNodeId)) return false;

  const hoveredNode = graphNodes[nodeById.get(hoveredNodeId)];
  if (!hoveredNode) return false;

  // Higher-order nodes (characters, arcs): show higher-order edges only
  if (HIGHER_ORDER_NODE_TYPES.has(hoveredNode.type)) {
    return HIGHER_ORDER_EDGES.has(link.type) && activeEdgeTypes.has(link.type);
  }

  // Lower-order nodes (events, items, plots, facts, locations):
  // show their connection UP to a higher-order node
  const otherId = sid === hoveredNodeId ? tid : sid;
  const otherNode = graphNodes[nodeById.get(otherId)];
  if (!otherNode) return false;
  return HIGHER_ORDER_NODE_TYPES.has(otherNode.type);
};

// ── Utilities ───────────────────────────────────────────────────

// Duplicate of escapeHtml in ui-extension/index.js. mindmap.js is served as
// a static asset off /api/plugins/chronicle-db/map while ui-extension/index.js
// is loaded by SillyTavern from a different root, so the two cannot share
// an ESM import. ui-extension/index.js is the canonical site — keep this
// copy in sync with that one.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeCharName(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function avatarUrlFor(name) {
  if (!name) return undefined;
  const file = avatarFileByName.get(normalizeCharName(name));
  if (!file) return undefined;
  return `${API_BASE}/character-image/${encodeURIComponent(file)}`;
}

function sentimentClass(s) {
  if (s > 0.3) return "sentiment-positive";
  if (s < -0.3) return "sentiment-negative";
  return "sentiment-neutral";
}

// ── Glow texture ────────────────────────────────────────────────

function createGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.15, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.3)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  return glowTexture;
}

// ── Node color and sizing ───────────────────────────────────────

function nodeColor(type, significance, isPC) {
  if (type === 'character' && isPC) return '#e8c4a0'; // warm gold for PCs
  switch (type) {
    case 'character': return '#b8c8e0'; // pale steel blue — stars
    case 'event': return significance >= 4 ? '#c45c4a' : '#8b5e4b'; // ember / dusty rust
    case 'story_arc': return '#7b68a8'; // muted violet — nebula cores
    case 'location': return '#4a7a6a'; // deep teal — planetary
    case 'item': return '#8a7a5a'; // dim bronze — asteroids
    case 'plot_thread': return '#6a5a8a'; // dusky purple — dark matter
    case 'fact': return '#3a3a42'; // near-black with blue tint — void dust
    default: return '#3a3a3a';
  }
}

function nodePointSize(type, degree, significance, isPC) {
  if (type === 'character' && isPC) return Math.min(80, 40 + Math.log(degree + 1) * 8);
  if (type === 'character') return Math.min(55, 20 + Math.log(degree + 1) * 6);
  if (type === 'story_arc') return Math.min(18, 10 + Math.log(degree + 1) * 2);
  if (type === 'event') return significance >= 4 ? 8 : 4;
  return 3;
}

// ── Graph initialization ────────────────────────────────────────

function initGraph() {
  const container = document.getElementById('cy');

  createGlowTexture();

  // CSS2D label renderer for persistent character name labels
  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(container.clientWidth, container.clientHeight);
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.left = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  graph = ForceGraph3D({
    controlType: 'orbit',
    extraRenderers: [labelRenderer],
  })(container)
    .backgroundColor(COLORS.bg)
    .showNavInfo(false)
    // Node config
    .nodeThreeObject(node => {
      const group = new THREE.Group();

      // Glow sprite for particle nebula feel
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTexture,
          color: new THREE.Color(nodeColor(node.type, node.significance, node.isPC)),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      const s = nodePointSize(node.type, node.degree, node.significance, node.isPC);
      sprite.scale.set(s, s, 1);
      group.add(sprite);

      // Persistent character name label via CSS2DObject
      if (node.type === 'character' && node.label) {
        const div = document.createElement('div');
        div.className = 'node-label-3d';
        div.textContent = node.label;
        const labelObj = new CSS2DObject(div);
        labelObj.position.set(0, -s * 0.4, 0);
        group.add(labelObj);
        charLabelObjects.push(labelObj);
      }

      return group;
    })
    .nodeThreeObjectExtend(false)
    .nodeVisibility(nodeVisFn)
    .nodeLabel(node => `<div class="hover-label-content">${escapeHtml(node.fullLabel || node.label || node.id)}</div>`)
    .onNodeClick(node => {
      showDetailPanel(node);
      applyFocus(node.id);
      // Fly camera to node
      const dist = 150;
      graph.cameraPosition(
        { x: node.x, y: node.y, z: node.z + dist },
        node,
        1500
      );
    })
    .onBackgroundClick(() => {
      hideDetailPanel();
      applyFocus(null);
      hoveredNodeId = null;
      applyEdgeFilter();
    })
    .onNodeHover(node => {
      hoveredNodeId = node ? node.id : null;
      applyEdgeFilter();
      document.getElementById('cy').style.cursor = node ? 'pointer' : 'grab';
    })
    // Link config — hidden by default, shown only for hovered node's neighborhood
    .linkColor(link => {
      if (link.type === 'FEELS_ABOUT') {
        return link.sentiment > 0.3 ? COLORS.positive : link.sentiment < -0.3 ? COLORS.negative : COLORS.neutral;
      }
      if (link.type === 'CONTAINS_EVENT' || link.type === 'CAUSED') return COLORS.accent;
      return '#666666';
    })
    .linkOpacity(0.15)
    .linkVisibility(linkVisFn)
    .linkWidth(0.2)
    .linkDirectionalParticles(link => activeEdgeTypes.has(link.type) ? 2 : 0)
    .linkDirectionalParticleWidth(0.8)
    .linkDirectionalParticleSpeed(0.005)
    .linkDirectionalParticleColor(link => {
      if (link.type === 'FEELS_ABOUT') {
        return link.sentiment > 0.3 ? COLORS.positive : link.sentiment < -0.3 ? COLORS.negative : COLORS.neutral;
      }
      return COLORS.accent;
    })
    // Force config
    .d3AlphaDecay(0.02)
    .d3VelocityDecay(0.3)
    .warmupTicks(200)
    .cooldownTicks(0);

  // Tune forces after graph is created
  graph.d3Force('charge').strength(node => {
    if (node.type === 'character') return -250;
    if (node.type === 'story_arc') return -80; // moderate — don't push arcs to the fringe
    return -60;
  });
  graph.d3Force('charge').distanceMax(500);

  graph.d3Force('link').distance(link => {
    if (link.type === 'CONTAINS_EVENT') return 40; // short — keeps arcs near their events
    return 100;
  }).strength(link => {
    if (link.type === 'CONTAINS_EVENT') return 0.05; // gentle pull, not blob-causing
    if (link.type === 'CAUSED') return 0;
    return 0.2;
  });

  // Constrain orbit controls — prevent disorientation
  const controls = graph.controls();
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 1.2;
  controls.minDistance = 50;
  controls.maxDistance = 3000;
  controls.minPolarAngle = Math.PI * 0.25;
  controls.maxPolarAngle = Math.PI * 0.75;

  // Handle resize for label renderer
  window.addEventListener('resize', () => {
    labelRenderer.setSize(container.clientWidth, container.clientHeight);
  });
}

// ── Data loading ────────────────────────────────────────────────

async function loadGraphData(scope = "global", params = {}) {
  showLoading(true);
  try {
    // scope=global without a chat scope is an unbounded query the backend
    // hard-rejects. Render an empty graph + console hint so the user
    // sees a sensible state instead of a 400.
    if (scope === "global") {
      console.info("[ChronicleDB] Click a character on the left to load their graph.");
      allData = { nodes: [], edges: [] };
      await renderGraph(allData);
      return;
    }
    const url = new URL(`${API_BASE}/graph`, window.location.origin);
    url.searchParams.set("scope", scope);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const res = await fetch(url, fetchOpts);
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    allData = data;
    await renderGraph(data);
  } catch (err) {
    console.error("[ChronicleDB] Graph load error:", err);
  } finally {
    showLoading(false);
  }
}

// ── Graph rendering ─────────────────────────────────────────────

async function renderGraph(data) {
  // Clear old character label objects
  for (const obj of charLabelObjects) {
    if (obj.parent) obj.parent.remove(obj);
    if (obj.element && obj.element.parentNode) {
      obj.element.parentNode.removeChild(obj.element);
    }
  }
  charLabelObjects = [];

  // Build valid node set
  const nodeIds = new Set(data.nodes.map(n => n.id));
  const validEdges = data.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

  // Connection counts
  const connectionCount = new Map();
  for (const e of validEdges) {
    connectionCount.set(e.source, (connectionCount.get(e.source) || 0) + 1);
    connectionCount.set(e.target, (connectionCount.get(e.target) || 0) + 1);
  }

  // Build nodes for 3d-force-graph
  const nodes = data.nodes
    .filter(n => n.type !== 'rp_group')
    .map(n => {
      const degree = connectionCount.get(n.id) || 0;
      const significance = n.metadata?.significance || n.metadata?.importance || 3;
      const isPC = n.metadata?.is_player_character ?? false;
      return {
        ...n.metadata,
        id: n.id,
        label: n.type === 'character' ? (n.label || '') : '',
        fullLabel: n.label || '',
        type: n.type,
        degree,
        significance,
        isPC,
        avatarUrl: n.type === 'character' ? avatarUrlFor(n.label || '') : undefined,
      };
    });

  // Build links for 3d-force-graph
  const links = validEdges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: e.type,
    label: e.label || '',
    sentiment: e.sentiment ?? 0,
    intensity: e.intensity ?? 0.5,
  }));

  // Store references for detail panel and search
  graphNodes = nodes;
  graphEdges = links;
  nodeById = new Map(nodes.map((n, i) => [n.id, i]));
  adjacency = new Map();
  for (const e of links) {
    const si = nodeById.get(e.source);
    const ti = nodeById.get(e.target);
    if (si === undefined || ti === undefined) continue;
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source).push({ edge: e, neighborId: e.target, neighborData: nodes[ti] });
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.target).push({ edge: e, neighborId: e.source, neighborData: nodes[si] });
  }

  console.log(`[ChronicleDB] Feeding ${nodes.length} nodes, ${links.length} links to 3d-force-graph`);

  // Feed to 3d-force-graph — it handles layout automatically via d3-force-3d
  graph
    .graphData({ nodes, links })
    .linkVisibility(link => activeEdgeTypes.has(link.type));

  // Yield a frame so the loading spinner can dismiss
  await new Promise(r => requestAnimationFrame(r));
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
      html += `<div class="detail-avatar"><img src="${avatarUrl}" alt="Portrait of ${escapeHtml(title)}" onerror="this.style.display='none'; this.parentElement.classList.add('no-img');"></div>`;
    } else {
      html += `<div class="detail-avatar no-img"></div>`;
    }
  }
  html += `<h2>${escapeHtml(title)}</h2>`;
  html += `<div class="detail-type">${escapeHtml(data.type || "node")}</div>`;

  if (data.description) html += `<p class="detail-desc">${escapeHtml(data.description)}</p>`;
  if (data.content && data.type === "fact") html += `<p class="detail-desc">${escapeHtml(data.content)}</p>`;
  if (data.summary && data.type === "event") html += `<p class="detail-desc">${escapeHtml(data.summary)}</p>`;
  if (data.role) html += `<div class="detail-row"><span class="detail-key">Role</span><span class="detail-val">${escapeHtml(data.role)}</span></div>`;
  if (data.status) html += `<div class="detail-row"><span class="detail-key">Status</span><span class="detail-val">${escapeHtml(data.status)}</span></div>`;
  if (data.significance) html += `<div class="detail-row"><span class="detail-key">Significance</span><span class="detail-val">${data.significance}/5</span></div>`;
  if (data.degree !== undefined) html += `<div class="detail-row"><span class="detail-key">Connections</span><span class="detail-val">${data.degree}</span></div>`;

  // Connected nodes via adjacency map
  const neighbors = adjacency.get(data.id) || [];
  if (neighbors.length > 0) {
    const groups = new Map();
    const seenByType = new Map();

    for (const { edge, neighborId, neighborData } of neighbors) {
      if (!seenByType.has(edge.type)) seenByType.set(edge.type, new Set());
      const seenSet = seenByType.get(edge.type);
      if (seenSet.has(neighborId)) continue;
      seenSet.add(neighborId);

      const otherLabel = neighborData.fullLabel || neighborData.label || neighborData.content || neighborData.summary || neighborId;

      if (!groups.has(edge.type)) groups.set(edge.type, []);
      groups.get(edge.type).push({
        label: otherLabel.slice(0, 80),
        type: neighborData.type,
        sentiment: edge.sentiment,
        edgeLabel: edge.label,
        significance: neighborData.significance || 0,
        neighborId,
      });
    }

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
      html += `<h3>${escapeHtml(typeDisplayNames[edgeType] || edgeType)} <span class="detail-count">${items.length}</span></h3>`;
      html += `<ul class="detail-list">`;
      const shown = items.slice(0, 15);
      for (const it of shown) {
        const sentClass = sentimentClass(it.sentiment);
        const dotColor =
          it.type === "character"   ? COLORS.tier1 :
          it.type === "story_arc"   ? COLORS.accent :
          it.type === "event"       ? COLORS.tier2 :
          it.type === "location"    ? COLORS.tier2 :
          it.type === "item"        ? COLORS.tier3 :
          it.type === "plot_thread" ? COLORS.tier3 :
          it.type === "fact"        ? COLORS.tier4 :
          COLORS.tier3;
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
  if (data.type === "character") {
    const charEventIds = new Set();
    const myNeighbors = adjacency.get(data.id) || [];
    for (const { edge, neighborId, neighborData } of myNeighbors) {
      if (edge.type === "PARTICIPATED_IN" && neighborData.type === "event") {
        charEventIds.add(neighborId);
      }
    }

    const arcs = [];
    const seenArcs = new Set();
    for (let i = 0; i < graphNodes.length; i++) {
      const n = graphNodes[i];
      if (n.type !== 'story_arc' || seenArcs.has(n.id)) continue;

      const arcNeighbors = adjacency.get(n.id) || [];
      const containsCharEvent = arcNeighbors.some(({ edge, neighborId }) => {
        return edge.type === 'CONTAINS_EVENT' && charEventIds.has(neighborId);
      });

      if (containsCharEvent) {
        seenArcs.add(n.id);
        arcs.push({
          title: n.fullLabel || n.label || n.id,
          importance: n.importance || 3,
        });
      }
    }

    if (arcs.length > 0) {
      arcs.sort((a, b) => (b.importance || 0) - (a.importance || 0));
      html += `<h3>Story Arcs <span class="detail-count">${arcs.length}</span></h3>`;
      html += `<ul class="detail-list">`;
      for (const arc of arcs) {
        html += `<li><span class="detail-dot" style="background:${COLORS.accent}"></span><span class="detail-item-label">${escapeHtml(arc.title)} <span class="detail-meta">${escapeHtml('\u2605' + arc.importance)}</span></span></li>`;
      }
      html += `</ul>`;
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
                personality: COLORS.plot_thread,
                skill: COLORS.location,
                background: COLORS.item,
                physical: COLORS.tier2,
                faction: COLORS.accent,
              }[cat] || COLORS.tier3;
              html += `<li><span class="detail-dot" style="background:${dotColor}"></span><span class="detail-item-label">${escapeHtml(traitContent)} <span class="detail-meta">${escapeHtml(cat)}</span></span></li>`;
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
  panel.focus();
  if (panel._escHandler) {
    panel.removeEventListener("keydown", panel._escHandler);
  }
  panel._escHandler = function (e) {
    if (e.key === "Escape") hideDetailPanel();
  };
  panel.addEventListener("keydown", panel._escHandler);
}

function hideDetailPanel() {
  const panel = document.getElementById("detail-panel");
  if (panel._escHandler) {
    panel.removeEventListener("keydown", panel._escHandler);
    panel._escHandler = null;
  }
  panel.classList.add("hidden");
}

// ── Character sidebar ───────────────────────────────────────────

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

  avatarFileByName = new Map();
  for (const card of cards) {
    avatarFileByName.set(normalizeCharName(card.name), card.filename);
  }

  for (const card of cards) {
    const div = document.createElement("div");
    div.className = "char-card";
    div.dataset.name = card.name;
    const safeName = escapeHtml(card.name);
    const safeInitial = escapeHtml(card.name.charAt(0).toUpperCase());
    div.innerHTML = `
      <img class="char-card-img" src="${API_BASE}/character-image/${encodeURIComponent(card.filename)}"
           alt="${safeName}"
           onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
      <div class="char-card-placeholder" style="display:none;">${safeInitial}</div>
      <div class="char-card-name">${safeName}</div>
    `;
    div.addEventListener("click", () => selectCharacter(card.name));
    container.appendChild(div);
  }
}

async function selectCharacter(name) {
  activeCharacter = name;
  document.querySelectorAll(".char-card").forEach((c) => {
    c.classList.toggle("active", c.dataset.name === name);
  });
  document.getElementById("btn-show-all").classList.remove("active");
  await loadGraphData("character", { character: name, depth: 3 });

  // d3-force-3d hasn't simulated yet — node positions are NaN/undefined,
  // so flying to a specific node lands the camera nowhere. Wait a beat
  // for the simulation to spread nodes out, then zoomToFit.
  setTimeout(() => {
    if (graph) graph.zoomToFit(800, 60);
  }, 1200);
}

function clearCharacterSelection() {
  activeCharacter = null;
  document.querySelectorAll(".char-card").forEach((c) => c.classList.remove("active"));
  document.getElementById("btn-show-all").classList.add("active");
  loadGraphData("global");
}

// ── Edge filter chips ───────────────────────────────────────────

function initEdgeChips() {
  document.querySelectorAll(".chip[data-edge]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const types = chip.dataset.edge.split(",").map((t) => t.trim());
      const isActive = chip.classList.contains("active");
      if (isActive) {
        types.forEach((t) => activeEdgeTypes.delete(t));
        chip.classList.remove("active");
      } else {
        types.forEach((t) => activeEdgeTypes.add(t));
        chip.classList.add("active");
      }
      chip.setAttribute("aria-pressed", String(!isActive));
      applyEdgeFilter();
    });
  });
}

function applyEdgeFilter() {
  graph
    .nodeVisibility(nodeVisFn)
    .linkVisibility(linkVisFn)
    .linkDirectionalParticles(link => {
      if (!hoveredNodeId) return 0;
      const sid = typeof link.source === 'object' ? link.source.id : link.source;
      const tid = typeof link.target === 'object' ? link.target.id : link.target;
      if (!(sid === hoveredNodeId || tid === hoveredNodeId)) return 0;
      if (!activeEdgeTypes.has(link.type)) return 0;
      return 2;
    });
}

// ── Search ──────────────────────────────────────────────────────

function searchAndFocus(query) {
  const matches = graphNodes.filter(n =>
    (n.fullLabel || n.label || '').toLowerCase().includes(query)
  );
  if (matches.length > 0) {
    const node = matches[0];
    graph.cameraPosition(
      { x: node.x, y: node.y, z: node.z + 200 },
      node,
      1500
    );
  }
  return matches.length;
}

// ── Toolbar wiring ──────────────────────────────────────────────

function initToolbar() {
  document.getElementById("btn-show-all").addEventListener("click", clearCharacterSelection);

  // Fit: reset camera to default — zoom to fit all nodes
  document.getElementById("btn-fit").addEventListener("click", () => {
    graph.zoomToFit(600, 40);
  });

  // Re-layout: reheat the simulation
  document.getElementById("btn-layout").addEventListener("click", () => {
    if (graphNodes.length === 0) return;
    // Clear fixed positions so force sim can re-arrange
    graphNodes.forEach(n => { n.fx = undefined; n.fy = undefined; n.fz = undefined; });
    graph.d3ReheatSimulation();
  });

  // Export PNG
  document.getElementById("btn-export").addEventListener("click", () => {
    const renderer = graph.renderer();
    graph.postProcessingComposer().render();
    const dataUrl = renderer.domElement.toDataURL('image/png');
    const link = document.createElement("a");
    link.download = "chronicledb-graph.png";
    link.href = dataUrl;
    link.click();
  });

  // Search
  const searchInput = document.getElementById("search-input");
  const searchCount = document.getElementById("search-count");
  let searchDebounce = null;

  searchInput.addEventListener("input", (e) => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      const query = e.target.value.toLowerCase().trim();

      if (!query) {
        if (searchCount) searchCount.textContent = "";
        return;
      }

      const count = searchAndFocus(query);
      if (searchCount) {
        searchCount.textContent = `${count} found`;
      }
    }, 180);
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input"));
      searchInput.blur();
    }
  });

  // Close detail panel
  document.getElementById("btn-close-panel").addEventListener("click", hideDetailPanel);

  // Global Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const panel = document.getElementById("detail-panel");
      if (panel && !panel.classList.contains("hidden")) {
        hideDetailPanel();
      }
    }
  });
}

// ── Init ────────────────────────────────────────────────────────

async function pickRecentChatCharacter() {
  try {
    const res = await fetch(`${API_BASE}/chats`, fetchOpts);
    if (!res.ok) return null;
    const chats = await res.json();
    return chats[0]?.character || null;
  } catch (err) {
    console.warn("[ChronicleDB] /chats lookup failed:", err);
    return null;
  }
}

(async function bootstrap() {
  initGraph();
  initEdgeChips();
  initToolbar();
  await loadCharacterSidebar();
  // Auto-load the most-recent active chat's primary character so the
  // mindmap opens onto something meaningful instead of a blank canvas.
  const recent = await pickRecentChatCharacter();
  if (recent) {
    await selectCharacter(recent);
  } else {
    await loadGraphData("global");
  }
})();
