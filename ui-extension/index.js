/**
 * ChronicleDB — SillyTavern UI Extension
 * Hooks into ST events to trigger extraction and inject memory context.
 */

import {
  eventSource,
  event_types,
  getRequestHeaders,
  saveSettingsDebounced,
} from "../../../../script.js";

import {
  getContext,
  extension_settings,
  renderExtensionTemplateAsync,
} from "../../../extensions.js";

const PLUGIN_BASE = "/api/plugins/chronicle-db";
const EXT_NAME = "chronicle-db";

// ── Default settings ───────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,
  pgHost: "localhost",
  pgPort: 5432,
  pgDatabase: "chronicledb",
  pgUser: "",
  pgPassword: "",
  stDataRoot: "",
  extractionApiUrl: "",
  extractionApiKey: "",
  extractionApiType: "gemini",
  extractionModel: "",
  geminiApiKey: "",
  geminiEmbeddingModel: "",
  geminiEmbeddingDimension: 768,
  // Embedding provider (Gemini or OpenAI-compatible). The plugin's embed()
  // and embedBatch() helpers branch on embeddingApiType. Generic fields
  // (embeddingApiKey/Url/Model/Dimension) take precedence over the legacy
  // gemini-prefixed names; both are kept for backward compat with users who
  // upgraded from a build that only knew about Gemini embeddings.
  embeddingApiType: "gemini",
  embeddingApiKey: "",
  embeddingApiUrl: "",
  embeddingModel: "",
  embeddingDimension: 768,
  // Path 5+: incremental arc rebuild on the auto-ingest path. Every N new
  // events for a chat triggers a non-blocking rebuildArcsForChat() in the
  // background. The recycled-title snapshot in arc-builder keeps the LLM
  // cost ~0 per fire on stable partitions (only brand-new clusters get
  // named). 0 disables incremental rebuild entirely.
  arcRebuildEveryN: 30,
  extractEveryN: 1,
  // When true, extraction fires automatically after every generation so
  // memory builds live as you chat. When false, only the manual "Ingest"
  // buttons in the chat selector write to memory.
  autoIngest: true,
  maxInjectionTokens: 3000,
  enableRelationships: true,
  enableEvents: true,
  enableKnowledge: true,
  enableWorldState: true,
  sessionMode: "persistent",
  // Flipped to true the first time the user successfully initializes the DB.
  // Persists so subsequent ST boots auto-reconnect without user action.
  initialized: false,
};

let messageCounter = 0;
let isExtracting = false;

// ── Initialization ─────────────────────────────────────────────

(async function init() {
  // Merge defaults under existing settings so existing users keep their values
  // but new keys get sane defaults. Never overwrite user-set fields.
  if (!extension_settings[EXT_NAME]) {
    extension_settings[EXT_NAME] = { ...DEFAULT_SETTINGS };
  } else {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(k in extension_settings[EXT_NAME])) extension_settings[EXT_NAME][k] = v;
    }
  }
  const settings = extension_settings[EXT_NAME];

  // Load settings panel HTML via ST's template loader
  const settingsHtml = await renderExtensionTemplateAsync(
    `third-party/${EXT_NAME}`,
    'settings',
  );
  $('#extensions_settings2').append(settingsHtml);

  // Bind settings inputs
  bindSettings(settings);

  // Mount the per-character memory panel into the ST character card sidebar.
  // Failure here must not break the rest of init, so isolate in try/catch.
  try {
    await mountCharacterPanel();
  } catch (err) {
    console.warn("[ChronicleDB] Character panel mount failed:", err);
  }

  // Push settings to server plugin
  await syncSettings(settings);

  // Auto-reconnect on every boot after the first successful initialization.
  // The server's initSchema is idempotent, so running it unconditionally is
  // safe and ensures schema migrations land without user action.
  if (settings.initialized) {
    autoConnect(settings).catch((err) => {
      console.warn("[ChronicleDB] Auto-connect failed:", err);
    });
  } else {
    refreshStatus();
  }

  // ── Load chat selector when character changes ───────────────

  eventSource.on(event_types.CHAT_CHANGED, async () => {
    if (!settings.enabled) return;
    await loadChatSelector();
    refreshCharacterPanel().catch((err) => {
      console.warn("[ChronicleDB] Character panel refresh failed:", err);
    });
    // Visible confirmation that memory building is live for the new chat.
    // One-shot toast so it's not spammy.
    if (settings.autoIngest && settings.sessionMode !== "readonly" && typeof toastr !== "undefined") {
      toastr.info("ChronicleDB: building memory as you chat", "", { timeOut: 2500 });
    }
  });

  // Character-card-level refresh: fires when the user opens/edits a card
  // without necessarily switching the active chat.
  if (event_types.CHARACTER_EDITED) {
    eventSource.on(event_types.CHARACTER_EDITED, () => {
      refreshCharacterPanel().catch(() => {});
    });
  }
  if (event_types.CHARACTER_PAGE_LOADED) {
    eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
      refreshCharacterPanel().catch(() => {});
    });
  }

  // Load on init too if a chat is already open
  await loadChatSelector();
  refreshCharacterPanel().catch(() => {});

  // ── Event hooks ────────────────────────────────────────────

  // After AI generates a response → extract memories (async)
  eventSource.on(event_types.GENERATION_ENDED, async () => {
    if (!settings.enabled) return;
    if (!settings.autoIngest) return;
    if (settings.sessionMode === "readonly") return;

    messageCounter++;
    if (messageCounter % settings.extractEveryN !== 0) return;

    await triggerExtraction();
  });

  // Swipe cleanup: when the user changes the active swipe on a message we
  // already extracted, the previous swipe's events / quotes / embeddings are
  // stale and need to be torn down before the new swipe's extraction runs.
  // Otherwise the DB keeps both, and retrieval surfaces content the user
  // explicitly discarded. We POST /clear-message-extractions then wait for
  // the next GENERATION_ENDED to re-extract. ST emits MESSAGE_SWIPED with
  // the message index as a number (script.js:8581, 8781:
  //   await eventSource.emit(event_types.MESSAGE_SWIPED, (chat.length - 1))
  // ) so the typeof === "number" branch is the live path; the fallback is
  // defensive in case a future ST version changes the signature.
  if (event_types.MESSAGE_SWIPED) {
    eventSource.on(event_types.MESSAGE_SWIPED, async (messageIdOrIdx) => {
      if (!settings.enabled) return;
      if (!settings.autoIngest) return;
      if (settings.sessionMode === "readonly") return;
      try {
        const ctx = getContext();
        const messageIndex = typeof messageIdOrIdx === "number"
          ? messageIdOrIdx
          : (ctx.chat?.length ?? 0) - 1;
        const chatId = String(ctx.chatId || "");
        if (!chatId) return;
        const res = await fetch(`${PLUGIN_BASE}/clear-message-extractions`, {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify({ chatId, messageIndex }),
        });
        if (!res.ok) {
          console.warn(`[ChronicleDB] swipe cleanup failed: ${res.status}`);
        }
      } catch (err) {
        console.warn("[ChronicleDB] swipe cleanup error:", err);
      }
    });
  }

  // Before generation starts → retrieve and inject memories
  eventSource.on(event_types.GENERATION_STARTED, async () => {
    if (!settings.enabled) return;

    await injectMemoryContext();
  });

  console.log("[ChronicleDB] UI extension loaded.");
})();

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

    // Get last N messages for extraction batch.
    // Single-message batches in the live path so the swipe cleanup hook
    // below can DELETE by (chat_id, message_index) surgically. The previous
    // 10-message batch made cleanup either leaky (stale events from
    // discarded swipes lingered) or aggressive (cleanup deleted neighboring
    // canonical messages too). Cross-message context is rebuilt at full
    // /ingest-chat time, which still uses 10-message batches.
    const batchSize = 1;
    const recentMessages = chat.slice(-batchSize).map((m) => ({
      name: m.name,
      is_user: m.is_user,
      is_system: m.is_system || false,
      // ST sometimes leaves m.mes pointing at swipe 0 while swipe_id is N>0.
      // Normalize the same way /ingest-chat does at server-plugin/index.js:513
      // so live extract reliably ingests the user's actively-selected reply,
      // not whichever swipe happened to be in m.mes at GENERATION_ENDED time.
      mes: m.swipe_id !== undefined && m.swipes?.[m.swipe_id] ? m.swipes[m.swipe_id] : m.mes,
      send_date: m.send_date,
    }));

    // Fire and forget — don't block the UI
    fetch(`${PLUGIN_BASE}/extract`, {
      method: "POST",
      headers: getRequestHeaders(),
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
      headers: getRequestHeaders(),
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

  // These keys must match what server-plugin/extractor.js actually reads.
  // The new generic embedding* fields take precedence over the legacy
  // gemini* names; both are kept in DEFAULT_SETTINGS for backward compat.
  for (const field of [
    "extractionApiUrl",
    "extractionApiKey",
    "extractionModel",
    "geminiApiKey",
    "embeddingApiKey",
    "embeddingApiUrl",
    "embeddingModel",
  ]) {
    $(`#chronicle_${field}`).val(settings[field]).on("input", function () {
      settings[field] = $(this).val();
      saveAndSync(settings);
    });
  }

  // Provider type selects (extraction + embedding)
  $("#chronicle_extractionApiType").val(settings.extractionApiType).on("change", function () {
    settings.extractionApiType = $(this).val();
    saveAndSync(settings);
  });
  $("#chronicle_embeddingApiType").val(settings.embeddingApiType || "gemini").on("change", function () {
    settings.embeddingApiType = $(this).val();
    saveAndSync(settings);
  });

  // Embedding dimension (numeric, generic name)
  $("#chronicle_embeddingDimension").val(settings.embeddingDimension || 768).on("input", function () {
    settings.embeddingDimension = parseInt($(this).val()) || 768;
    saveAndSync(settings);
  });

  // Auto-ingest toggle — gates the GENERATION_ENDED extract hook
  $("#chronicle_autoIngest").prop("checked", settings.autoIngest).on("change", function () {
    settings.autoIngest = $(this).prop("checked");
    saveAndSync(settings);
  });

  // Numeric settings
  $("#chronicle_arcRebuildEveryN").val(settings.arcRebuildEveryN ?? 30).on("input", function () {
    const v = parseInt($(this).val());
    settings.arcRebuildEveryN = Number.isFinite(v) && v >= 0 ? v : 30;
    saveAndSync(settings);
  });
  $("#chronicle_extractEveryN").val(settings.extractEveryN).on("input", function () {
    settings.extractEveryN = parseInt($(this).val()) || 1;
    saveAndSync(settings);
  });

  $("#chronicle_maxInjectionTokens").val(settings.maxInjectionTokens).on("input", function () {
    settings.maxInjectionTokens = parseInt($(this).val()) || 3000;
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

  // Connect & initialize button. After the first success, `initialized: true`
  // is persisted so future ST boots auto-reconnect without any button press.
  $("#chronicle_initDb").on("click", async () => {
    setStatus("connecting", "Connecting…");
    try {
      // Push latest settings first so the server has fresh credentials.
      await syncSettings(settings);
      const res = await fetch(`${PLUGIN_BASE}/init-db`, { method: "POST", headers: getRequestHeaders() });
      if (res.ok) {
        toastr.success("Connected. Memory is ready.");
        settings.initialized = true;
        saveAndSync(settings);
        setStatus("connected", "Connected");
      } else {
        const body = await res.text().catch(() => "");
        toastr.error("Could not connect. Check database settings.");
        setStatus("error", body || `HTTP ${res.status}`);
      }
    } catch (err) {
      toastr.error(`Connection error: ${err.message}`);
      setStatus("error", err.message);
    }
  });

  // Open mind map
  $("#chronicle_openMindMap").on("click", () => {
    window.open("/api/plugins/chronicle-db/map", "_blank");
  });

  // Lorebook ingestion
  loadLorebookList();

  $("#chronicle_ingestLorebook").on("click", async () => {
    const filename = $("#chronicle_lorebookSelect").val();
    if (!filename) {
      toastr.warning("Select a lorebook first.");
      return;
    }

    const status = $("#chronicle_lorebookStatus");
    status.text("Ingesting... this may take a moment.");

    try {
      const res = await fetch(`${PLUGIN_BASE}/lorebooks/ingest`, {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (res.ok) {
        status.text(`Done: ${data.ingested} entries ingested, ${data.skipped} skipped (of ${data.total} total).`);
        toastr.success(`Ingested ${data.ingested} entries from ${data.lorebook}.`);
      } else {
        status.text(`Error: ${data.error}`);
        toastr.error(`Ingestion failed: ${data.error}`);
      }
    } catch (err) {
      status.text(`Error: ${err.message}`);
      toastr.error(`Ingestion error: ${err.message}`);
    }
  });
}

async function loadLorebookList() {
  try {
    const res = await fetch(`${PLUGIN_BASE}/lorebooks`, { headers: getRequestHeaders() });
    const books = await res.json();
    const select = $("#chronicle_lorebookSelect");
    for (const book of books) {
      select.append(`<option value="${book.filename}">${book.name}</option>`);
    }
  } catch (err) {
    console.warn("[ChronicleDB] Failed to load lorebook list:", err);
  }
}

function saveAndSync(settings) {
  saveSettingsDebounced();
  syncSettings(settings);
}

function pluginFetch(endpoint, body) {
  return fetch(`${PLUGIN_BASE}${endpoint}`, {
    method: "POST",
    headers: getRequestHeaders(),
    body: JSON.stringify(body),
  });
}

async function syncSettings(settings) {
  try {
    await pluginFetch("/settings", settings);
  } catch (err) {
    console.warn("[ChronicleDB] Failed to sync settings:", err);
  }
}

// ── Connection status ──────────────────────────────────────────

function setStatus(state, detail) {
  const badge = $("#chronicle_statusBadge");
  if (!badge.length) return;
  const labels = {
    connected: "Connected",
    connecting: "Connecting…",
    "not-configured": "Not configured",
    error: "Error",
    unknown: "Unknown",
  };
  badge
    .removeClass("chronicle-status-connected chronicle-status-error chronicle-status-unknown chronicle-status-connecting chronicle-status-notconfigured")
    .addClass(`chronicle-status-${state === "not-configured" ? "notconfigured" : state}`)
    .text(labels[state] || state);
  $("#chronicle_statusDetail").text(detail || "");
}

async function refreshStatus() {
  try {
    const res = await fetch(`${PLUGIN_BASE}/status`, { headers: getRequestHeaders() });
    if (!res.ok) {
      setStatus("unknown", `HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    if (data.connected) {
      setStatus("connected", "");
    } else if (data.error) {
      setStatus("error", data.error);
    } else {
      setStatus("not-configured", "Fill in database settings and press Connect.");
    }
  } catch (err) {
    setStatus("unknown", err.message);
  }
}

async function autoConnect(settings) {
  setStatus("connecting", "Connecting…");
  try {
    const res = await fetch(`${PLUGIN_BASE}/init-db`, { method: "POST", headers: getRequestHeaders() });
    if (res.ok) {
      setStatus("connected", "");
    } else {
      const body = await res.text().catch(() => "");
      setStatus("error", body || `HTTP ${res.status}`);
    }
  } catch (err) {
    setStatus("error", err.message);
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
      fetch(`${PLUGIN_BASE}/character-config/${encodeURIComponent(characterName)}`, { headers: getRequestHeaders() }),
      fetch(`${PLUGIN_BASE}/chats/${encodeURIComponent(characterName)}`, { headers: getRequestHeaders() }),
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
      const displayName = chat.chatId.split(" - ").pop() || chat.chatId;
      html += `
        <div class="chronicle-chat-item">
          <input type="checkbox" value="${chat.chatId}" ${checked}
                 class="chronicle-chat-checkbox">
          <span class="chronicle-chat-name" title="${chat.chatId}">${displayName}</span>
          <span class="chronicle-chat-msgs">~${chat.messageEstimate} msgs</span>
          <span class="chronicle-chat-date">${dateLabel}</span>
          ${chat.ingested
            ? `<span class="chronicle-ingested-badge" title="Ingested ${chat.batchesDone || ''} batches">Ingested</span>`
            : `<button class="chronicle-ingest-btn menu_button menu_button_small"
                    data-filename="${chat.filename}" data-character="${characterName}"
                    data-msgs="${chat.messageEstimate}">Ingest</button>`
          }
        </div>`;
    }

    container.html(html);

    // Save on change
    container.find(".chronicle-chat-checkbox").on("change", () => {
      saveCharacterChatSelection(characterName);
    });

    // Ingest button per chat
    container.find(".chronicle-ingest-btn").on("click", async function (e) {
      e.preventDefault();
      e.stopPropagation();
      const btn = $(this);
      const filename = btn.data("filename");
      const charName = btn.data("character");
      const estMsgs = btn.data("msgs") || "?";
      const originalText = btn.text();

      // Show progress in the status bar
      const statusEl = $("#chronicle_ingestStatus");
      btn.prop("disabled", true).text("Ingesting...").addClass("ingesting");
      statusEl.html(`<span class="chronicle-ingesting-indicator">Ingesting <b>${filename}</b> (~${estMsgs} messages)... <span class="chronicle-spinner"></span></span>`);

      try {
        const res = await fetch(`${PLUGIN_BASE}/ingest-chat`, {
          method: "POST",
          headers: getRequestHeaders(),
          body: JSON.stringify({ characterName: charName, filename }),
        });
        const data = await res.json();
        if (res.ok) {
          btn.text("Done!").removeClass("ingesting").addClass("success");
          statusEl.html(`<span class="chronicle-ingest-done">Ingested <b>${data.messagesTotal}</b> messages in <b>${data.batchesProcessed}</b> batches from <b>${charName}</b>.</span>`);
          toastr.success(`Ingested ${data.messagesTotal} messages (${data.batchesProcessed}/${data.batchesTotal} batches) from ${charName}.`);
        } else {
          btn.text("Error").removeClass("ingesting");
          statusEl.html(`<span class="chronicle-ingest-error">Error: ${data.error}</span>`);
          toastr.error(`Ingest failed: ${data.error}`);
        }
      } catch (err) {
        btn.text("Error").removeClass("ingesting");
        statusEl.html(`<span class="chronicle-ingest-error">Error: ${err.message}</span>`);
        toastr.error(`Ingest error: ${err.message}`);
      }
      setTimeout(() => {
        btn.prop("disabled", false).text(originalText).removeClass("success ingesting");
      }, 5000);
    });
  } catch (err) {
    console.warn("[ChronicleDB] Failed to load chat selector:", err);
    container.html('<p class="chronicle-hint">Could not load chat list.</p>');
  }

  // Ingest All button
  $("#chronicle_ingestAllChats").off("click").on("click", async () => {
    const buttons = container.find(".chronicle-ingest-btn");
    if (buttons.length === 0) return;
    toastr.info(`Ingesting ${buttons.length} chats for ${characterName}... this may take a while.`);
    for (const btn of buttons) {
      $(btn).trigger("click");
      // Wait for each to finish before starting next (sequential to avoid hammering API)
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (!$(btn).prop("disabled")) { clearInterval(check); resolve(); }
        }, 500);
      });
    }
  });

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
      headers: getRequestHeaders(),
      body: JSON.stringify({ sessionMode, selectedChats }),
    });
  } catch (err) {
    console.warn("[ChronicleDB] Failed to save character config:", err);
  }
}

// ── Character memory panel (mounted in ST character card sidebar) ─

async function mountCharacterPanel() {
  // Rendered once at init; refreshCharacterPanel() repopulates it as the
  // user switches characters.
  if ($("#chronicle_char_panel_wrap").length > 0) return;

  const html = await renderExtensionTemplateAsync(
    `third-party/${EXT_NAME}`,
    'character-panel',
  );
  const wrapped = $(html).attr("id", "chronicle_char_panel_wrap");

  // Mount as a sibling *after* #form_create but still inside the character
  // sidebar container (#rm_ch_create_block). Keeping it outside the form
  // avoids polluting ST's character-save payload with our controls.
  const form = document.getElementById("form_create");
  const sidebar = document.getElementById("rm_ch_create_block");

  if (form && form.parentElement) {
    form.parentElement.insertBefore(wrapped[0], form.nextSibling);
  } else if (sidebar) {
    sidebar.appendChild(wrapped[0]);
  } else {
    // Fallback: mount under the global settings panel so users still
    // get the panel even if ST's DOM shape changes.
    $('#extensions_settings2').append(wrapped);
    console.warn("[ChronicleDB] Character card DOM target not found, using fallback mount.");
  }

  $("#chronicle_char_panel_mode").on("change", async function () {
    const name = getSelectedCharacterName();
    if (!name) return;
    const mode = $(this).val();
    try {
      await fetch(`${PLUGIN_BASE}/character-memory-config`, {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ name, sessionMode: mode }),
      });
      if (typeof toastr !== "undefined") toastr.success(`Memory mode: ${mode}`);
    } catch (err) {
      if (typeof toastr !== "undefined") toastr.error(`Failed to save memory mode: ${err.message}`);
    }
  });

  $("#chronicle_char_panel_clear").on("click", async () => {
    const name = getSelectedCharacterName();
    if (!name) {
      if (typeof toastr !== "undefined") toastr.warning("No character selected.");
      return;
    }
    const ok = window.confirm(`Clear ChronicleDB memories for "${name}"? Traits, relationships, and presence for this character will be deleted. Events themselves are kept.`);
    if (!ok) return;
    try {
      const res = await fetch(`${PLUGIN_BASE}/character-clear-memories`, {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (res.ok) {
        const c = data.cleared || {};
        const total = (c.traits || 0) + (c.feels_about || 0) + (c.participated_in || 0) + (c.present_at || 0) + (c.knows || 0);
        if (typeof toastr !== "undefined") toastr.success(`Cleared ${total} rows for ${name}.`);
        await refreshCharacterPanel();
      } else {
        if (typeof toastr !== "undefined") toastr.error(`Clear failed: ${data.error || res.status}`);
      }
    } catch (err) {
      if (typeof toastr !== "undefined") toastr.error(`Clear failed: ${err.message}`);
    }
  });

  $(document).on("click", "#chronicle_char_panel_events .chronicle-char-event-summary", function () {
    $(this).closest(".chronicle-char-event").toggleClass("expanded");
  });
}

function getSelectedCharacterName() {
  try {
    const ctx = getContext();
    return ctx?.name2 || "";
  } catch {
    return "";
  }
}

function sentimentLabel(sentiment) {
  const s = Number(sentiment) || 0;
  if (s >= 0.6) return { text: "very positive", klass: "chronicle-sentiment-positive" };
  if (s >= 0.2) return { text: "positive", klass: "chronicle-sentiment-positive" };
  if (s > -0.2) return { text: "neutral", klass: "chronicle-sentiment-neutral" };
  if (s > -0.6) return { text: "negative", klass: "chronicle-sentiment-negative" };
  return { text: "very negative", klass: "chronicle-sentiment-negative" };
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function refreshCharacterPanel() {
  if ($("#chronicle_char_panel_wrap").length === 0) return;

  const name = getSelectedCharacterName();
  const nameEl = $("#chronicle_char_panel_name");
  const statsEl = $("#chronicle_char_panel_stats");
  const eventsEl = $("#chronicle_char_panel_events");
  const relsEl = $("#chronicle_char_panel_rels");
  const modeEl = $("#chronicle_char_panel_mode");

  if (!name) {
    nameEl.text("no character selected");
    statsEl.html('<span class="chronicle-hint">Select a character to see their memory.</span>');
    eventsEl.html('<span class="chronicle-hint">—</span>');
    relsEl.html('<span class="chronicle-hint">—</span>');
    return;
  }

  nameEl.text(name);
  statsEl.html('<span class="chronicle-hint">Loading…</span>');
  eventsEl.html('<span class="chronicle-hint">Loading…</span>');
  relsEl.html('<span class="chronicle-hint">Loading…</span>');

  const encodedName = encodeURIComponent(name);
  // Scope to the currently-open chat so cross-chat contamination doesn't
  // bleed into the panel. When no chat is open (character page, new chat
  // selector), fall through unscoped — the server returns global counts.
  let chatQs = "";
  try {
    const ctx = getContext();
    if (ctx && ctx.chatId) chatQs = `&chat_id=${encodeURIComponent(String(ctx.chatId))}`;
  } catch { /* no context → unscoped */ }
  try {
    const [statsRes, eventsRes, relsRes, configRes] = await Promise.all([
      fetch(`${PLUGIN_BASE}/character-stats?name=${encodedName}${chatQs}`, { headers: getRequestHeaders() }),
      fetch(`${PLUGIN_BASE}/character-recent-events?name=${encodedName}&limit=5${chatQs}`, { headers: getRequestHeaders() }),
      fetch(`${PLUGIN_BASE}/character-relationships?name=${encodedName}${chatQs}`, { headers: getRequestHeaders() }),
      fetch(`${PLUGIN_BASE}/character-memory-config?name=${encodedName}`, { headers: getRequestHeaders() }),
    ]);

    if (statsRes.ok) {
      const s = await statsRes.json();
      const lastSeen = s.lastSeenTurn == null ? "never" : `turn ${s.lastSeenTurn}`;
      statsEl.html(
        `<b>${s.events}</b> events &middot; <b>${s.traits}</b> traits &middot; <b>${s.relationships}</b> relationships &middot; last seen ${lastSeen}`,
      );
    } else {
      statsEl.html('<span class="chronicle-hint">Could not load stats.</span>');
    }

    if (configRes.ok) {
      const cfg = await configRes.json();
      modeEl.val(cfg.sessionMode || "persistent");
    }

    if (eventsRes.ok) {
      const events = await eventsRes.json();
      if (events.length === 0) {
        eventsEl.html('<span class="chronicle-hint">No memories yet for this character.</span>');
      } else {
        let html = "";
        for (const ev of events) {
          const turn = ev.messageIndex == null ? "?" : ev.messageIndex;
          const quote = ev.sourceText ? escapeHtml(ev.sourceText) : "";
          const hasQuote = quote.length > 0;
          html += `
            <div class="chronicle-char-event">
              <div class="chronicle-char-event-summary" ${hasQuote ? 'title="Click to show source"' : ''}>
                <span class="chronicle-char-turn">[turn ${escapeHtml(turn)}]</span>
                ${escapeHtml(ev.summary)}
              </div>
              ${hasQuote ? `<div class="chronicle-char-event-quote">${quote}</div>` : ""}
            </div>`;
        }
        eventsEl.html(html);
      }
    } else {
      eventsEl.html('<span class="chronicle-hint">Could not load memories.</span>');
    }

    if (relsRes.ok) {
      const rels = await relsRes.json();
      if (rels.length === 0) {
        relsEl.html('<span class="chronicle-hint">No relationships yet.</span>');
      } else {
        let html = "";
        for (const r of rels) {
          const lbl = sentimentLabel(r.sentiment);
          const pct = Math.round(Math.abs(Number(r.intensity) || 0) * 100);
          const desc = r.description ? ` &mdash; ${escapeHtml(r.description)}` : "";
          html += `
            <div class="chronicle-char-rel">
              ${escapeHtml(name)} &rarr; <span class="chronicle-char-rel-target">${escapeHtml(r.toName)}</span>:
              <span class="${lbl.klass}">${lbl.text}</span> (${pct}%)${desc}
            </div>`;
        }
        relsEl.html(html);
      }
    } else {
      relsEl.html('<span class="chronicle-hint">Could not load relationships.</span>');
    }
  } catch (err) {
    console.warn("[ChronicleDB] Character panel fetch error:", err);
    statsEl.html('<span class="chronicle-hint">Error loading memory.</span>');
    eventsEl.html('');
    relsEl.html('');
  }
}
