import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import type { STChatMetadata, STMessage } from "../types.js";

export interface ParsedChat {
  characterName: string;
  userName: string;
  chatId: string;
  createDate: string;
  filename: string;
  messages: STMessage[];
}

/**
 * Parse a single SillyTavern .jsonl chat file.
 * First line is metadata, subsequent lines are messages.
 */
export function parseChatFile(filePath: string): ParsedChat {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    throw new Error(`Empty chat file: ${filePath}`);
  }

  const metadata: STChatMetadata = JSON.parse(lines[0]);
  const messages: STMessage[] = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]) as STMessage;
      if (msg.mes !== undefined) {
        messages.push(msg);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    characterName: metadata.character_name,
    userName: metadata.user_name,
    chatId: String(metadata.chat_metadata?.chat_id_hash ?? basename(filePath)),
    createDate: metadata.create_date,
    filename: basename(filePath),
    messages,
  };
}

/**
 * Discover all chat files for all characters under the ST chats directory.
 * Returns them grouped by character name.
 */
export function discoverChats(
  chatsDir: string,
): Map<string, { dirName: string; files: string[] }> {
  const result = new Map<string, { dirName: string; files: string[] }>();

  const entries = readdirSync(chatsDir);
  for (const entry of entries) {
    const dirPath = join(chatsDir, entry);
    if (!statSync(dirPath).isDirectory()) continue;

    const chatFiles = readdirSync(dirPath)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dirPath, f))
      .sort(); // chronological by filename convention

    if (chatFiles.length > 0) {
      result.set(entry, { dirName: entry, files: chatFiles });
    }
  }

  return result;
}

/**
 * Get the active message text for a message, accounting for swipes.
 * ST stores the currently selected swipe in `mes` and all alternatives in `swipes`.
 */
export function getActiveMessageText(msg: STMessage): string {
  if (msg.swipe_id !== undefined && msg.swipes && msg.swipes[msg.swipe_id]) {
    return msg.swipes[msg.swipe_id];
  }
  return msg.mes;
}

/**
 * Batch messages into windows for extraction.
 * Each window contains `batchSize` messages with overlap for context.
 */
export function batchMessages(
  messages: STMessage[],
  batchSize: number,
  overlap: number = 2,
): STMessage[][] {
  const batches: STMessage[][] = [];
  for (let i = 0; i < messages.length; i += batchSize - overlap) {
    const batch = messages.slice(i, i + batchSize);
    if (batch.length > 0) batches.push(batch);
  }
  return batches;
}
