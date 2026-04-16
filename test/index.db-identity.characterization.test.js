import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);

const INDEX_PATH = require.resolve("../server-plugin/index.js");
const DB_PATH = require.resolve("../server-plugin/db.js");
const EXTRACTOR_PATH = require.resolve("../server-plugin/extractor.js");
const RETRIEVER_PATH = require.resolve("../server-plugin/retriever.js");
const LOREBOOK_PATH = require.resolve("../server-plugin/lorebook.js");
const PATH_SAFETY_PATH = require.resolve("../server-plugin/path-safety.js");
const BOUNDED_MAP_PATH = require.resolve("../server-plugin/bounded-map.js");
const ST_PATHS_PATH = require.resolve("../server-plugin/st-paths.js");
const SETTINGS_CACHE_PATH = path.resolve(path.dirname(INDEX_PATH), ".settings-cache.json");

let originalSettingsCacheExisted = false;
let originalSettingsCacheContent = "";

function setModuleStub(modulePath, exportsObj) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsObj,
    children: [],
    paths: [],
  };
  return previous;
}

function restoreModuleCache(modulePath, previous) {
  delete require.cache[modulePath];
  if (previous) require.cache[modulePath] = previous;
}

function createRouterRecorder() {
  const routes = { post: new Map(), get: new Map(), delete: new Map() };
  const router = {
    post(path, handler) { routes.post.set(path, handler); },
    get(path, handler) { routes.get.set(path, handler); },
    delete(path, handler) { routes.delete.set(path, handler); },
    use() {},
  };
  return { router, routes };
}

function createResponseRecorder() {
  let statusCode = 200;
  let body;
  const res = {
    headersSent: false,
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      this.headersSent = true;
      return this;
    },
    send(payload) {
      body = payload;
      this.headersSent = true;
      return this;
    },
  };
  return {
    res,
    output: () => ({ statusCode, body }),
  };
}

async function invokeRoute(handler, req = {}) {
  const { res, output } = createResponseRecorder();
  await handler(req, res);
  return output();
}

async function waitFor(predicate, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
}

function clearSettingsCacheFile() {
  try {
    if (fs.existsSync(SETTINGS_CACHE_PATH)) {
      fs.unlinkSync(SETTINGS_CACHE_PATH);
    }
  } catch {
    // Best effort only; tests still run with the existing cache.
  }
}

function restoreSettingsCacheFile() {
  try {
    if (originalSettingsCacheExisted) {
      fs.writeFileSync(SETTINGS_CACHE_PATH, originalSettingsCacheContent, "utf-8");
    } else if (fs.existsSync(SETTINGS_CACHE_PATH)) {
      fs.unlinkSync(SETTINGS_CACHE_PATH);
    }
  } catch {
    // Do not fail the suite on cleanup best-effort restore.
  }
}

async function loadPluginHarness({ identityUser, identityDb }) {
  clearSettingsCacheFile();

  const calls = {
    initSchema: 0,
    identityQuery: 0,
    statusProbe: 0,
  };

  const identity = {
    u: identityUser,
    d: identityDb,
  };

  const dbStub = {
    setPoolErrorHandler: vi.fn(),
    initSchema: vi.fn(async () => {
      calls.initSchema += 1;
    }),
    getPool: vi.fn(() => ({
      query: vi.fn(async (sql) => {
        const text = String(sql || "");
        if (text.includes("current_user AS u") && text.includes("current_database() AS d")) {
          calls.identityQuery += 1;
          return { rows: [{ u: identity.u, d: identity.d }] };
        }
        if (text.includes("SELECT 1")) {
          calls.statusProbe += 1;
          return { rows: [{ ok: 1 }] };
        }
        if (text.includes("COUNT(*)::int AS n FROM events")) {
          return { rows: [{ n: 0 }] };
        }
        return { rows: [] };
      }),
    })),
    closePool: vi.fn(async () => {}),
  };

  const previous = new Map();
  previous.set(DB_PATH, setModuleStub(DB_PATH, dbStub));
  previous.set(EXTRACTOR_PATH, setModuleStub(EXTRACTOR_PATH, {
    extract: async () => ({}),
    embed: async () => [],
    applyExtractionToGraph: async () => {},
    applyMessagesToVectorStore: async () => ({}),
  }));
  previous.set(RETRIEVER_PATH, setModuleStub(RETRIEVER_PATH, {
    retrieve: async () => ({
      relationships: [],
      events: [],
      knowledge: [],
      worldState: [],
      plotThreads: [],
      snapshots: [],
      locations: [],
      fusedHits: [],
      neighborPadding: new Map(),
      arcExpansion: new Map(),
      vectorResults: [],
      eventHits: [],
      dialogueHits: [],
      budgets: null,
    }),
    formatMemoryBlock: () => "",
  }));
  previous.set(LOREBOOK_PATH, setModuleStub(LOREBOOK_PATH, {
    ingestLorebook: async () => ({ ingested: 0, skipped: 0, total: 0 }),
    listLorebooks: () => [],
  }));
  previous.set(PATH_SAFETY_PATH, setModuleStub(PATH_SAFETY_PATH, {
    safeResolveUnder: (base, target) => `${base}/${target}`,
  }));
  previous.set(BOUNDED_MAP_PATH, setModuleStub(BOUNDED_MAP_PATH, {
    setWithBoundedEviction: (map, key, value) => map.set(key, value),
  }));
  previous.set(ST_PATHS_PATH, setModuleStub(ST_PATHS_PATH, {
    resolveStDataRoot: () => process.cwd(),
  }));

  delete require.cache[INDEX_PATH];
  const plugin = require(INDEX_PATH);
  const { router, routes } = createRouterRecorder();
  await plugin.init(router);

  const cleanup = () => {
    clearSettingsCacheFile();
    delete require.cache[INDEX_PATH];
    for (const [modulePath, prior] of previous.entries()) {
      restoreModuleCache(modulePath, prior);
    }
  };

  return {
    routes,
    calls,
    cleanup,
  };
}

async function configureSettings(settingsHandler, override = {}) {
  const base = {
    pgHost: "localhost",
    pgPort: 5432,
    pgDatabase: "storydb",
    pgUser: "alice",
    pgPassword: "pw",
    initialized: false,
  };
  return invokeRoute(settingsHandler, { body: { ...base, ...override } });
}

beforeAll(() => {
  originalSettingsCacheExisted = fs.existsSync(SETTINGS_CACHE_PATH);
  if (originalSettingsCacheExisted) {
    originalSettingsCacheContent = fs.readFileSync(SETTINGS_CACHE_PATH, "utf-8");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSettingsCacheFile();
});

afterAll(() => {
  restoreSettingsCacheFile();
});

describe("index db identity verification characterization", () => {
  it("returns ok from /init-db when db identity matches configured settings", async () => {
    const harness = await loadPluginHarness({ identityUser: "alice", identityDb: "storydb" });

    try {
      const settingsHandler = harness.routes.post.get("/settings");
      const initDbHandler = harness.routes.post.get("/init-db");

      const settingsRes = await configureSettings(settingsHandler);
      expect(settingsRes.statusCode).toBe(200);
      expect(settingsRes.body).toEqual({ ok: true });

      const initRes = await invokeRoute(initDbHandler, {});
      expect(initRes.statusCode).toBe(200);
      expect(initRes.body).toMatchObject({
        ok: true,
        user: "alice",
        database: "storydb",
      });
    } finally {
      harness.cleanup();
    }
  });

  it("returns 500 from /init-db when connected user does not match configured pgUser", async () => {
    const harness = await loadPluginHarness({ identityUser: "postgres", identityDb: "storydb" });

    try {
      const settingsHandler = harness.routes.post.get("/settings");
      const initDbHandler = harness.routes.post.get("/init-db");

      await configureSettings(settingsHandler, { pgUser: "alice" });
      const initRes = await invokeRoute(initDbHandler, {});

      expect(initRes.statusCode).toBe(500);
      expect(String(initRes.body.error)).toContain("configured user");
    } finally {
      harness.cleanup();
    }
  });

  it("returns 500 from /init-db when connected database does not match configured pgDatabase", async () => {
    const harness = await loadPluginHarness({ identityUser: "alice", identityDb: "otherdb" });

    try {
      const settingsHandler = harness.routes.post.get("/settings");
      const initDbHandler = harness.routes.post.get("/init-db");

      await configureSettings(settingsHandler, { pgDatabase: "storydb" });
      const initRes = await invokeRoute(initDbHandler, {});

      expect(initRes.statusCode).toBe(500);
      expect(String(initRes.body.error)).toContain("configured");
      expect(String(initRes.body.error)).toContain("database");
    } finally {
      harness.cleanup();
    }
  });

  it("auto-connect path verifies db identity when /settings enables initialized mode", async () => {
    const harness = await loadPluginHarness({ identityUser: "alice", identityDb: "storydb" });

    try {
      const settingsHandler = harness.routes.post.get("/settings");

      const settingsRes = await configureSettings(settingsHandler, {
        initialized: true,
      });
      expect(settingsRes.statusCode).toBe(200);
      expect(settingsRes.body).toEqual({ ok: true });

      const settled = await waitFor(() => harness.calls.initSchema > 0 && harness.calls.identityQuery > 0);
      expect(settled).toBe(true);
      expect(harness.calls.initSchema).toBeGreaterThan(0);
      expect(harness.calls.identityQuery).toBeGreaterThan(0);
    } finally {
      harness.cleanup();
    }
  });

  it("auto-connect path logs failure when identity verification fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await loadPluginHarness({ identityUser: "postgres", identityDb: "storydb" });

    try {
      const settingsHandler = harness.routes.post.get("/settings");
      await configureSettings(settingsHandler, {
        initialized: true,
        pgUser: "alice",
      });

      const settled = await waitFor(() =>
        consoleErrorSpy.mock.calls.some((call) => String(call[0] || "").includes("Auto-connect failed"))
      );

      expect(settled).toBe(true);
      expect(
        consoleErrorSpy.mock.calls.some((call) =>
          String(call[0] || "").includes("Auto-connect failed")
        )
      ).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});
