// ChronicleDB Mind Map — 3d-force-graph with bloom post-processing
// Dark charcoal background, coral-red highlights, particle nebula feel

import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
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
  character:  "#e8e8e8",
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
  edge:        "#2c2c2c",
  edgeBright:  "#4a4a4a",
  edgeCausal:  "#FF5841",
  text:    "#f5f5f5",
  textDim: "#6a6a6a",
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

// ── Utilities ───────────────────────────────────────────────────

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
  if (type === 'character' && isPC) return '#FF8870'; // coral-tinted for PCs
  switch (type) {
    case 'character': return '#e8e8e8';
    case 'event': return significance >= 4 ? '#FF5841' : '#d4a574';
    case 'story_arc': return '#FF5841';
    case 'location': return '#7d9a82';
    case 'item': return '#a88b6a';
    case 'plot_thread': return '#c77d5c';
    case 'fact': return '#444444';
    default: return '#555555';
  }
}

function nodePointSize(type, degree, significance, isPC) {
  if (type === 'character' && isPC) return Math.min(65, 40 + Math.log(degree + 1) * 5);
  if (type === 'character') return Math.min(40, 20 + Math.log(degree + 1) * 4);
  if (type === 'story_arc') return 10;
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
    .backgroundColor('#0a0a0a')
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
    .nodeLabel(node => `<div class="hover-label-content">${escapeHtml(node.fullLabel || node.label || node.id)}</div>`)
    .onNodeClick(node => {
      showDetailPanel(node);
      // Fly camera to node
      const dist = 150;
      graph.cameraPosition(
        { x: node.x, y: node.y, z: node.z + dist },
        node,
        1500
      );
    })
    .onBackgroundClick(() => hideDetailPanel())
    // Link config
    .linkColor(link => {
      if (link.type === 'FEELS_ABOUT') {
        return link.sentiment > 0.3 ? '#6ac47a' : link.sentiment < -0.3 ? '#e05555' : '#7a8594';
      }
      if (link.type === 'CONTAINS_EVENT' || link.type === 'CAUSED') return '#FF5841';
      return '#333333';
    })
    .linkOpacity(0.07)
    .linkVisibility(link => activeEdgeTypes.has(link.type))
    .linkWidth(0.3)
    // Force config
    .d3AlphaDecay(0.02)
    .d3VelocityDecay(0.3)
    .warmupTicks(200)
    .cooldownTicks(0); // render after warmup

  // Tune forces after graph is created
  graph.d3Force('charge').strength(node => node.type === 'character' ? -250 : -60);
  graph.d3Force('charge').distanceMax(500);
  graph.d3Force('link').distance(100).strength(link => {
    // Structural edges have zero spring force — render but don't pull nodes together
    if (link.type === 'CONTAINS_EVENT' || link.type === 'CAUSED') return 0;
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

  // Add bloom post-processing
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    1.5,   // strength
    0.5,   // radius
    0.1    // threshold
  );
  graph.postProcessingComposer().addPass(bloomPass);

  // Handle resize for bloom pass and label renderer
  window.addEventListener('resize', () => {
    bloomPass.resolution.set(container.clientWidth, container.clientHeight);
    labelRenderer.setSize(container.clientWidth, container.clientHeight);
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
    await renderGraph(data);
  } catch (err) {
    console.error("[ChronicleDB] Graph load error:", err);
  } finally {
    showLoading(false);
  }
}

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
      html += `<div class="detail-avatar"><img src="${avatarUrl}" onerror="this.style.display='none'; this.parentElement.classList.add('no-img');"></div>`;
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
                personality: "#c77d5c",
                skill: "#7d9a82",
                background: "#a88b6a",
                physical: "#b8b8b8",
                faction: "#FF5841",
              }[cat] || "#6a6a6a";
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
  panel._escHandler = function (e) {
    if (e.key === "Escape") hideDetailPanel();
  };
  panel.addEventListener("keydown", panel._escHandler);
}

function showEdgeDetail(data) {
  const panel = document.getElementById("detail-panel");
  const content = document.getElementById("detail-content");

  const si = nodeById.get(data.source);
  const ti = nodeById.get(data.target);
  const src = si !== undefined ? (graphNodes[si].fullLabel || graphNodes[si].label || data.source) : data.source;
  const tgt = ti !== undefined ? (graphNodes[ti].fullLabel || graphNodes[ti].label || data.target) : data.target;
  const sentClass = sentimentClass(data.sentiment);

  let html = `<h2>${escapeHtml(src)} \u2192 ${escapeHtml(tgt)}</h2>`;
  html += `<div class="detail-type">${escapeHtml(data.type)}</div>`;
  if (data.label) html += `<p class="detail-desc">${escapeHtml(data.label)}</p>`;
  if (data.sentiment !== undefined) html += `<div class="detail-row"><span>Sentiment</span><b class="${sentClass}">${data.sentiment.toFixed(2)}</b></div>`;
  if (data.intensity !== undefined) {
    html += `<div class="detail-row"><span>Intensity</span><b>${(data.intensity * 100).toFixed(0)}%</b></div>`;
    html += `<div class="intensity-bar"><div class="intensity-bar-inner" style="width:${data.intensity * 100}%"></div></div>`;
  }

  content.innerHTML = html;
  panel.classList.remove("hidden");
  panel.focus();
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

  // Find the character node and fly to it
  const nameLower = name.toLowerCase();
  const charNode = graphNodes.find(n =>
    (n.fullLabel || '').toLowerCase().includes(nameLower)
  ) || graphNodes.filter(n => n.type === 'character').sort((a, b) => b.degree - a.degree)[0];

  if (charNode) {
    graph.cameraPosition(
      { x: charNode.x, y: charNode.y, z: charNode.z + 200 },
      charNode,
      1500
    );
  }
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
  graph.linkVisibility(link => activeEdgeTypes.has(link.type));
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

(async function bootstrap() {
  initGraph();
  initEdgeChips();
  initToolbar();
  await Promise.all([loadCharacterSidebar(), loadChatFilterOptions()]);
  await loadGraphData("global");
})();
