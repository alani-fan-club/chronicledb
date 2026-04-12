/**
 * ChronicleDB — SillyTavern UI Extension
 * Hooks into ST events to trigger extraction and inject memory context.
 */

import {
  getContext,
  extension_settings,
  saveSettingsDebounced,
} from "../../../extensions.js";

import {
  eventSource,
  event_types,
} from "../../../../script.js";

const PLUGIN_BASE = "/api/plugins/chronicle-db";
const EXT_NAME = "chronicle-db";

// ── Default settings ───────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,
  pgHost: "localhost",
  pgPort: 5432,
  pgDatabase: "chronicledb",
  pgUser: "chronicledb",
  pgPassword: "",
  ollamaEndpoint: "http://localhost:11434/v1",
  extractionModel: "qwen3:8b",
  geminiApiKey: "",
  geminiEmbeddingModel: "gemini-embedding-2-preview",
  geminiEmbeddingDimension: 768,
  extractEveryN: 1,          // extract after every N messages
  maxInjectionTokens: 1500,
  enableRelationships: true,
  enableEvents: true,
  enableKnowledge: true,
  enableWorldState: true,
  sessionMode: "persistent", // persistent | isolated | readonly
};

let messageCounter = 0;
let isExtracting = false;

// ── Initialization ─────────────────────────────────────────────

jQuery(async () => {
  // Load settings
  if (!extension_settings[EXT_NAME]) {
    extension_settings[EXT_NAME] = { ...DEFAULT_SETTINGS };
  }
  const settings = extension_settings[EXT_NAME];

  // Load settings panel HTML
  const settingsHtml = await $.get(`${EXT_NAME}/settings.html`);
  $("#extensions_settings2").append(settingsHtml);

  // Bind settings inputs
  bindSettings(settings);

  // Push settings to server plugin
  await syncSettings(settings);

  // ── Load chat selector when character changes ───────────────

  eventSource.on(event_types.CHAT_CHANGED, async () => {
    if (!settings.enabled) return;
    await loadChatSelector();
  });

  // Load on init too if a chat is already open
  await loadChatSelector();

  // ── Event hooks ────────────────────────────────────────────

  // After AI generates a response → extract memories (async)
  eventSource.on(event_types.GENERATION_ENDED, async () => {
    if (!settings.enabled) return;
    if (settings.sessionMode === "readonly") return;

    messageCounter++;
    if (messageCounter % settings.extractEveryN !== 0) return;

    await triggerExtraction();
  });

  // Before generation starts → retrieve and inject memories
  eventSource.on(event_types.GENERATION_STARTED, async () => {
    if (!settings.enabled) return;

    await injectMemoryContext();
  });

  console.log("[ChronicleDB] UI extension loaded.");
});

// ── Extraction ─────────────────────────────────────────────────

async function triggerExtraction() {
  if (isExtracting) return;
  isExtracting = true;

  try {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length === 0) return;

    const characterName = ctx.name2;
    const userName = ctx.name1;
    const chatId = ctx.chatId;

    // Get last N messages for extraction batch
    const batchSize = 10;
    const recentMessages = chat.slice(-batchSize).map((m) => ({
      name: m.name,
      is_user: m.is_user,
      is_system: m.is_system || false,
      mes: m.mes,
      send_date: m.send_date,
    }));

    // Fire and forget — don't block the UI
    fetch(`${PLUGIN_BASE}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        characterName,
        userName,
        messages: recentMessages,
        chatId: String(chatId),
        messageIndex: chat.length - 1,
      }),
    }).then((res) => {
      if (!res.ok) console.warn("[ChronicleDB] Extraction failed:", res.status);
    }).catch((err) => {
      console.warn("[ChronicleDB] Extraction error:", err);
    });
  } finally {
    isExtracting = false;
  }
}

// ── Retrieval + Injection ──────────────────────────────────────

async function injectMemoryContext() {
  try {
    const ctx = getContext();
    const chat = ctx.chat;
    if (!chat || chat.length === 0) return;

    const settings = extension_settings[EXT_NAME];
    const characterName = ctx.name2;
    const chatId = ctx.chatId;

    // Identify active characters from recent messages
    const recentNames = new Set();
    const last10 = chat.slice(-10);
    for (const m of last10) {
      if (m.name && !m.is_system) recentNames.add(m.name);
    }

    // Build recent text for vector search
    const recentText = last10
      .filter((m) => !m.is_system)
      .map((m) => `${m.name}: ${m.mes}`)
      .join("\n")
      .slice(0, 4000);

    const res = await fetch(`${PLUGIN_BASE}/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: String(chatId),
        characterName,
        activeCharacters: [...recentNames],
        recentText,
        sessionId: `${chatId}`,
        maxTokens: settings.maxInjectionTokens,
      }),
    });

    if (!res.ok) {
      console.warn("[ChronicleDB] Retrieval failed:", res.status);
      return;
    }

    const data = await res.json();
    if (data.memoryBlock) {
      ctx.setExtensionPrompt(
        EXT_NAME,
        data.memoryBlock,
        1, // extension_prompt_types.IN_PROMPT
        0, // depth (0 = top of extensions area)
      );
    }
  } catch (err) {
    console.warn("[ChronicleDB] Retrieval error:", err);
  }
}

// ── Settings UI binding ────────────────────────────────────────

function bindSettings(settings) {
  // Toggle
  $("#chronicle_enabled").prop("checked", settings.enabled).on("change", function () {
    settings.enabled = $(this).prop("checked");
    saveAndSync(settings);
  });

  // DB settings
  for (const field of ["pgHost", "pgPort", "pgDatabase", "pgUser", "pgPassword"]) {
    $(`#chronicle_${field}`).val(settings[field]).on("input", function () {
      settings[field] = field === "pgPort" ? parseInt($(this).val()) : $(this).val();
      saveAndSync(settings);
    });
  }

  // LLM settings
  for (const field of ["ollamaEndpoint", "extractionModel", "geminiApiKey", "geminiEmbeddingModel"]) {
    $(`#chronicle_${field}`).val(settings[field]).on("input", function () {
      settings[field] = $(this).val();
      saveAndSync(settings);
    });
  }

  // Gemini dimension (numeric)
  $("#chronicle_geminiEmbeddingDimension").val(settings.geminiEmbeddingDimension).on("input", function () {
    settings.geminiEmbeddingDimension = parseInt($(this).val()) || 768;
    saveAndSync(settings);
  });

  // Numeric settings
  $("#chronicle_extractEveryN").val(settings.extractEveryN).on("input", function () {
    settings.extractEveryN = parseInt($(this).val()) || 1;
    saveAndSync(settings);
  });

  $("#chronicle_maxInjectionTokens").val(settings.maxInjectionTokens).on("input", function () {
    settings.maxInjectionTokens = parseInt($(this).val()) || 1500;
    saveAndSync(settings);
  });

  // Memory type toggles
  for (const type of ["Relationships", "Events", "Knowledge", "WorldState"]) {
    const key = `enable${type}`;
    $(`#chronicle_${key}`).prop("checked", settings[key]).on("change", function () {
      settings[key] = $(this).prop("checked");
      saveAndSync(settings);
    });
  }

  // Session mode
  $("#chronicle_sessionMode").val(settings.sessionMode).on("change", function () {
    settings.sessionMode = $(this).val();
    saveAndSync(settings);
  });

  // Init DB button
  $("#chronicle_initDb").on("click", async () => {
    try {
      const res = await fetch(`${PLUGIN_BASE}/init-db`, { method: "POST" });
      if (res.ok) {
        toastr.success("Database schema initialized.");
      } else {
        toastr.error("DB init failed. Check server logs.");
      }
    } catch (err) {
      toastr.error(`DB init error: ${err.message}`);
    }
  });

  // Open mind map
  $("#chronicle_openMindMap").on("click", () => {
    window.open("/api/plugins/chronicle-db/map", "_blank");
  });
}

function saveAndSync(settings) {
  saveSettingsDebounced();
  syncSettings(settings);
}

async function syncSettings(settings) {
  try {
    await fetch(`${PLUGIN_BASE}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch (err) {
    console.warn("[ChronicleDB] Failed to sync settings:", err);
  }
}

// ── Per-character chat selector ────────────────────────────────

let currentCharacterConfig = null;

async function loadChatSelector() {
  const ctx = getContext();
  const characterName = ctx.name2;
  const container = $("#chronicle_chatSelector");

  if (!characterName) {
    container.html('<p class="chronicle-hint">Open a chat to see available sessions.</p>');
    return;
  }

  try {
    // Load the character's memory config and available chats in parallel
    const [configRes, chatsRes] = await Promise.all([
      fetch(`${PLUGIN_BASE}/character-config/${encodeURIComponent(characterName)}`),
      fetch(`${PLUGIN_BASE}/chats/${encodeURIComponent(characterName)}`),
    ]);

    const charConfig = await configRes.json();
    const chats = await chatsRes.json();
    currentCharacterConfig = charConfig;

    if (chats.length === 0) {
      container.html('<p class="chronicle-hint">No chat history found for this character.</p>');
      return;
    }

    // If no chats are explicitly selected, default to all selected (persistent mode)
    const selected = new Set(
      charConfig.selectedChats && charConfig.selectedChats.length > 0
        ? charConfig.selectedChats
        : chats.map((c) => c.chatId),
    );

    let html = "";
    for (const chat of chats) {
      const checked = selected.has(chat.chatId) ? "checked" : "";
      const dateLabel = chat.date || "unknown date";
      html += `
        <label class="chronicle-chat-item">
          <input type="checkbox" value="${chat.chatId}" ${checked}
                 class="chronicle-chat-checkbox">
          <span>${chat.chatId.split(" - ").pop() || chat.chatId}</span>
          <span class="chronicle-chat-msgs">~${chat.messageEstimate} msgs</span>
          <span class="chronicle-chat-date">${dateLabel}</span>
        </label>`;
    }

    container.html(html);

    // Save on change
    container.find(".chronicle-chat-checkbox").on("change", () => {
      saveCharacterChatSelection(characterName);
    });
  } catch (err) {
    console.warn("[ChronicleDB] Failed to load chat selector:", err);
    container.html('<p class="chronicle-hint">Could not load chat list.</p>');
  }

  // Select All / Select None buttons
  $("#chronicle_selectAllChats").off("click").on("click", () => {
    $("#chronicle_chatSelector .chronicle-chat-checkbox").prop("checked", true);
    saveCharacterChatSelection(characterName);
  });

  $("#chronicle_selectNoneChats").off("click").on("click", () => {
    $("#chronicle_chatSelector .chronicle-chat-checkbox").prop("checked", false);
    saveCharacterChatSelection(characterName);
  });
}

async function saveCharacterChatSelection(characterName) {
  const selectedChats = [];
  $("#chronicle_chatSelector .chronicle-chat-checkbox:checked").each(function () {
    selectedChats.push($(this).val());
  });

  // Determine mode: no chats selected = isolated, some = selective, all = persistent
  const allCheckboxes = $("#chronicle_chatSelector .chronicle-chat-checkbox");
  let sessionMode = "persistent";
  if (selectedChats.length === 0) {
    sessionMode = "isolated";
  } else if (selectedChats.length < allCheckboxes.length) {
    sessionMode = "selective";
  }

  try {
    await fetch(`${PLUGIN_BASE}/character-config/${encodeURIComponent(characterName)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionMode, selectedChats }),
    });
  } catch (err) {
    console.warn("[ChronicleDB] Failed to save character config:", err);
  }
}
