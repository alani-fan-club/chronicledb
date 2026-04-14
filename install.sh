#!/usr/bin/env bash
# ChronicleDB one-shot installer for macOS and Linux.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/alani-fan-club/chronicledb/master/install.sh)
#
# Or after cloning the repo manually:
#   bash install.sh
#
# Idempotent — safe to re-run. Detects existing clones, existing symlinks,
# existing databases, and skips work that's already done.
#
# Environment overrides (rarely needed):
#   ST_DIR     — path to your SillyTavern install (auto-detected from common
#                paths if not set)
#   REPO_DIR   — where to clone ChronicleDB (default: ~/.chronicledb)
#   DB_NAME    — Postgres database name (default: chronicledb)

set -euo pipefail

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
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)      fail "Unsupported platform: $(uname -s). install.sh supports macOS and Linux. Windows users: follow the manual install in README.md, or use WSL." ;;
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
  fail "Node.js is not installed. Install Node 18 or newer first:
    macOS:  brew install node
    Linux:  https://nodejs.org/en/download/package-manager/
    Or use nvm: https://github.com/nvm-sh/nvm"
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "Node.js 18+ required (you have $(node --version)). Upgrade Node and re-run."
fi
ok "Node $(node --version)"

# ── 4. Check PostgreSQL ─────────────────────────────────────────────
if ! command -v psql >/dev/null 2>&1; then
  fail "PostgreSQL is not installed. Install Postgres 14+ (17 recommended):
    macOS:  brew install postgresql@17 && brew services start postgresql@17
    Linux:  sudo apt-get install postgresql-17 && sudo systemctl start postgresql
  Then re-run this script."
fi
PG_VERSION=$(psql --version | grep -oE '[0-9]+' | head -1)
if [[ "$PG_VERSION" -lt 14 ]]; then
  fail "PostgreSQL 14+ required (you have $PG_VERSION). 17 recommended."
fi
if ! psql -tAc "SELECT 1" >/dev/null 2>&1; then
  fail "PostgreSQL is installed but psql can't connect. Make sure the server is running:
    macOS:  brew services start postgresql@17
    Linux:  sudo systemctl start postgresql
  And that your user has a Postgres role. If you're new to Postgres on Linux:
    sudo -u postgres createuser --superuser \"\$USER\""
fi
ok "PostgreSQL $PG_VERSION (running, current user can connect)"

# ── 5. Check pgvector extension ─────────────────────────────────────
TMP_DB="chronicledb_pgvector_check_$$"
if createdb "$TMP_DB" 2>/dev/null && \
   psql -d "$TMP_DB" -tAc "CREATE EXTENSION IF NOT EXISTS vector; DROP EXTENSION vector;" >/dev/null 2>&1; then
  PGVECTOR_OK=1
else
  PGVECTOR_OK=0
fi
dropdb "$TMP_DB" 2>/dev/null || true
if [[ "$PGVECTOR_OK" -eq 0 ]]; then
  case "$PLATFORM" in
    macos) PGV_CMD="brew install pgvector" ;;
    linux) PGV_CMD="sudo apt-get install postgresql-${PG_VERSION}-pgvector" ;;
  esac
  fail "pgvector extension is not installed in your Postgres binary. Install it:
    $PGV_CMD
  Then re-run this script."
fi
ok "pgvector is available"

# ── 6. Clone or update the repo ─────────────────────────────────────
REPO_DIR="${REPO_DIR:-$HOME/.chronicledb}"
REPO_URL="https://github.com/alani-fan-club/chronicledb.git"
if [[ -d "$REPO_DIR/.git" ]]; then
  log "Updating existing clone at $REPO_DIR ..."
  git -C "$REPO_DIR" fetch --quiet origin master
  git -C "$REPO_DIR" reset --hard --quiet origin/master
  ok "Updated to $(git -C "$REPO_DIR" rev-parse --short HEAD)"
else
  log "Cloning ChronicleDB to $REPO_DIR ..."
  git clone --quiet "$REPO_URL" "$REPO_DIR"
  ok "Cloned to $(git -C "$REPO_DIR" rev-parse --short HEAD)"
fi

# ── 7. npm install in server-plugin ─────────────────────────────────
log "Installing server plugin dependencies (graphology, pg, pgvector...) ..."
(
  cd "$REPO_DIR/server-plugin"
  npm install --silent --no-audit --no-fund --no-progress
)
ok "Plugin dependencies installed"

# ── 8. Symlink server plugin into SillyTavern ───────────────────────
mkdir -p "$ST_DIR/plugins"
PLUGIN_LINK="$ST_DIR/plugins/chronicle-db"
PLUGIN_TARGET="$REPO_DIR/server-plugin"
if [[ -L "$PLUGIN_LINK" ]]; then
  CURRENT="$(readlink "$PLUGIN_LINK")"
  if [[ "$CURRENT" != "$PLUGIN_TARGET" ]]; then
    warn "$PLUGIN_LINK points elsewhere ($CURRENT) — replacing"
    rm "$PLUGIN_LINK"
    ln -s "$PLUGIN_TARGET" "$PLUGIN_LINK"
  fi
elif [[ -e "$PLUGIN_LINK" ]]; then
  fail "$PLUGIN_LINK exists but is not a symlink. Move it aside or delete it and re-run."
else
  ln -s "$PLUGIN_TARGET" "$PLUGIN_LINK"
fi
ok "Server plugin linked at $PLUGIN_LINK"

# ── 9. Symlink UI extension into SillyTavern ────────────────────────
mkdir -p "$ST_DIR/public/scripts/extensions/third-party"
UI_LINK="$ST_DIR/public/scripts/extensions/third-party/chronicle-db"
UI_TARGET="$REPO_DIR/ui-extension"
if [[ -L "$UI_LINK" ]]; then
  CURRENT="$(readlink "$UI_LINK")"
  if [[ "$CURRENT" != "$UI_TARGET" ]]; then
    warn "$UI_LINK points elsewhere ($CURRENT) — replacing"
    rm "$UI_LINK"
    ln -s "$UI_TARGET" "$UI_LINK"
  fi
elif [[ -e "$UI_LINK" ]]; then
  fail "$UI_LINK exists but is not a symlink. Move it aside or delete it and re-run."
else
  ln -s "$UI_TARGET" "$UI_LINK"
fi
ok "UI extension linked at $UI_LINK"

# ── 10. Patch config.yaml to enable server plugins ──────────────────
CONFIG="$ST_DIR/config.yaml"
if grep -qE '^enableServerPlugins:\s*true' "$CONFIG"; then
  ok "Server plugins already enabled in config.yaml"
else
  log "Enabling server plugins in $CONFIG ..."
  if grep -qE '^enableServerPlugins:' "$CONFIG"; then
    if [[ "$PLATFORM" == "macos" ]]; then
      sed -i '' 's/^enableServerPlugins:.*/enableServerPlugins: true/' "$CONFIG"
    else
      sed -i 's/^enableServerPlugins:.*/enableServerPlugins: true/' "$CONFIG"
    fi
  else
    printf '\nenableServerPlugins: true\n' >> "$CONFIG"
  fi
  ok "Server plugins enabled in config.yaml"
fi

# ── 11. Create database and enable extensions ───────────────────────
DB_NAME="${DB_NAME:-chronicledb}"
if psql -lqt | cut -d '|' -f 1 | grep -qw "$DB_NAME"; then
  ok "Database '$DB_NAME' already exists"
else
  log "Creating database '$DB_NAME' ..."
  createdb "$DB_NAME"
  ok "Database '$DB_NAME' created"
fi
log "Enabling extensions in $DB_NAME ..."
psql -d "$DB_NAME" -tAc "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null
ok "Extensions enabled (vector, pg_trgm)"

# ── 12. Final report ────────────────────────────────────────────────
cat <<EOF

${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
${GREEN}${BOLD}ChronicleDB installed successfully!${RESET}

${BOLD}Next steps:${RESET}
  1. Restart SillyTavern (close it and run \`node server.js\` again).
  2. Open the ChronicleDB section under Extensions in the ST UI.
  3. Paste your Gemini API key (or OpenAI-compatible endpoint).
  4. Click "Connect & initialize".

${BOLD}Where things landed:${RESET}
  Repo:          $REPO_DIR
  Server plugin: $PLUGIN_LINK
                 → $PLUGIN_TARGET
  UI extension:  $UI_LINK
                 → $UI_TARGET
  Database:      $DB_NAME (host: localhost, user: $(whoami))

${BOLD}Re-run later (idempotent — fixes any drift):${RESET}
  bash $REPO_DIR/install.sh

${BOLD}Uninstall:${RESET}
  rm $PLUGIN_LINK
  rm $UI_LINK
  dropdb $DB_NAME
  rm -rf $REPO_DIR
${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
EOF
