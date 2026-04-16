import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  filterFusedHitsByPov,
  applyPovFilter,
} = require("../shared/retrieval-pov.js");

function makeUniverse() {
  return {
    eventIds: new Set(["e1"]),
    eventMessageIndexes: new Set([10]),
    factIds: new Set(["f1"]),
    locationIds: new Set(["l1"]),
    itemIds: new Set(["i1"]),
    characterIds: new Set(["c1"]),
  };
}

describe("retrieval-pov characterization", () => {
  it("filters fused hits by kind-specific universe rules", () => {
    const hits = [
      { kind: "event", event: { id: "e1" }, marker: "keep-event" },
      { kind: "event", event: { id: "e2" }, marker: "drop-event" },
      { kind: "dialogue", dialogue: { message_index: 10 }, marker: "keep-dialogue" },
      { kind: "dialogue", dialogue: { message_index: 11 }, marker: "drop-dialogue" },
      { kind: "snapshot", marker: "keep-snapshot" },
      { kind: "memory", memory: { node_type: "lore" }, marker: "keep-lore" },
      { kind: "memory", memory: { node_type: "message", message_index: 10 }, marker: "keep-message" },
      { kind: "memory", memory: { node_type: "message_chunk", message_index: 11 }, marker: "drop-message-chunk" },
      { kind: "memory", memory: { node_type: "event", node_id: "e1" }, marker: "keep-memory-event" },
      { kind: "memory", memory: { node_type: "event", node_id: "e2" }, marker: "drop-memory-event" },
      { kind: "memory", memory: { node_type: "fact", node_id: "f1" }, marker: "keep-fact" },
      { kind: "memory", memory: { node_type: "character", node_id: "c1" }, marker: "keep-character" },
      { kind: "memory", memory: { node_type: "location", node_id: "l1" }, marker: "keep-location" },
      { kind: "memory", memory: { node_type: "item", node_id: "i1" }, marker: "keep-item" },
      { kind: "memory", memory: { node_type: "unknown", node_id: "x1" }, marker: "drop-unknown-node-type" },
      { kind: "unknown", marker: "drop-unknown-kind" },
    ];

    const out = filterFusedHitsByPov(hits, makeUniverse());
    const keptMarkers = out.map((h) => h.marker);

    expect(keptMarkers).toEqual([
      "keep-event",
      "keep-dialogue",
      "keep-snapshot",
      "keep-lore",
      "keep-message",
      "keep-memory-event",
      "keep-fact",
      "keep-character",
      "keep-location",
      "keep-item",
    ]);
  });

  it("applies in-place result filtering and refreshes convenience views", () => {
    const result = {
      events: [
        { message_index: 10, summary: "keep" },
        { message_index: 11, summary: "drop" },
        { message_index: null, summary: "keep-null" },
      ],
      fusedHits: [
        { kind: "memory", memory: { id: "m1", node_type: "message", message_index: 10 } },
        { kind: "memory", memory: { id: "m2", node_type: "message", message_index: 11 } },
        { kind: "event", event: { id: "e1" } },
        { kind: "event", event: { id: "e2" } },
        { kind: "dialogue", dialogue: { id: "d1", message_index: 10 } },
        { kind: "dialogue", dialogue: { id: "d2", message_index: 11 } },
        { kind: "snapshot", snapshot: { id: "s1" } },
      ],
      vectorResults: [{ id: "old-memory-view" }],
      eventHits: [{ id: "old-event-view" }],
      dialogueHits: [{ id: "old-dialogue-view" }],
      neighborPadding: new Map([[10, { id: "n10" }], [11, { id: "n11" }]]),
      arcExpansion: new Map([["e1", { id: "a1" }], ["e2", { id: "a2" }]]),
    };

    const returned = applyPovFilter(result, makeUniverse());

    expect(returned).toBe(result);
    expect(result.events.map((e) => e.summary)).toEqual(["keep", "keep-null"]);
    expect(result.fusedHits.map((h) => h.kind)).toEqual(["memory", "event", "dialogue", "snapshot"]);
    expect(result.vectorResults).toEqual([{ id: "m1", node_type: "message", message_index: 10 }]);
    expect(result.eventHits).toEqual([{ id: "e1" }]);
    expect(result.dialogueHits).toEqual([{ id: "d1", message_index: 10 }]);
    expect([...result.neighborPadding.keys()]).toEqual([10]);
    expect([...result.arcExpansion.keys()]).toEqual(["e1"]);
  });
});
