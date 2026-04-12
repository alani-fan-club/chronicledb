import express from "express";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig } from "./config.js";
import { getMindMapData } from "./db/graph.js";
import { retrieve } from "./retrieval/retriever.js";
import { formatMemoryBlock } from "./retrieval/formatter.js";
import { extractFromMessages, embed } from "./extraction/extractor.js";
import type { MindMapScope, STMessage, SessionMode } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const app = express();
app.use(express.json({ limit: "10mb" }));

// Serve mind map UI
app.use("/map", express.static(resolve(__dirname, "ui")));

// ── Mind map API ───────────────────────────────────────────────

app.get("/api/graph", async (req, res) => {
  try {
    const scopeType = (req.query.scope as string) ?? "global";
    let scope: MindMapScope;

    switch (scopeType) {
      case "character":
        scope = {
          type: "character",
          characterName: req.query.character as string,
        };
        break;
      case "session":
        scope = { type: "session", sessionId: req.query.session as string };
        break;
      case "focus":
        scope = {
          type: "focus",
          nodeId: req.query.node as string,
          depth: Number(req.query.depth ?? 2),
        };
        break;
      default:
        scope = { type: "global" };
    }

    const data = await getMindMapData(config, scope);
    res.json(data);
  } catch (err) {
    console.error("[API] /api/graph error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── Extraction API ─────────────────────────────────────────────

app.post("/api/extract", async (req, res) => {
  try {
    const { characterName, userName, messages } = req.body as {
      characterName: string;
      userName: string;
      messages: STMessage[];
    };

    const result = await extractFromMessages(
      config,
      characterName,
      userName,
      messages,
    );
    res.json(result);
  } catch (err) {
    console.error("[API] /api/extract error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── Retrieval API ──────────────────────────────────────────────

app.post("/api/retrieve", async (req, res) => {
  try {
    const {
      characterName,
      chatId,
      sessionId,
      sessionMode,
      activeCharacters,
      recentText,
    } = req.body as {
      characterName: string;
      chatId: string;
      sessionId: string;
      sessionMode: SessionMode;
      activeCharacters: string[];
      recentText: string;
    };

    const result = await retrieve(config, {
      characterName,
      chatId,
      sessionId,
      sessionMode,
      activeCharacters,
      recentText,
    });

    const memoryBlock = formatMemoryBlock(result);
    res.json({ result, memoryBlock });
  } catch (err) {
    console.error("[API] /api/retrieve error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── Characters list ────────────────────────────────────────────

app.get("/api/characters", async (_req, res) => {
  try {
    const { default: pg } = await import("pg");
    // Quick query to get distinct character names from sessions or graph
    const { cypher: cypherFn } = await import("./db/connection.js");
    const rows = await cypherFn(config, `
      MATCH (c:Character) RETURN c.name as name ORDER BY c.name
    `);
    res.json(rows.map((r) => (r as Record<string, unknown>).name));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.CHRONICLE_PORT ?? 7766;
app.listen(PORT, () => {
  console.log(`ChronicleDB server running at http://localhost:${PORT}`);
  console.log(`Mind map UI: http://localhost:${PORT}/map`);
  console.log(`API: http://localhost:${PORT}/api/graph`);
});
