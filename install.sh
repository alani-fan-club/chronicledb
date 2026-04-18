#!/usr/bin/env bash
# ChronicleDB one-shot installer for macOS and Linux.
#
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/alani-fan-club/chronicledb/master/install.sh)
#
# Or after cloning the repo manually:
#   bash install.sh
#
# Flags:
#   --skip-postgres    Don't install / check / create a local Postgres.
#                      Use this when you're pointing ChronicleDB at a cloud
#                      DB (Neon, Supabase, etc.); you'll paste the creds in
#                      the ST settings panel after the script completes.
#   --skip-clone       Don't try to git-clone or git-fetch the repo. Use
#                      this when you've already got the tree (tarball,
#                      release download, manual checkout); the script
#                      expects REPO_DIR to point at it and just does the
#                      npm install + symlinks + DB bootstrap.
#   -h, --help         Print usage.
#
# Idempotent — safe to re-run. Detects existing clones, existing symlinks,
# existing databases, and skips work that's already done.
#
# Environment overrides (rarely needed):
#   ST_DIR             path to your SillyTavern install (auto-detected
#                      from common paths if not set)
#   REPO_DIR           where to clone ChronicleDB (default: ~/.chronicledb)
#   DB_NAME            Postgres database name (default: chronicledb)
#   SKIP_POSTGRES=1    same as --skip-postgres
#   SKIP_CLONE=1       same as --skip-clone

set -euo pipefail

# ── Argument parsing ────────────────────────────────────────────────
SKIP_POSTGRES="${SKIP_POSTGRES:-}"
SKIP_CLONE="${SKIP_CLONE:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-postgres|--cloud)
      SKIP_POSTGRES=1
      shift
      ;;
    --skip-clone)
      SKIP_CLONE=1
      shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
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

# Prompt the user for yes/no with a default. Returns 0 for yes, 1 for no.
# If stdin isn't a TTY (e.g. piped install), falls back to the default
# silently — never block on input.
prompt_yes() {
  local prompt="$1"
  local default="${2:-y}"
  if [[ ! -t 0 ]]; then
    [[ "$default" == "y" ]] && return 0 || return 1
  fi
  local hint=$([[ "$default" == "y" ]] && echo "[Y/n]" || echo "[y/N]")
  local reply
  printf '%s[chronicledb]%s %s %s ' "$YELLOW" "$RESET" "$prompt" "$hint"
  read -r reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

# Run a command, optionally with sudo if the platform needs it.
run_install() {
  local cmd="$1"
  log "Running: $cmd"
  eval "$cmd"
}

# True when a Postgres *server* (not just the psql client) is installed.
# On Debian-land the client and server travel together; on Fedora/RHEL
# they're split packages. Checking for the systemd unit file catches the
# Fedora gotcha where `command -v psql` succeeds without a real server.
pg_server_installed() {
  if [[ "${PLATFORM:-}" == "macos" ]]; then
    command -v psql >/dev/null 2>&1
  else
    command -v psql >/dev/null 2>&1 \
      && systemctl list-unit-files 2>/dev/null | grep -q '^postgresql\.service'
  fi
}

# Create a Postgres database matching the OS username, so that `psql`
# with no -d flag (which defaults to dbname=$USER) resolves to something.
# Debian's postgresql-common postinst does this automatically; Fedora's
# postgresql-server does not.
ensure_user_db() {
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$USER'" 2>/dev/null | grep -q 1; then
    log "Creating Postgres database '$USER' for OS-user shortcuts ..."
    sudo -u postgres createdb "$USER" 2>/dev/null || true
  fi
}

# Fedora's default pg_hba.conf uses 'ident' auth on TCP loopback, which
# requires an ident daemon nobody's run since ~2003. Node apps
# (node-postgres, ChronicleDB) connect via TCP by default, so they hit
# this and fail with "Ident authentication failed". Offer to rewrite to
# 'trust' (fine for single-user dev machines, explicitly NOT fine on
# shared hosts or anything exposing Postgres beyond loopback).
ensure_loopback_trust() {
  local PG_HBA
  PG_HBA=$(sudo -u postgres psql -tAc "SHOW hba_file" 2>/dev/null | tr -d '[:space:]')
  [[ -z "$PG_HBA" || ! -f "$PG_HBA" ]] && return 0
  if ! sudo grep -qE '^host[[:space:]]+all[[:space:]]+all[[:space:]]+127\.0\.0\.1/32[[:space:]]+ident' "$PG_HBA"; then
    return 0
  fi
  warn "pg_hba.conf uses 'ident' auth on TCP loopback — Node apps can't satisfy ident without an ident daemon running."
  if prompt_yes "Rewrite 127.0.0.1 + ::1 loopback lines to 'trust' so ChronicleDB can connect? (safe on a single-user dev laptop; NOT safe on shared hosts)"; then
    sudo cp "$PG_HBA" "${PG_HBA}.chronicledb-backup"
    sudo sed -i -E 's|^(host[[:space:]]+all[[:space:]]+all[[:space:]]+127\.0\.0\.1/32[[:space:]]+)ident[[:space:]]*$|\1trust|' "$PG_HBA"
    sudo sed -i -E 's|^(host[[:space:]]+all[[:space:]]+all[[:space:]]+::1/128[[:space:]]+)ident[[:space:]]*$|\1trust|' "$PG_HBA"
    run_install "sudo systemctl reload postgresql"
    ok "pg_hba.conf patched; backup at ${PG_HBA}.chronicledb-backup"
  else
    warn "Leaving pg_hba.conf alone. If ChronicleDB fails with 'Ident authentication failed', edit $PG_HBA: change 'ident' to 'trust' on the 127.0.0.1/32 and ::1/128 lines, then: sudo systemctl reload postgresql"
  fi
}

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

# ── 4. Check PostgreSQL — offer to install if missing ──────────────
# Skipped under --skip-postgres: user is pointing at a cloud DB and we
# don't need a local Postgres binary, service, or role for the script
# to finish wiring the plugin into SillyTavern.
if [[ -n "$SKIP_POSTGRES" ]]; then
  log "Skipping local PostgreSQL setup (--skip-postgres)"
else
if ! pg_server_installed; then
  if command -v psql >/dev/null 2>&1; then
    warn "psql client found, but no postgresql-server. On Fedora/RHEL these are separate packages."
  else
    warn "PostgreSQL is not installed."
  fi
  case "$PLATFORM" in
    macos)
      if command -v brew >/dev/null 2>&1; then
        if prompt_yes "Install PostgreSQL 17 + pgvector via Homebrew now?"; then
          run_install "brew install postgresql@17 pgvector"
          run_install "brew services start postgresql@17"
          # Make sure brew's pg is on PATH for the rest of the script
          export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
        else
          fail "Cannot continue without PostgreSQL. Install it manually and re-run, or pass --skip-postgres if you're using a cloud DB."
        fi
      else
        fail "Homebrew not found. Install Homebrew first (https://brew.sh), then re-run this script. Or install PostgreSQL manually from https://www.postgresql.org/download/macosx/"
      fi
      ;;
    linux)
      if command -v apt-get >/dev/null 2>&1; then
        if prompt_yes "Install PostgreSQL 17 + pgvector via apt now? (will sudo)"; then
          run_install "sudo apt-get update"
          run_install "sudo apt-get install -y postgresql-17 postgresql-17-pgvector"
          run_install "sudo systemctl start postgresql"
          # Linux distros require a Postgres role for the OS user — create it now
          if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$USER'" 2>/dev/null | grep -q 1; then
            log "Creating Postgres role for current user '$USER'..."
            sudo -u postgres createuser --superuser "$USER"
          fi
          ensure_user_db
          ensure_loopback_trust
        else
          fail "Cannot continue without PostgreSQL. Install it manually and re-run, or pass --skip-postgres if you're using a cloud DB."
        fi
      elif command -v dnf >/dev/null 2>&1; then
        # Fedora / Nobara / RHEL / Rocky / Alma. Fedora 40+ has
        # postgresql-pgvector in the main repos; older releases or RHEL
        # derivatives may need PGDG's yum repo enabled first.
        if prompt_yes "Install PostgreSQL + pgvector via dnf now? (will sudo)"; then
          run_install "sudo dnf install -y postgresql-server postgresql-contrib postgresql-pgvector"
          # Unlike apt, dnf's postgresql-server does NOT initialize the
          # data directory on its own. Only run initdb if PG_VERSION
          # isn't already there so re-runs don't clobber existing data.
          if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
            log "Initializing Postgres data directory ..."
            run_install "sudo postgresql-setup --initdb"
          fi
          run_install "sudo systemctl enable --now postgresql"
          if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$USER'" 2>/dev/null | grep -q 1; then
            log "Creating Postgres role for current user '$USER'..."
            sudo -u postgres createuser --superuser "$USER"
          fi
          ensure_user_db
          ensure_loopback_trust
        else
          fail "Cannot continue without PostgreSQL. Install it manually and re-run, or pass --skip-postgres if you're using a cloud DB."
        fi
      else
        fail "No supported Linux package manager found (looked for apt-get, dnf). For Arch / openSUSE / other distros, install PostgreSQL 14+ and pgvector manually, then re-run — or pass --skip-postgres if you're pointing at a cloud DB."
      fi
      ;;
  esac
fi
PG_VERSION=$(psql --version | grep -oE '[0-9]+' | head -1)
if [[ "$PG_VERSION" -lt 14 ]]; then
  fail "PostgreSQL 14+ required (you have $PG_VERSION). 17 recommended."
fi
if ! psql -tAc "SELECT 1" >/dev/null 2>&1; then
  warn "PostgreSQL is installed but the server isn't accepting connections."
  case "$PLATFORM" in
    macos)
      if prompt_yes "Try starting it via 'brew services start postgresql@17' now?"; then
        run_install "brew services start postgresql@17 || brew services start postgresql"
        sleep 2
      fi
      ;;
    linux)
      if prompt_yes "Try starting it via 'sudo systemctl start postgresql' now?"; then
        # Fedora-style installs may have an empty data dir if postgres-
        # setup --initdb was never run.
        if command -v postgresql-setup >/dev/null 2>&1 && [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
          log "Initializing Postgres data directory ..."
          run_install "sudo postgresql-setup --initdb"
        fi
        run_install "sudo systemctl start postgresql"
        sleep 2
        if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$USER'" 2>/dev/null | grep -q 1; then
          log "Creating Postgres role for current user '$USER'..."
          sudo -u postgres createuser --superuser "$USER"
        fi
        ensure_user_db
        ensure_loopback_trust
      fi
      ;;
  esac
  if ! psql -tAc "SELECT 1" >/dev/null 2>&1; then
    fail "Still can't connect to PostgreSQL after attempting to start it. Check 'pg_isready' and the Postgres logs, then re-run."
  fi
fi
ok "PostgreSQL $PG_VERSION (running, current user can connect)"
fi

# ── 5. Check pgvector extension — offer to install if missing ──────
# Cloud DB users skip this entirely — they install pgvector on their
# cloud instance via its own UI (Neon auto-enables it, Supabase has a
# toggle under Database > Extensions).
if [[ -n "$SKIP_POSTGRES" ]]; then
  log "Skipping pgvector check (--skip-postgres)"
else
TMP_DB="chronicledb_pgvector_check_$$"
if createdb "$TMP_DB" 2>/dev/null && \
   psql -d "$TMP_DB" -tAc "CREATE EXTENSION IF NOT EXISTS vector; DROP EXTENSION vector;" >/dev/null 2>&1; then
  PGVECTOR_OK=1
else
  PGVECTOR_OK=0
fi
dropdb "$TMP_DB" 2>/dev/null || true
if [[ "$PGVECTOR_OK" -eq 0 ]]; then
  warn "pgvector extension is not installed in your Postgres binary."
  case "$PLATFORM" in
    macos)
      if command -v brew >/dev/null 2>&1 && prompt_yes "Install pgvector via 'brew install pgvector' now?"; then
        run_install "brew install pgvector"
      else
        fail "Install pgvector manually and re-run:  brew install pgvector"
      fi
      ;;
    linux)
      if command -v apt-get >/dev/null 2>&1 && prompt_yes "Install pgvector via 'sudo apt-get install postgresql-${PG_VERSION}-pgvector' now?"; then
        run_install "sudo apt-get install -y postgresql-${PG_VERSION}-pgvector"
      elif command -v dnf >/dev/null 2>&1 && prompt_yes "Install pgvector via 'sudo dnf install postgresql-pgvector' now?"; then
        run_install "sudo dnf install -y postgresql-pgvector"
      else
        fail "Install pgvector manually for your distro and re-run (apt: postgresql-${PG_VERSION}-pgvector ; dnf: postgresql-pgvector)."
      fi
      ;;
  esac
  # Re-check after install
  TMP_DB="chronicledb_pgvector_recheck_$$"
  if ! (createdb "$TMP_DB" 2>/dev/null && psql -d "$TMP_DB" -tAc "CREATE EXTENSION IF NOT EXISTS vector; DROP EXTENSION vector;" >/dev/null 2>&1); then
    dropdb "$TMP_DB" 2>/dev/null || true
    fail "pgvector still not loadable after install attempt. Check the install output above."
  fi
  dropdb "$TMP_DB" 2>/dev/null || true
fi
ok "pgvector is available"
fi

# ── 6. Clone or update the repo ─────────────────────────────────────
REPO_DIR="${REPO_DIR:-$HOME/.chronicledb}"
REPO_URL="https://github.com/alani-fan-club/chronicledb.git"
if [[ -n "$SKIP_CLONE" ]]; then
  # User brought their own tree (tarball, release download, manual clone
  # with auth we don't have). Trust them, but verify REPO_DIR actually
  # looks like the repo so the later steps don't blow up with misleading
  # errors pointing at missing server-plugin/ or ui-extension/.
  if [[ ! -d "$REPO_DIR" ]]; then
    fail "--skip-clone was set but $REPO_DIR doesn't exist. Either drop the tree there first or set REPO_DIR=<path> to point at it."
  fi
  for required in server-plugin ui-extension package.json; do
    if [[ ! -e "$REPO_DIR/$required" ]]; then
      fail "$REPO_DIR/$required is missing — --skip-clone expects a full ChronicleDB tree. Re-extract your tarball or point REPO_DIR at the right location."
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

# ── 7. npm install (top-level, then server-plugin) ──────────────────
# The top-level package.json declares express, openai, zod, etc. that
# the server-plugin require()s. Because the plugin is consumed by ST
# via a symlink, Node realpath's through and walks up from the real
# location — landing in $REPO_DIR/node_modules/. Without this step, ST
# fails to load the plugin with "Cannot find module 'express'".
log "Installing top-level dependencies (express, openai, zod...) ..."
(
  cd "$REPO_DIR"
  npm install --silent --no-audit --no-fund --no-progress
)
ok "Top-level dependencies installed"

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
# Under --skip-postgres the cloud DB already exists and the user is
# responsible for enabling extensions there. ChronicleDB's own initSchema
# runs CREATE EXTENSION IF NOT EXISTS on boot, so the only real
# requirement is that the cloud role has CREATE EXTENSION privilege
# (Neon and Supabase both grant it by default on the app user).
DB_NAME="${DB_NAME:-chronicledb}"
if [[ -n "$SKIP_POSTGRES" ]]; then
  log "Skipping database creation (--skip-postgres). Paste your cloud DB"
  log "  connection info into the ST settings panel after restart."
else
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
fi

# ── 12. Final report ────────────────────────────────────────────────
if [[ -n "$SKIP_POSTGRES" ]]; then
  DB_LINE="Database:      (cloud — paste creds in the ST settings panel)"
  RERUN_LINE="  bash $REPO_DIR/install.sh --skip-postgres"
  UNINSTALL_DB_LINE="  # (cloud DB: drop it from your provider dashboard)"
else
  DB_LINE="Database:      $DB_NAME (host: localhost, user: $(whoami))"
  RERUN_LINE="  bash $REPO_DIR/install.sh"
  UNINSTALL_DB_LINE="  dropdb $DB_NAME"
fi

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
  $DB_LINE

${BOLD}Re-run later (idempotent — fixes any drift):${RESET}
$RERUN_LINE

${BOLD}Uninstall:${RESET}
  rm $PLUGIN_LINK
  rm $UI_LINK
$UNINSTALL_DB_LINE
  rm -rf $REPO_DIR
${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}
EOF
