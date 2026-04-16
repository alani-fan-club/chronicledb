import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { setWithBoundedEviction } = require("../server-plugin/bounded-map.js");

describe("setWithBoundedEviction characterization", () => {
  it("evicts oldest key when inserting a new key at capacity", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);

    setWithBoundedEviction(map, "c", 3, 2);

    expect([...map.keys()]).toEqual(["b", "c"]);
    expect(map.get("c")).toBe(3);
  });

  it("does not evict when updating existing key at capacity by default", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);

    setWithBoundedEviction(map, "a", 9, 2);

    expect([...map.keys()]).toEqual(["a", "b"]);
    expect(map.get("a")).toBe(9);
    expect(map.size).toBe(2);
  });

  it("supports legacy evict-on-update behavior when enabled", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
    ]);

    setWithBoundedEviction(map, "a", 9, 2, { evictOnUpdateAtCapacity: true });

    expect([...map.keys()]).toEqual(["b", "a"]);
    expect(map.get("a")).toBe(9);
    expect(map.size).toBe(2);
  });

  it("invokes onEvict callback with the evicted key", () => {
    const map = new Map([
      ["x", 1],
      ["y", 2],
    ]);
    const onEvict = vi.fn();

    setWithBoundedEviction(map, "z", 3, 2, { onEvict });

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith("x");
    expect([...map.keys()]).toEqual(["y", "z"]);
  });
});
