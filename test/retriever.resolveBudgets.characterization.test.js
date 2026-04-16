import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const retriever = require("../server-plugin/retriever.js");

describe("resolveBudgets characterization", () => {
  it("falls back to inject profile when profile is unknown", () => {
    const out = retriever.resolveBudgets({}, "unknown-profile", null);
    expect(out.profile).toBe("inject");
    expect(out.events).toBe(retriever.BUDGET_PROFILES.inject.events);
    expect(out.dialogue).toBe(retriever.BUDGET_PROFILES.inject.dialogue);
    expect(out.memory).toBe(retriever.BUDGET_PROFILES.inject.memory);
    expect(out.snapshots).toBe(retriever.BUDGET_PROFILES.inject.snapshots);
    expect(out.maxTokens).toBe(retriever.BUDGET_PROFILES.inject.maxTokens);
  });

  it("applies settings.maxInjectionTokens as default maxTokens", () => {
    const out = retriever.resolveBudgets({ maxInjectionTokens: 2222 }, "characterPanel", null);
    expect(out.profile).toBe("characterPanel");
    expect(out.maxTokens).toBe(2222);
    expect(out.events).toBe(retriever.BUDGET_PROFILES.characterPanel.events);
  });

  it("lets explicit overrides win over profile and settings", () => {
    const out = retriever.resolveBudgets(
      { maxInjectionTokens: 9999 },
      "inject",
      { events: 3, dialogue: 1, memory: 2, snapshots: 1, maxTokens: 1200 },
    );

    expect(out.profile).toBe("inject");
    expect(out.events).toBe(3);
    expect(out.dialogue).toBe(1);
    expect(out.memory).toBe(2);
    expect(out.snapshots).toBe(1);
    expect(out.maxTokens).toBe(1200);
  });

  it("ignores invalid negative overrides", () => {
    const out = retriever.resolveBudgets(
      { maxInjectionTokens: 1400 },
      "inject",
      { events: -1, dialogue: -5, memory: -2, snapshots: -3, maxTokens: -1 },
    );

    expect(out.events).toBe(retriever.BUDGET_PROFILES.inject.events);
    expect(out.dialogue).toBe(retriever.BUDGET_PROFILES.inject.dialogue);
    expect(out.memory).toBe(retriever.BUDGET_PROFILES.inject.memory);
    expect(out.snapshots).toBe(retriever.BUDGET_PROFILES.inject.snapshots);
    expect(out.maxTokens).toBe(1400);
  });

  it("ignores invalid settings.maxInjectionTokens values", () => {
    const out = retriever.resolveBudgets(
      { maxInjectionTokens: 0 },
      "characterPanel",
      null,
    );

    expect(out.profile).toBe("characterPanel");
    expect(out.maxTokens).toBe(retriever.BUDGET_PROFILES.characterPanel.maxTokens);
  });

  it("ignores non-object overrides", () => {
    const out = retriever.resolveBudgets(
      { maxInjectionTokens: 1800 },
      "mindmap",
      "not-an-object",
    );

    expect(out.profile).toBe("mindmap");
    expect(out.events).toBe(retriever.BUDGET_PROFILES.mindmap.events);
    expect(out.dialogue).toBe(retriever.BUDGET_PROFILES.mindmap.dialogue);
    expect(out.memory).toBe(retriever.BUDGET_PROFILES.mindmap.memory);
    expect(out.snapshots).toBe(retriever.BUDGET_PROFILES.mindmap.snapshots);
    expect(out.maxTokens).toBe(1800);
  });

  it("does not mutate BUDGET_PROFILES defaults", () => {
    const before = JSON.parse(JSON.stringify(retriever.BUDGET_PROFILES));

    retriever.resolveBudgets(
      { maxInjectionTokens: 1234 },
      "inject",
      { events: 99, dialogue: 88, memory: 77, snapshots: 66, maxTokens: 55 },
    );

    expect(retriever.BUDGET_PROFILES).toEqual(before);
  });
});
