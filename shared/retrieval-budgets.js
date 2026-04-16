/**
 * Shared per-consumer retrieval budget profiles and resolver.
 *
 * Extracted from server-plugin/retriever.js so budget ownership is no
 * longer tied to one orchestrator. Keeping this in `shared/` prevents
 * profile drift between callers and keeps rationale next to behavior.
 */

// ── Per-consumer budget profiles ────────────────────────────────
//
// Different callers of /retrieve want wildly different slice sizes out
// of the same underlying corpus. The main generation inject path needs
// a big helping of events, quotes, and snippets to prime the model;
// the character-panel sidebar is a tiny glance and should not eat 3k
// tokens; the mindmap UI wants structural events only (no prose, no
// scene snapshots).
//
// A profile is a per-kind cap + an overall maxTokens render ceiling.
// Caller picks one by name via `budgetProfile` and can override any
// individual field explicitly. `settings.maxInjectionTokens` (the
// legacy knob on the UI extension side) still wins for the inject
// profile so existing user settings keep working.

const BUDGET_PROFILES = {
  inject: { events: 12, dialogue: 8, memory: 10, snapshots: 3, maxTokens: 3000 },
  characterPanel: { events: 5, dialogue: 0, memory: 5, snapshots: 0, maxTokens: 1500 },
  mindmap: { events: 30, dialogue: 0, memory: 0, snapshots: 0, maxTokens: 8000 },
};

/**
 * Merge a budget profile with settings + explicit per-field overrides.
 *
 * Precedence (highest wins):
 *   1. explicit per-field overrides from the caller (overrides arg)
 *   2. settings.maxInjectionTokens (legacy UI knob → inject profile's
 *      maxTokens; also honored for other profiles because users tuning
 *      this knob generally mean "cap every memory block at N tokens")
 *   3. the named profile's defaults
 *
 * Unknown profile names fall through to the "inject" profile — it's a
 * safer default than throwing at the retrieval boundary on a typo.
 */
function resolveBudgets(settings, profileName, overrides) {
  const name = profileName && BUDGET_PROFILES[profileName] ? profileName : "inject";
  const base = BUDGET_PROFILES[name];
  const merged = { ...base };

  const settingsMaxTokens = Number(settings && settings.maxInjectionTokens);
  if (Number.isFinite(settingsMaxTokens) && settingsMaxTokens > 0) {
    merged.maxTokens = settingsMaxTokens;
  }

  if (overrides && typeof overrides === "object") {
    for (const key of ["events", "dialogue", "memory", "snapshots", "maxTokens"]) {
      const v = overrides[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        merged[key] = v;
      }
    }
  }

  merged.profile = name;
  return merged;
}

module.exports = {
  BUDGET_PROFILES,
  resolveBudgets,
};
