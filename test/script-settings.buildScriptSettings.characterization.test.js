import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildScriptSettings,
  resolveDefaultPgUser,
} = require("../server-plugin/script-settings.js");

const ENV_KEYS = [
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "GEMINI_API_KEY",
  "GEMINI_LLM_MODEL",
  "GEMINI_CONTEXT_MODEL",
  "GEMINI_EMBEDDING_MODEL",
  "GEMINI_EMBEDDING_DIM",
  "EXTRACTION_API_TYPE",
  "USER",
  "USERNAME",
];

const ORIGINAL_ENV = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

function clearManagedEnv() {
  for (const k of ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(process.env, k)) {
      delete process.env[k];
    }
  }
}

describe("script settings characterization", () => {
  beforeEach(() => {
    clearManagedEnv();
  });

  afterEach(() => {
    clearManagedEnv();
    for (const k of ENV_KEYS) {
      if (ORIGINAL_ENV[k] !== undefined) process.env[k] = ORIGINAL_ENV[k];
    }
  });

  it("uses config values when env overrides are absent", () => {
    process.env.USERNAME = "os-user";

    const out = buildScriptSettings({
      database: {
        host: "cfg-host",
        port: 7777,
        database: "cfg-db",
        user: "cfg-user",
        password: "cfg-pass",
      },
      embedding: {
        apiKey: "cfg-key",
        model: "cfg-embed-model",
        dimension: 1024,
      },
      extraction: {
        model: "cfg-extract-model",
      },
      sillytavern: {
        dataRoot: "C:/st-data",
      },
    });

    expect(out.pgHost).toBe("cfg-host");
    expect(out.pgPort).toBe(7777);
    expect(out.pgDatabase).toBe("cfg-db");
    expect(out.pgUser).toBe("cfg-user");
    expect(out.pgPassword).toBe("cfg-pass");
    expect(out.geminiApiKey).toBe("cfg-key");
    expect(out.extractionApiKey).toBe("cfg-key");
    expect(out.extractionModel).toBe("cfg-extract-model");
    expect(out.geminiEmbeddingModel).toBe("cfg-embed-model");
    expect(out.geminiEmbeddingDimension).toBe(1024);
    expect(out.stDataRoot).toBe("C:/st-data");
  });

  it("lets env vars override config values", () => {
    process.env.PGHOST = "env-host";
    process.env.PGPORT = "6000";
    process.env.PGDATABASE = "env-db";
    process.env.PGUSER = "env-user";
    process.env.PGPASSWORD = "env-pass";
    process.env.GEMINI_API_KEY = "env-key";
    process.env.GEMINI_LLM_MODEL = "env-llm";
    process.env.GEMINI_CONTEXT_MODEL = "env-context";
    process.env.GEMINI_EMBEDDING_MODEL = "env-embed";
    process.env.GEMINI_EMBEDDING_DIM = "1536";
    process.env.EXTRACTION_API_TYPE = "gemini";

    const out = buildScriptSettings({
      database: {
        host: "cfg-host",
        port: 7777,
        database: "cfg-db",
        user: "cfg-user",
        password: "cfg-pass",
      },
      embedding: {
        apiKey: "cfg-key",
        model: "cfg-embed-model",
        dimension: 1024,
      },
      extraction: {
        model: "cfg-extract-model",
      },
    });

    expect(out.pgHost).toBe("env-host");
    expect(out.pgPort).toBe(6000);
    expect(out.pgDatabase).toBe("env-db");
    expect(out.pgUser).toBe("env-user");
    expect(out.pgPassword).toBe("env-pass");
    expect(out.geminiApiKey).toBe("env-key");
    expect(out.extractionApiKey).toBe("env-key");
    expect(out.extractionModel).toBe("env-llm");
    expect(out.contextModel).toBe("env-context");
    expect(out.geminiEmbeddingModel).toBe("env-embed");
    expect(out.geminiEmbeddingDimension).toBe(1536);
  });

  it("falls back to OS username when pg user is not configured", () => {
    process.env.USER = "";
    process.env.USERNAME = "windows-user";

    const out = buildScriptSettings({});

    expect(out.pgUser).toBe("windows-user");
    expect(resolveDefaultPgUser()).toBe("windows-user");
  });
});
