import { readFileSync } from "fs";
import { resolve } from "path";
import type { SessionMode } from "./types.js";

export interface ChronicleConfig {
  sillytavern: {
    dataRoot: string;
    chatsDir: string;
    charactersDir: string;
  };
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  extraction: {
    endpoint: string;
    model: string;
    embeddingModel: string;
    batchSize: number;
    debounceMs: number;
  };
  sessions: {
    defaultMode: SessionMode;
  };
}

const CONFIG_FILENAME = "chronicledb.config.json";

export function loadConfig(configPath?: string): ChronicleConfig {
  const path = configPath ?? resolve(process.cwd(), CONFIG_FILENAME);
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as ChronicleConfig;
}

export function getChatsPath(config: ChronicleConfig): string {
  return resolve(config.sillytavern.dataRoot, config.sillytavern.chatsDir);
}

export function getCharactersPath(config: ChronicleConfig): string {
  return resolve(
    config.sillytavern.dataRoot,
    config.sillytavern.charactersDir,
  );
}
