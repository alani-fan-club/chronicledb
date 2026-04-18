#!/usr/bin/env bash
# ChronicleDB one-shot installer for macOS, Linux, and Windows (WSL).
#
# As of v0.2.0 ChronicleDB ships with PGlite — pure-JS embedded Postgres
# with pgvector + pg_trgm built in. No system Postgres required, no
# distro-specific branches, no pg_hba.conf gymnastics. The plugin spins
# up its own database under ~/.chronicledb/pgdata on first run.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/alani-fan-club/chronicledb/master/install.sh)
#
# Or after cloning the repo manually:
#   bash install.sh
#
# Flags:
#   --external-postgres   Use an external Postgres server (Neon, Supabase,
#                         your own local pg) instead of embedded PGlite.
#                         Set host/port/db/user/password in the ST settings
#                         panel after install.
#   --skip-clone          Don't try to git-clone or git-fetch. Use when
#                         you already have the tree (tarball, release
#                         download, manual checkout). REPO_DIR must point
#                         at it.
#   -h, --help            Print usage.
#
# Idempotent — safe to re-run. Detects existing clones, existing
# symlinks, and skips work that's already done.
#
# Environment overrides (rarely needed):
#   ST_DIR               path to your SillyTavern install (auto-detected)
#   REPO_DIR             where to clone ChronicleDB (default: ~/.chronicledb)
#   EXTERNAL_POSTGRES=1  same as --external-postgres
#   SKIP_CLONE=1         same as --skip-clone

set -euo pipefail

# ── Argument parsing ────────────────────────────────────────────────
EXTERNAL_POSTGRES="${EXTERNAL_POSTGRES:-}"
SKIP_CLONE="${SKIP_CLONE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --external-postgres|--external|--skip-postgres)
      # --skip-postgres kept as an alias for v0.1.x users who memorized it.
      EXTERNAL_POSTGRES=1
      shift
      ;;
    --skip-clone)
      SKIP_CLONE=1
      shift
      ;;
    -h|--help)
      sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\nSee --help.\n' "$1" >&2
      exit 2
      ;;
  esac
done

# ── Output helpers ──────────────────────────────────────────────────
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'
  BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
fi
log()  { printf '%s[chronicledb]%s %s\n' "$BLUE"   "$RESET" "$*"; }
ok()   { printf '%s[chronicledb]%s %s\n' "$GREEN"  "$RESET" "$*"; }
warn() { printf '%s[chronicledb]%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%s[chronicledb]%s %s\n' "$RED"    "$RESET" "$*" >&2; exit 1; }

# ── 1. Detect platform ──────────────────────────────────────────────
case "$(uname -s)" in
  Darwin)              PLATFORM=macos ;;
  Linux)               PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
  *) fail "Unsupported platform: $(uname -s). Use macOS, Linux, or Windows (Git Bash / WSL)." ;;
esac
log "Platform: $PLATFORM"

# ── 2. Locate SillyTavern ───────────────────────────────────────────
ST_DIR="${ST_DIR:-}"
if [[ -z "$ST_DIR" ]]; then
  for candidate in \
    "$HOME/SillyTavern" \
    "$HOME/SillyTavern-Launcher/SillyTavern" \
    "$HOME/sillytavern" \
    "$HOME/Documents/SillyTavern" \
    "$HOME/.local/share/SillyTavern"; do
    if [[ -f "$candidate/server.js" && -f "$candidate/config.yaml" ]]; then
      ST_DIR="$candidate"
      break
    fi
  done
fi
if [[ -z "$ST_DIR" ]]; then
  printf '%bWhere is your SillyTavern install? %b' "$BOLD" "$RESET"
  read -r ST_DIR
  ST_DIR="${ST_DIR/#\~/$HOME}"
fi
[[ -f "$ST_DIR/server.js" ]] || fail "$ST_DIR doesn't look like a SillyTavern install (no server.js found)."
[[ -f "$ST_DIR/config.yaml" ]] || fail "$ST_DIR has no config.yaml. Make sure SillyTavern has been started at least once."
ok "Found SillyTavern at $ST_DIR"

# ── 3. Check Node.js ────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is required (you need 18+). Install Node and re-run."
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "Node.js 18+ required (you have $(node --version)). Upgrade Node and re-run."
fi
ok "Node $(node --version)"

# ── 4. (Optional) external Postgres pre-flight ──────────────────────
# When the user explicitly opts into external Postgres we don't install
# anything for them — they bring their own (cloud or local). We just
# make sure they know to fill in the connection fields after install.
if [[ -n "$EXTERNAL_POSTGRES" ]]; then
  log "External Postgres mode (--external-postgres). You'll paste your"
  log "  host/port/db/user/password into the ST settings panel after"
  log "  install. Make sure your DB has the 'vector' and 'pg_trgm'"
  log "  extensions available."
fi

# ── 5. Clone or update the repo ─────────────────────────────────────
REPO_DIR="${REPO_DIR:-$HOME/.chronicledb}"
REPO_URL="https://github.com/alani-fan-club/chronicledb.git"
if [[ -n "$SKIP_CLONE" ]]; then
  if [[ ! -d "$REPO_DIR" ]]; then
    fail "--skip-clone set but $REPO_DIR doesn't exist. Drop the tree there or set REPO_DIR=<path>."
  fi
  for required in server-plugin ui-extension package.json; do
    if [[ ! -e "$REPO_DIR/$required" ]]; then
      fail "$REPO_DIR/$required is missing — --skip-clone expects a full ChronicleDB tree."
    fi
  done
  log "Skipping clone/fetch (--skip-clone). Using existing tree at $REPO_DIR."
elif [[ -d "$REPO_DIR/.git" ]]; then
  log "Updating existing clone at $REPO_DIR ..."
  git -C "$REPO_DIR" fetch --quiet origin master
  git -C "$REPO_DIR" reset --hard --quiet origin/master
  ok "Updated to $(git -C "$REPO_DIR" rev-parse --short HEAD)"
else
  log "Cloning ChronicleDB to $REPO_DIR ..."
  git clone --quiet "$REPO_URL" "$REPO_DIR"
  ok "Cloned to $(git -C "$REPO_DIR" rev-parse --short HEAD)"
fi

# ── 6. npm install (top-level + server-plugin) ──────────────────────
# Top-level brings in PGlite, express, openai, zod, etc. that the plugin
# requires via realpath walk-up. Server-plugin install brings in its own
# graphology + bookkeeping deps.
log "Installing top-level dependencies (PGlite, express, openai, zod...) ..."
(
  cd "$REPO_DIR"
  npm install --silent --no-audit --no-fund --no-progress
)
ok "Top-level dependencies installed"

log "Installing server plugin dependencies ..."
(
  cd "$REPO_DIR/server-plugin"
  npm install --silent --no-audit --no-fund --no-progress
)
ok "Plugin dependencies installed"

# ── 7. Symlink server plugin into SillyTavern ───────────────────────
mkdir -p "$ST_DIR/plugins"
PLUGIN_LINK="$ST_DIR/plugins/chronicle-db"
PLUGIN_TARGET="$REPO_DIR/server-plugin"
if [[ -L "$PLUGIN_LINK" && "$(readlink "$PLUGIN_LINK")" == "$PLUGIN_TARGET" ]]; then
  ok "Server plugin symlink already in place"
elif [[ -e "$PLUGIN_LINK" && ! -L "$PLUGIN_LINK" ]]; then
  fail "$PLUGIN_LINK exists but is not a symlink. Move it aside or delete it and re-run."
else
  rm -f "$PLUGIN_LINK"
  ln -s "$PLUGIN_TARGET" "$PLUGIN_LINK"
  ok "Linked server plugin → $PLUGIN_LINK"
fi

# ── 8. Symlink UI extension into SillyTavern ────────────────────────
mkdir -p "$ST_DIR/public/scripts/extensions/third-party"
UI_LINK="$ST_DIR/public/scripts/extensions/third-party/chronicle-db"
UI_TARGET="$REPO_DIR/ui-extension"
if [[ -L "$UI_LINK" && "$(readlink "$UI_LINK")" == "$UI_TARGET" ]]; then
  ok "UI extension symlink already in place"
elif [[ -e "$UI_LINK" && ! -L "$UI_LINK" ]]; then
  fail "$UI_LINK exists but is not a symlink. Move it aside or delete it and re-run."
else
  rm -f "$UI_LINK"
  ln -s "$UI_TARGET" "$UI_LINK"
  ok "Linked UI extension → $UI_LINK"
fi

# ── 9. Patch config.yaml to enable server plugins ───────────────────
CONFIG="$ST_DIR/config.yaml"
if grep -qE '^enableServerPlugins:\s*true' "$CONFIG"; then
  ok "Server plugins already enabled in config.yaml"
elif grep -qE '^enableServerPlugins:' "$CONFIG"; then
  # Replace existing line (possibly false)
  if [[ "$PLATFORM" == "macos" ]]; then
    sed -i '' -E 's/^enableServerPlugins:.*/enableServerPlugins: true/' "$CONFIG"
  else
    sed -i -E 's/^enableServerPlugins:.*/enableServerPlugins: true/' "$CONFIG"
  fi
  ok "Set enableServerPlugins: true in config.yaml"
else
  printf '\nenableServerPlugins: true\n' >> "$CONFIG"
  ok "Appended enableServerPlugins: true to config.yaml"
fi

# ── 10. Final report ────────────────────────────────────────────────
if [[ -n "$EXTERNAL_POSTGRES" ]]; then
  DB_LINE="Database:      external (paste creds in ST settings panel)"
  RERUN_LINE="  bash $REPO_DIR/install.sh --external-postgres"
else
  DB_LINE="Database:      embedded (PGlite @ ~/.chronicledb/pgdata, created on first plugin load)"
  RERUN_LINE="  bash $REPO_DIR/install.sh"
fi

cat <<EOF

${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
${GREEN}${BOLD}ChronicleDB installed successfully!${RESET}

${BOLD}Next steps:${RESET}
  1. Restart SillyTavern (close it and run \`node server.js\` again).
  2. Open the ChronicleDB section under Extensions in the ST UI.
  3. Paste your Gemini API key (or OpenAI-compatible endpoint).
  4. Send a chat message — memory builds automatically from there.

${BOLD}Where things landed:${RESET}
  Repo:          $REPO_DIR
  Server plugin: $PLUGIN_LINK
                 → $PLUGIN_TARGET
  UI extension:  $UI_LINK
                 → $UI_TARGET
  $DB_LINE

${BOLD}Re-run later (idempotent — fixes any drift):${RESET}
$RERUN_LINE

${BOLD}Uninstall:${RESET}
  rm $PLUGIN_LINK
  rm $UI_LINK
  rm -rf ~/.chronicledb
${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
EOF
