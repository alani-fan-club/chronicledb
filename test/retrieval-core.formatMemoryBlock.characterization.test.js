import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../shared/retrieval-core.js");

describe("formatMemoryBlock characterization", () => {
  function buildRichResult() {
    return {
      locations: [{ entity: "Alice", location: "Docks" }],
      worldState: [{ key: "weather", value: "rain", since: new Date().toISOString() }],
      plotThreads: [{ thread_type: "pending", title: "Hidden Ledger", description: "Ledger has not been found", involved_chars: ["Alice"] }],
      fusedHits: [
        {
          kind: "memory",
          key: "m:1",
          memory: {
            id: "1",
            similarity: 0.91,
            message_index: 42,
            context_prefix: "Earlier that night",
            raw_text: "Alice said she buried the key near the eastern gate.",
            content: "Alice buried the key near the eastern gate.",
          },
        },
        {
          kind: "event",
          key: "e:1",
          event: {
            id: "evt-1",
            message_index: 42,
            source_text: "A fight breaks out near the tavern entrance.",
          },
        },
        {
          kind: "dialogue",
          key: "d:1",
          dialogue: {
            id: "dlg-1",
            message_index: 43,
            speaker: "Alice",
            quote: "Do not trust the captain.",
          },
        },
        {
          kind: "snapshot",
          key: "s:1",
          snapshot: {
            id: "snap-1",
            message_index: 43,
            summary: "Crowded market with rising tension.",
            location_name: "Market",
            emotional_tone: "uneasy",
          },
        },
      ],
      neighborPadding: new Map(),
      arcExpansion: new Map([
        [
          "evt-1",
          {
            arcTitle: "Dockside Conspiracy",
            arcStatus: "active",
            arcDescription: "Clues around smuggling routes.",
          },
        ],
      ]),
      snapshots: [{ summary: "The market is tense.", location_name: "Market", emotional_tone: "uneasy" }],
      events: [
        {
          summary: "Alice confronts the captain.",
          source_text: "She steps in front of him and demands answers.",
          significance: 4,
          participants: ["Alice", "Captain"],
          message_index: 43,
        },
      ],
      knowledge: [{ character: "Alice", knows: ["The ledger exists"], doesNotKnow: ["Who forged it"] }],
      relationships: [
        {
          from_name: "Alice",
          to_name: "Captain",
          sentiment: -0.6,
          intensity: 0.8,
          description: "Mutual distrust",
        },
      ],
    };
  }

  it("keeps section order stable for major headings", () => {
    const block = core.formatMemoryBlock(buildRichResult(), 12000);

    const currentScene = block.indexOf("## Current Scene");
    const worldState = block.indexOf("## World State");
    const plotThreads = block.indexOf("## Active Plot Threads");
    const context = block.indexOf("## Relevant Past Context");
    const relationships = block.indexOf("## Relationships");

    expect(currentScene).toBeGreaterThanOrEqual(0);
    expect(worldState).toBeGreaterThan(currentScene);
    expect(plotThreads).toBeGreaterThan(worldState);
    expect(context).toBeGreaterThan(plotThreads);
    expect(relationships).toBeGreaterThan(context);
  });

  it("preserves opening and closing delimiters when not truncated", () => {
    const block = core.formatMemoryBlock(buildRichResult(), 12000);
    expect(block.startsWith("[ChronicleDB Memory Context]")).toBe(true);
    expect(block.endsWith("[/ChronicleDB Memory Context]")).toBe(true);
    expect(block.includes("[...truncated]")).toBe(false);
  });

  it("returns a valid wrapper for empty input", () => {
    const block = core.formatMemoryBlock({}, 12000);
    expect(block.startsWith("[ChronicleDB Memory Context]")).toBe(true);
    expect(block.endsWith("[/ChronicleDB Memory Context]")).toBe(true);
    expect(block.includes("## ")).toBe(false);
  });

  it("preserves truncation marker and closing delimiter when truncated", () => {
    const huge = buildRichResult();
    huge.fusedHits[0].memory.raw_text = "X".repeat(10000);

    const block = core.formatMemoryBlock(huge, 240);
    expect(block.includes("[...truncated]")).toBe(true);
    expect(block.endsWith("[/ChronicleDB Memory Context]")).toBe(true);
    expect(block.length).toBeLessThanOrEqual(240);
  });
});
