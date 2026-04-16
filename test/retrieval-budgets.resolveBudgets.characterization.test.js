import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const budgets = require("../shared/retrieval-budgets.js");

describe("retrieval-budgets resolveBudgets characterization", () => {
  it("falls back to inject profile when profile is unknown", () => {
    const out = budgets.resolveBudgets({}, "unknown", null);

    expect(out.profile).toBe("inject");
    expect(out.events).toBe(budgets.BUDGET_PROFILES.inject.events);
    expect(out.dialogue).toBe(budgets.BUDGET_PROFILES.inject.dialogue);
    expect(out.memory).toBe(budgets.BUDGET_PROFILES.inject.memory);
    expect(out.snapshots).toBe(budgets.BUDGET_PROFILES.inject.snapshots);
    expect(out.maxTokens).toBe(budgets.BUDGET_PROFILES.inject.maxTokens);
  });

  it("applies settings.maxInjectionTokens when valid", () => {
    const out = budgets.resolveBudgets(
      { maxInjectionTokens: 2222 },
      "characterPanel",
      null,
    );

    expect(out.profile).toBe("characterPanel");
    expect(out.maxTokens).toBe(2222);
    expect(out.events).toBe(budgets.BUDGET_PROFILES.characterPanel.events);
  });

  it("does not mutate BUDGET_PROFILES defaults", () => {
    const before = JSON.parse(JSON.stringify(budgets.BUDGET_PROFILES));

    budgets.resolveBudgets(
      { maxInjectionTokens: 9999 },
      "inject",
      { events: 99, dialogue: 88, memory: 77, snapshots: 66, maxTokens: 55 },
    );

    expect(budgets.BUDGET_PROFILES).toEqual(before);
  });
});
