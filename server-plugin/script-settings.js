const { existsSync, readFileSync } = require("fs");
const { resolve, join } = require("path");
const { buildClient } = require("./db/client");
const dotenv = require("dotenv");

const DEFAULT_CONFIG_PATH = resolve(__dirname, "..", "chronicledb.config.json");
const EVAL_ENV_PATH = join(__dirname, "..", "eval", ".env");
const ROOT_ENV_PATH = resolve(__dirname, "..", ".env");

function resolveDefaultPgUser() {
  return process.env.USER || process.env.USERNAME || "";
}

function loadScriptEnv() {
  if (existsSync(EVAL_ENV_PATH)) {
    dotenv.config({ path: EVAL_ENV_PATH });
    return EVAL_ENV_PATH;
  }
  if (existsSync(ROOT_ENV_PATH)) {
    dotenv.config({ path: ROOT_ENV_PATH });
    return ROOT_ENV_PATH;
  }
  return null;
}

function loadScriptConfig(options) {
  const opts = options && typeof options === "object" ? options : {};
  const configPath = opts.configPath || DEFAULT_CONFIG_PATH;

  if (!existsSync(configPath)) {
    if (opts.required === true) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    return {};
  }

  let raw = "";
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read config file ${configPath}: ${err.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${err.message}`);
  }
}

function buildScriptSettings(cfg) {
  const config = cfg && typeof cfg === "object" ? cfg : {};
  const dbCfg = config.database || {};
  const embedCfg = config.embedding || {};
  const extractionCfg = config.extraction || {};

  return {
    pgHost: process.env.PGHOST || dbCfg.host || "localhost",
    pgPort: parseInt(process.env.PGPORT || dbCfg.port || "5432", 10),
    pgDatabase: process.env.PGDATABASE || dbCfg.database || "chronicledb",
    pgUser: process.env.PGUSER || dbCfg.user || resolveDefaultPgUser(),
    pgPassword: process.env.PGPASSWORD || dbCfg.password || "",
    geminiApiKey: process.env.GEMINI_API_KEY || embedCfg.apiKey || "",
    extractionApiKey: process.env.GEMINI_API_KEY || embedCfg.apiKey || "",
    extractionApiType: process.env.EXTRACTION_API_TYPE || "gemini",
    extractionModel: process.env.GEMINI_LLM_MODEL || extractionCfg.model || "gemini-2.5-flash-lite",
    contextModel: process.env.GEMINI_CONTEXT_MODEL || "gemini-2.5-flash-lite",
    geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL || embedCfg.model || "gemini-embedding-2-preview",
    geminiEmbeddingDimension: parseInt(process.env.GEMINI_EMBEDDING_DIM || embedCfg.dimension || "768", 10),
    stDataRoot: config.sillytavern?.dataRoot || "",
  };
}

function loadScriptSettings(options) {
  const opts = options && typeof options === "object" ? options : {};
  if (opts.loadEnv !== false) {
    loadScriptEnv();
  }
  const config = loadScriptConfig({
    configPath: opts.configPath,
    required: opts.requiredConfig === true,
  });
  const settings = buildScriptSettings(config);
  return { config, settings };
}

function createPoolFromSettings(settings) {
  // Returns a backend-agnostic client adapter (PGlite or pg.Pool)
  // matching the .query / .connect / .end surface. Kept named
  // createPoolFromSettings for back-compat with CLI/test callers.
  return buildClient(settings);
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  loadScriptEnv,
  loadScriptConfig,
  buildScriptSettings,
  loadScriptSettings,
  createPoolFromSettings,
  resolveDefaultPgUser,
};
