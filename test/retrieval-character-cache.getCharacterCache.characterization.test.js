import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  CHARACTER_CACHE_TTL_MS,
  getCharacterCache,
} = require("../shared/retrieval-character-cache.js");

describe("retrieval-character-cache characterization", () => {
  it("returns null for falsy chat id", () => {
    const map = new Map();

    expect(getCharacterCache(map, null)).toBeNull();
    expect(getCharacterCache(map, "")).toBeNull();
  });

  it("creates and stores a cache entry on first access", () => {
    const map = new Map();

    const entry = getCharacterCache(map, "chat-a");

    expect(entry).toEqual({ chatId: "chat-a", entries: [], expiresAt: 0 });
    expect(map.get("chat-a")).toBe(entry);
  });

  it("returns the same cache object on repeated access", () => {
    const map = new Map();

    const first = getCharacterCache(map, "chat-b");
    first.entries.push({ id: "c1", needle: "alice" });
    first.expiresAt = Date.now() + CHARACTER_CACHE_TTL_MS;

    const second = getCharacterCache(map, "chat-b");

    expect(second).toBe(first);
    expect(second.entries).toHaveLength(1);
    expect(second.expiresAt).toBe(first.expiresAt);
  });

  it("exports the expected default TTL constant", () => {
    expect(CHARACTER_CACHE_TTL_MS).toBe(5 * 60 * 1000);
  });
});
