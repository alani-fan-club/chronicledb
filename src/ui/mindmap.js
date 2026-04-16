// ChronicleDB Mind Map — Three.js WebGL particle nebula with bloom
// Dark charcoal background, coral-red highlights, 3D force-directed layout

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

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
let graphNodes = [];     // [{id, label, fullLabel, type, size, color, x, y, z, pointSize, ...metadata}]
let graphEdges = [];     // [{id, source, target, type, label, sentiment, intensity}]
let nodeById = new Map(); // id -> graphNodes index
let adjacency = new Map(); // nodeId -> [{edge, neighborId, neighborData}]

// Three.js state
let scene, camera, renderer, composer, controls, labelRenderer;
let nodePointsMesh = null;
let edgeLinesMesh = null;
let raycaster, mouse;
let hoverIndex = -1;
let charLabelObjects = []; // CSS2DObject references for cleanup

const DEFAULT_CAMERA_Z = 800;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let time = 0;

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

// ── Three.js initialization ─────────────────────────────────────

function initThreeJS() {
  const container = document.getElementById('cy');

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x181818);
  scene.fog = new THREE.FogExp2(0x181818, 0.0012);

  // Camera
  camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    1,
    5000
  );
  camera.position.set(0, 0, DEFAULT_CAMERA_Z);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 1.5;
  container.appendChild(renderer.domElement);

  // CSS2D label renderer
  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(container.clientWidth, container.clientHeight);
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.left = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  // Post-processing
  composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    1.5,   // strength
    0.5,   // radius
    0.15   // threshold
  );
  composer.addPass(bloomPass);

  // Controls — constrained to near-2D to prevent disorientation.
  // Camera can tilt slightly but won't flip upside down or go behind.
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 1.2;
  controls.minDistance = 50;
  controls.maxDistance = 3000;
  controls.minPolarAngle = Math.PI * 0.25; // limit vertical tilt
  controls.maxPolarAngle = Math.PI * 0.75;

  // Raycaster — generous threshold so nodes are easy to click
  raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 15;
  mouse = new THREE.Vector2();

  // Events
  container.addEventListener('mousemove', onMouseMove, false);
  container.addEventListener('click', onClick, false);

  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    composer.setSize(w, h);
  });

  animate();
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
  return new THREE.CanvasTexture(canvas);
}

// ── Node color and sizing ───────────────────────────────────────

function nodeColor(type, significance, isPC) {
  if (type === 'character' && isPC) return 0xFF8870; // coral-tinted for PCs
  switch (type) {
    case 'character': return 0xe8e8e8;
    case 'event': return significance >= 4 ? 0xFF5841 : 0xd4a574;
    case 'story_arc': return 0xFF5841;
    case 'location': return 0x7d9a82;
    case 'item': return 0xa88b6a;
    case 'plot_thread': return 0xc77d5c;
    case 'fact': return 0x444444;
    default: return 0x555555;
  }
}

function nodePointSize(type, degree, significance, isPC) {
  if (type === 'character' && isPC) return Math.min(65, 40 + Math.log(degree + 1) * 5);
  if (type === 'character') return Math.min(40, 20 + Math.log(degree + 1) * 4);
  if (type === 'story_arc') return 10;
  if (type === 'event') return significance >= 4 ? 8 : 4;
  return 3;
}

// ── Force layout ────────────────────────────────────────────────

async function runForceLayout(nodes, edges) {
  if (nodes.length === 0) return;

  // Delete any existing x/y/z so d3-force-3d initializes positions
  // properly (phyllotaxis spiral). If they're 0, d3 thinks they're
  // "set" and skips init — 975 nodes all at origin = symmetric forces
  // that cancel out, producing a collapsed blob.
  for (const n of nodes) {
    delete n.x; delete n.y; delete n.z;
    delete n.vx; delete n.vy; delete n.vz;
  }

  // Use d3-force-3d for proper Barnes-Hut O(N log N) layout.
  const d3 = await import('https://cdn.jsdelivr.net/npm/d3-force-3d@3/+esm');

  // Filter out structural edges for layout
  const layoutLinks = edges
    .filter(e => e.type !== 'CONTAINS_EVENT' && e.type !== 'CAUSED')
    .map(e => ({ source: e.source, target: e.target }));

  const simulation = d3.forceSimulation(nodes, 3)
    .force("charge", d3.forceManyBody()
      .strength(n => n.type === 'character' ? -300 : -80)
      .distanceMax(600))
    .force("link", d3.forceLink(layoutLinks)
      .id(d => d.id)
      .distance(100)
      .strength(0.3))
    .force("center", d3.forceCenter())
    .force("collide", d3.forceCollide()
      .radius(d => d.pointSize * 0.8)
      .strength(0.7))
    .stop();

  // Run synchronously — Barnes-Hut is fast enough for 975 nodes
  const ticks = 300;
  for (let i = 0; i < ticks; i++) {
    simulation.tick();
    // Yield every 50 ticks to keep browser responsive
    if (i % 50 === 0) await new Promise(r => setTimeout(r, 0));
  }
}

// ── Build Three.js geometry ─────────────────────────────────────

function buildNodeGeometry() {
  if (graphNodes.length === 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
    geo.setAttribute('size', new THREE.Float32BufferAttribute([], 1));
    const material = new THREE.PointsMaterial({ size: 1 });
    return new THREE.Points(geo, material);
  }

  const positions = new Float32Array(graphNodes.length * 3);
  const colors = new Float32Array(graphNodes.length * 3);
  const sizes = new Float32Array(graphNodes.length);
  const baseColors = new Float32Array(graphNodes.length * 3);

  for (let i = 0; i < graphNodes.length; i++) {
    const n = graphNodes[i];
    positions[i * 3] = n.x;
    positions[i * 3 + 1] = n.y;
    positions[i * 3 + 2] = n.z;

    const color = new THREE.Color(n.color);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    baseColors[i * 3] = color.r;
    baseColors[i * 3 + 1] = color.g;
    baseColors[i * 3 + 2] = color.b;

    sizes[i] = n.pointSize;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
  geo.userData = { baseColors };

  const material = new THREE.ShaderMaterial({
    uniforms: {
      glowTexture: { value: createGlowTexture() },
    },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (400.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D glowTexture;
      varying vec3 vColor;
      void main() {
        vec4 texColor = texture2D(glowTexture, gl_PointCoord);
        gl_FragColor = vec4(vColor, 1.0) * texColor;
        if (gl_FragColor.a < 0.01) discard;
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexColors: true,
  });

  return new THREE.Points(geo, material);
}

function buildEdgeGeometry() {
  const visibleEdges = graphEdges.filter(e => activeEdgeTypes.has(e.type));
  if (visibleEdges.length === 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute([], 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial());
  }

  const positions = new Float32Array(visibleEdges.length * 6);
  const colors = new Float32Array(visibleEdges.length * 6);

  for (let i = 0; i < visibleEdges.length; i++) {
    const e = visibleEdges[i];
    const si = nodeById.get(e.source);
    const ti = nodeById.get(e.target);
    if (si === undefined || ti === undefined) continue;
    const s = graphNodes[si], t = graphNodes[ti];

    positions[i * 6] = s.x; positions[i * 6 + 1] = s.y; positions[i * 6 + 2] = s.z;
    positions[i * 6 + 3] = t.x; positions[i * 6 + 4] = t.y; positions[i * 6 + 5] = t.z;

    let edgeColor;
    if (e.type === 'FEELS_ABOUT') {
      edgeColor = e.sentiment > 0.3 ? 0x6ac47a : e.sentiment < -0.3 ? 0xe05555 : 0x7a8594;
    } else if (e.type === 'CAUSED') {
      edgeColor = 0xFF5841;
    } else if (e.type === 'CONTAINS_EVENT') {
      edgeColor = 0xFF5841;
    } else {
      edgeColor = 0x333333;
    }
    const c = new THREE.Color(edgeColor);
    colors[i * 6] = c.r; colors[i * 6 + 1] = c.g; colors[i * 6 + 2] = c.b;
    colors[i * 6 + 3] = c.r; colors[i * 6 + 4] = c.g; colors[i * 6 + 5] = c.b;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.07,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  return new THREE.LineSegments(geo, material);
}

// ── Character labels (CSS2D) ────────────────────────────────────

function buildCharacterLabels() {
  // Remove old labels
  for (const obj of charLabelObjects) {
    if (obj.parent) obj.parent.remove(obj);
    if (obj.element && obj.element.parentNode) {
      obj.element.parentNode.removeChild(obj.element);
    }
  }
  charLabelObjects = [];

  // Sort characters by degree (most connected first) for label priority
  const chars = graphNodes
    .filter(n => n.type === 'character')
    .sort((a, b) => b.degree - a.degree);

  for (const n of chars) {
    const div = document.createElement('div');
    div.className = 'node-label-3d';
    div.textContent = n.label || n.fullLabel || '';
    const labelObj = new CSS2DObject(div);
    labelObj.position.set(n.x, n.y - n.pointSize * 0.3, n.z);
    labelObj.userData = { degree: n.degree, nodeId: n.id };
    scene.add(labelObj);
    charLabelObjects.push(labelObj);
  }
}

// Label collision avoidance — hide labels that overlap higher-priority ones.
// Runs every ~200ms in the animation loop (not every frame — DOM is slow).
let lastLabelCull = 0;
function cullOverlappingLabels() {
  const now = performance.now();
  if (now - lastLabelCull < 200) return;
  lastLabelCull = now;

  // Already sorted by priority (degree) from buildCharacterLabels
  const occupied = [];
  for (const labelObj of charLabelObjects) {
    const el = labelObj.element;
    if (!el || !el.parentNode) continue;

    // Temporarily show to measure
    el.style.visibility = 'visible';
    const rect = el.getBoundingClientRect();

    // Check distance from camera — hide labels that are too far
    const dist = camera.position.distanceTo(labelObj.position);
    if (dist > 1200) {
      el.style.visibility = 'hidden';
      continue;
    }

    // Check overlap with already-placed labels
    const overlaps = occupied.some(r =>
      rect.left < r.right + 4 && rect.right > r.left - 4 &&
      rect.top < r.bottom + 2 && rect.bottom > r.top - 2
    );

    if (overlaps) {
      el.style.visibility = 'hidden';
    } else {
      occupied.push(rect);
    }
  }
}

// ── Highlight / reset ───────────────────────────────────────────

function highlightNode(idx) {
  if (!nodePointsMesh) return;
  const colors = nodePointsMesh.geometry.attributes.color;
  // Brighten to white
  colors.array[idx * 3] = 1.0;
  colors.array[idx * 3 + 1] = 1.0;
  colors.array[idx * 3 + 2] = 1.0;
  colors.needsUpdate = true;
}

function resetHighlights() {
  if (!nodePointsMesh) return;
  const colors = nodePointsMesh.geometry.attributes.color;
  const base = nodePointsMesh.geometry.userData.baseColors;
  if (!base) return;
  for (let i = 0; i < base.length; i++) {
    colors.array[i] = base[i];
  }
  colors.needsUpdate = true;
}

// ── Mouse interaction ───────────────────────────────────────────

function onMouseMove(event) {
  const container = document.getElementById('cy');
  const rect = container.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  const label = document.getElementById('hover-label');

  if (!nodePointsMesh || graphNodes.length === 0) {
    label.style.display = 'none';
    return;
  }

  const intersects = raycaster.intersectObject(nodePointsMesh);

  if (intersects.length > 0) {
    // Pick the largest/most important node among hits — characters
    // have huge glow radius so small nodes inside their halo get
    // picked first by distance. Sort by pointSize descending instead.
    intersects.sort((a, b) => {
      const na = graphNodes[a.index], nb = graphNodes[b.index];
      return (nb.pointSize || 0) - (na.pointSize || 0);
    });
    const idx = intersects[0].index;
    const node = graphNodes[idx];
    label.textContent = node.fullLabel || node.label || node.id;
    label.style.display = 'block';
    label.style.left = (event.clientX - rect.left + 12) + 'px';
    label.style.top = (event.clientY - rect.top - 8) + 'px';
    container.style.cursor = 'pointer';

    if (hoverIndex !== idx) {
      resetHighlights();
      hoverIndex = idx;
      highlightNode(idx);
    }
  } else {
    label.style.display = 'none';
    container.style.cursor = 'grab';
    if (hoverIndex >= 0) {
      resetHighlights();
      hoverIndex = -1;
    }
  }
}

function onClick(event) {
  const container = document.getElementById('cy');
  const rect = container.getBoundingClientRect();
  const clickMouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  raycaster.setFromCamera(clickMouse, camera);

  if (!nodePointsMesh || graphNodes.length === 0) {
    hideDetailPanel();
    return;
  }

  const intersects = raycaster.intersectObject(nodePointsMesh);
  if (intersects.length > 0) {
    intersects.sort((a, b) => {
      const na = graphNodes[a.index], nb = graphNodes[b.index];
      return (nb.pointSize || 0) - (na.pointSize || 0);
    });
    const idx = intersects[0].index;
    const node = graphNodes[idx];
    showDetailPanel(node);
    flyToNode(node);
  } else {
    hideDetailPanel();
  }
}

// ── Animation loop ──────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  // Gentle ambient drift (skip if reduced motion)
  if (!reducedMotion && nodePointsMesh && graphNodes.length > 0) {
    time += 0.001;
    const pos = nodePointsMesh.geometry.attributes.position;
    for (let i = 0; i < graphNodes.length; i++) {
      const n = graphNodes[i];
      const drift = 0.15;
      pos.array[i * 3] = n.x + Math.sin(time + n.x * 0.01) * drift;
      pos.array[i * 3 + 1] = n.y + Math.cos(time + n.y * 0.01) * drift;
      pos.array[i * 3 + 2] = n.z + Math.sin(time * 0.7 + n.z * 0.01) * drift;
    }
    pos.needsUpdate = true;
  }

  cullOverlappingLabels();
  composer.render();
  labelRenderer.render(scene, camera);
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
  // Clear previous geometry
  if (nodePointsMesh) { scene.remove(nodePointsMesh); nodePointsMesh = null; }
  if (edgeLinesMesh) { scene.remove(edgeLinesMesh); edgeLinesMesh = null; }
  for (const obj of charLabelObjects) {
    if (obj.parent) obj.parent.remove(obj);
  }
  charLabelObjects = [];

  // Build valid node set
  const nodeIds = new Set(data.nodes.map((n) => n.id));
  const validEdges = data.edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  // Connection counts
  const connectionCount = new Map();
  for (const e of validEdges) {
    connectionCount.set(e.source, (connectionCount.get(e.source) || 0) + 1);
    connectionCount.set(e.target, (connectionCount.get(e.target) || 0) + 1);
  }

  // Build graphNodes
  graphNodes = [];
  nodeById = new Map();

  for (let i = 0; i < data.nodes.length; i++) {
    const node = data.nodes[i];
    if (node.type === 'rp_group') continue; // Skip compound parent nodes

    const degree = connectionCount.get(node.id) || 0;
    const significance = node.metadata?.significance || node.metadata?.importance || 3;
    const fullLabel = node.label || "";
    const label = node.type === 'character' ? fullLabel : "";
    const isPC = node.metadata?.is_player_character ?? false;
    const color = nodeColor(node.type, significance, isPC);
    const pointSize = nodePointSize(node.type, degree, significance, isPC);

    const gn = {
      ...node.metadata,
      id: node.id,
      label,
      fullLabel,
      type: node.type,
      color,
      pointSize,
      degree,
      significance,
      isPC: node.metadata?.is_player_character ?? false,
      avatarUrl: node.type === 'character' ? avatarUrlFor(fullLabel) : undefined,
    };

    nodeById.set(node.id, graphNodes.length);
    graphNodes.push(gn);
  }

  // Build graphEdges
  graphEdges = validEdges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: edge.type,
    label: edge.label || "",
    sentiment: edge.sentiment ?? 0,
    intensity: edge.intensity ?? 0.5,
  }));

  // Build adjacency map
  adjacency = new Map();
  for (const e of graphEdges) {
    const si = nodeById.get(e.source);
    const ti = nodeById.get(e.target);
    if (si === undefined || ti === undefined) continue;

    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source).push({ edge: e, neighborId: e.target, neighborData: graphNodes[ti] });

    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.target).push({ edge: e, neighborId: e.source, neighborData: graphNodes[si] });
  }

  // Run force layout
  console.log(`[ChronicleDB] Running force layout on ${graphNodes.length} nodes, ${graphEdges.length} edges...`);
  const layoutStart = performance.now();
  await runForceLayout(graphNodes, graphEdges);
  console.log(`[ChronicleDB] Layout complete in ${((performance.now() - layoutStart) / 1000).toFixed(1)}s`);

  // Build Three.js objects
  nodePointsMesh = buildNodeGeometry();
  scene.add(nodePointsMesh);

  edgeLinesMesh = buildEdgeGeometry();
  scene.add(edgeLinesMesh);

  buildCharacterLabels();

  // Center camera on graph
  if (graphNodes.length > 0) {
    let cx = 0, cy = 0, cz = 0;
    for (const n of graphNodes) { cx += n.x; cy += n.y; cz += n.z; }
    cx /= graphNodes.length; cy /= graphNodes.length; cz /= graphNodes.length;
    controls.target.set(cx, cy, cz);
    camera.position.set(cx, cy, cz + DEFAULT_CAMERA_Z);
    controls.update();
  }

  // Yield a frame so the loading spinner can dismiss
  await new Promise((r) => requestAnimationFrame(r));
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
    // Group by edge type, dedupe by (type, neighbor_id)
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

    // Sort PARTICIPATED_IN events by significance (descending)
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
    // Find events this character participated in
    const charEventIds = new Set();
    const myNeighbors = adjacency.get(data.id) || [];
    for (const { edge, neighborId, neighborData } of myNeighbors) {
      if (edge.type === "PARTICIPATED_IN" && neighborData.type === "event") {
        charEventIds.add(neighborId);
      }
    }

    // Find arcs that contain any of those events
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
  // Fly camera to the selected character — try name match, fall back to
  // highest-degree character node (the selected character is typically
  // the most-connected node in their scoped subgraph)
  flyToNode(name);
  if (!graphNodes.find(n => (n.fullLabel || '').toLowerCase().includes(name.toLowerCase()))) {
    const bestChar = graphNodes
      .filter(n => n.type === 'character')
      .sort((a, b) => b.degree - a.degree)[0];
    if (bestChar) flyToNode(bestChar);
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
  if (edgeLinesMesh) scene.remove(edgeLinesMesh);
  edgeLinesMesh = buildEdgeGeometry();
  scene.add(edgeLinesMesh);
}

// ── Camera fly-to ──────────────────────────────────────────────

function flyToNode(nodeOrName) {
  let target;
  if (typeof nodeOrName === 'string') {
    const nameLower = nodeOrName.toLowerCase();
    // Try exact match first, then includes, then character type match
    target = graphNodes.find(n =>
      (n.fullLabel || n.label || '').toLowerCase() === nameLower
    ) || graphNodes.find(n =>
      (n.fullLabel || n.label || '').toLowerCase().includes(nameLower)
    ) || graphNodes.find(n =>
      n.type === 'character' && nameLower.includes((n.fullLabel || n.label || '').toLowerCase())
    );
  } else {
    target = nodeOrName;
  }
  if (!target) {
    console.warn('[ChronicleDB] flyToNode: no match for', nodeOrName);
    return;
  }
  const targetPos = new THREE.Vector3(target.x, target.y, target.z);
  const camDist = 250;
  const camTarget = targetPos.clone().add(new THREE.Vector3(0, 0, camDist));
  const animate = () => {
    const d = controls.target.distanceTo(targetPos);
    controls.target.lerp(targetPos, 0.1);
    camera.position.lerp(camTarget, 0.1);
    if (d > 2) requestAnimationFrame(animate);
  };
  animate();
}

// ── Search ──────────────────────────────────────────────────────

function searchAndFocus(query) {
  const matches = graphNodes.filter(n =>
    (n.fullLabel || n.label || '').toLowerCase().includes(query)
  );
  if (matches.length > 0) {
    flyToNode(matches[0]);
  }
  return matches.length;
}

// ── Toolbar wiring ──────────────────────────────────────────────

function initToolbar() {
  document.getElementById("btn-show-all").addEventListener("click", clearCharacterSelection);

  // Fit: reset camera to default
  document.getElementById("btn-fit").addEventListener("click", () => {
    const animateFit = () => {
      const target = new THREE.Vector3(0, 0, 0);
      const camPos = new THREE.Vector3(0, 0, DEFAULT_CAMERA_Z);
      const d1 = controls.target.distanceTo(target);
      const d2 = camera.position.distanceTo(camPos);
      controls.target.lerp(target, 0.12);
      camera.position.lerp(camPos, 0.12);
      if (d1 > 1 || d2 > 1) requestAnimationFrame(animateFit);
    };
    animateFit();
  });

  // Re-layout
  document.getElementById("btn-layout").addEventListener("click", async () => {
    if (graphNodes.length === 0) return;
    showLoading(true);
    // Yield a frame so the spinner renders
    await new Promise(r => requestAnimationFrame(r));

    await runForceLayout(graphNodes, graphEdges);

    // Rebuild geometry
    if (nodePointsMesh) scene.remove(nodePointsMesh);
    nodePointsMesh = buildNodeGeometry();
    scene.add(nodePointsMesh);

    if (edgeLinesMesh) scene.remove(edgeLinesMesh);
    edgeLinesMesh = buildEdgeGeometry();
    scene.add(edgeLinesMesh);

    buildCharacterLabels();
    showLoading(false);
  });

  // Export PNG
  document.getElementById("btn-export").addEventListener("click", () => {
    // Render one clean frame
    composer.render();
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

      // Reset highlights
      resetHighlights();

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
  initThreeJS();
  initEdgeChips();
  initToolbar();
  await Promise.all([loadCharacterSidebar(), loadChatFilterOptions()]);
  await loadGraphData("global");
})();
