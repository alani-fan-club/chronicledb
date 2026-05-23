/**
 * Load and chunk a SillyTavern chat corpus for evaluation.
 *
 * Configure CHAT_PATH, CHAT_ID, CHARACTER_NAME, and the character/persona
 * cards via environment variables before running the eval. The defaults
 * below are placeholders — you must point them at your own data.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Point this at the JSONL chat file you want to evaluate.
// Override with EVAL_CHAT_PATH env var.
const CHAT_PATH =
  process.env.EVAL_CHAT_PATH ||
  resolve(
    process.env.HOME || "",
    "SillyTavern/data/default-user/chats/CharacterName/chat-file.jsonl",
  );

// The chat_id used by ChronicleDB to scope retrieval. Typically the
// chat filename without the .jsonl extension. Override with EVAL_CHAT_ID.
export const CHAT_ID =
  process.env.EVAL_CHAT_ID || "CharacterName - YYYY-MM-DD@HHhMMmSSs";

// The character card name used by ChronicleDB. Override with EVAL_CHARACTER_NAME.
export const CHARACTER_NAME = process.env.EVAL_CHARACTER_NAME || "CharacterName";

// User persona name (the {{user}} in the chat). Override with EVAL_USER_NAME.
export const USER_NAME = process.env.EVAL_USER_NAME || "User";

// ── Character + persona cards ──────────────────────────────────
// These are always part of the prompt context in real SillyTavern
// requests. The eval includes them in every condition's context budget.
//
// Replace these with your own character/persona descriptions, or load
// from environment variables / files. The placeholder text below is
// intentionally generic.

export const CHARACTER_CARD =
  process.env.EVAL_CHARACTER_CARD ||
  `=== CHARACTER ===
Name: ${CHARACTER_NAME}
[Replace this with your character card description.]`;

export const PERSONA_CARD =
  process.env.EVAL_PERSONA_CARD ||
  `=== USER PERSONA ===
Name: ${USER_NAME}
[Replace this with your user persona description.]`;

export const PREAMBLE = `${CHARACTER_CARD}\n\n${PERSONA_CARD}\n\n`;

interface ChatMessage {
  name: string;
  is_user: boolean;
  is_system?: boolean;
  mes: string;
  swipe_id?: number;
  swipes?: string[];
  send_date?: string;
}

/**
 * Load the chat file and return the concatenated narrative.
 * Uses the active swipe text per message (matches what was in context
 * during the original RP).
 */
export function loadCorpus(): { fullText: string; messageCount: number } {
  const raw = readFileSync(CHAT_PATH, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const parts: string[] = [];
  let count = 0;

  // Skip first line (metadata)
  for (let i = 1; i < lines.length; i++) {
    try {
      const msg: ChatMessage = JSON.parse(lines[i]);
      if (msg.is_system || !msg.mes) continue;
      const text =
        msg.swipe_id !== undefined && msg.swipes?.[msg.swipe_id]
          ? msg.swipes[msg.swipe_id]
          : msg.mes;
      parts.push(`[${msg.name}]: ${text}`);
      count++;
    } catch {
      // skip malformed
    }
  }

  return { fullText: parts.join("\n\n"), messageCount: count };
}

/**
 * Pick N non-overlapping random chunks from the corpus.
 * Seeded for reproducibility — the same seed always picks the same chunks.
 */
export function pickChunks(
  fullText: string,
  count: number,
  chunkSize: number = 1000,
  seed: number = 42,
): { chunk: string; offset: number }[] {
  // Simple seeded PRNG (mulberry32)
  let s = seed;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const maxOffset = fullText.length - chunkSize;
  if (maxOffset <= 0) {
    return [{ chunk: fullText, offset: 0 }];
  }

  const chunks: { chunk: string; offset: number }[] = [];
  const usedRanges: [number, number][] = [];

  let attempts = 0;
  while (chunks.length < count && attempts < count * 10) {
    attempts++;
    const offset = Math.floor(rand() * maxOffset);
    const end = offset + chunkSize;

    const overlaps = usedRanges.some(([s, e]) => !(end < s || offset > e));
    if (overlaps) continue;

    chunks.push({ chunk: fullText.slice(offset, end), offset });
    usedRanges.push([offset, end]);
  }

  return chunks;
}
