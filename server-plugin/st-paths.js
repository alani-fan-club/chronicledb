/**
 * Resolve SillyTavern data-root paths from inside the plugin.
 *
 * Modern ST is multi-user: characters/, chats/, and worlds/ live under
 * `<ST_ROOT>/data/<user>/`. Legacy single-user installs had them at
 * `<ST_ROOT>/`. The plugin runs from `<ST_ROOT>/plugins/chronicle-db/`
 * and ST is always launched from `<ST_ROOT>` so `process.cwd()` is the
 * ST root.
 *
 * Resolution order for resolveStDataRoot:
 *   1. settings.stDataRoot if set AND it points at a directory that
 *      actually contains either `characters/` or `chats/`. (If it's
 *      configured but bogus we log once and fall through.)
 *   2. `<ST_ROOT>/data/default-user/` if it has the subdirs. This is
 *      the out-of-the-box ST layout and works for ~95% of installs.
 *   3. The first `<ST_ROOT>/data/<user>/` directory that has the
 *      subdirs (covers users who renamed the default ST account).
 *   4. Legacy single-user layout: `<ST_ROOT>/` if `characters/` or
 *      `chats/` exist there directly.
 *   5. Empty string (preserves the historical resolve("") = cwd
 *      behavior so nothing crashes on truly novel layouts).
 *
 * Closes the bug class where new users left stDataRoot blank and got
 * `ENOENT` on /character-cards, /chats/:characterName, and /lorebooks
 * because `resolve("", "characters")` = `<ST_ROOT>/characters` which
 * doesn't exist in the multi-user layout.
 */

const { existsSync, readdirSync } = require("fs");
const { join } = require("path");

const state = { warnedConfigured: false };

function isUsableUserDir(dir) {
  return existsSync(join(dir, "characters")) || existsSync(join(dir, "chats"));
}

function resolveStDataRoot(settings) {
  if (settings && typeof settings.stDataRoot === "string" && settings.stDataRoot.trim().length > 0) {
    const cfg = settings.stDataRoot.trim();
    if (existsSync(cfg) && isUsableUserDir(cfg)) return cfg;
    if (!state.warnedConfigured) {
      console.warn(
        `[ChronicleDB] stDataRoot setting "${cfg}" missing or has no characters/chats subdir; auto-detecting`,
      );
      state.warnedConfigured = true;
    }
  }
  const stRoot = process.cwd();
  const dataDir = join(stRoot, "data");
  if (existsSync(dataDir)) {
    const defaultUser = join(dataDir, "default-user");
    if (isUsableUserDir(defaultUser)) return defaultUser;
    try {
      const userDirs = readdirSync(dataDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(dataDir, d.name));
      for (const ud of userDirs) {
        if (isUsableUserDir(ud)) return ud;
      }
    } catch {
      // unreadable data/ — fall through to legacy
    }
  }
  if (isUsableUserDir(stRoot)) return stRoot;
  return "";
}

module.exports = { resolveStDataRoot };
