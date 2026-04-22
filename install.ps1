# ChronicleDB one-shot installer for Windows (PowerShell).
#
# Mirrors install.sh for users on raw PowerShell (no WSL, no Git Bash).
# Uses NTFS junctions instead of symbolic links so no admin elevation
# and no Developer Mode is required — junctions Just Work for local
# directories.
#
# Usage:
#   irm https://raw.githubusercontent.com/alani-fan-club/chronicledb/master/install.ps1 | iex
#
# Or after cloning manually:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Flags:
#   -ExternalPostgres   Use an external Postgres server (Neon, Supabase,
#                       your own) instead of embedded PGlite. Set
#                       host/port/db/user/password in the ST settings
#                       panel after install.
#   -SkipClone          Don't git-clone or git-fetch. Use when you
#                       already have the tree (release zip, manual
#                       checkout). $env:REPO_DIR (or -RepoDir) must
#                       point at it.
#   -StDir <path>       Override SillyTavern auto-detection.
#   -RepoDir <path>     Where to clone ChronicleDB. Default: $HOME\.chronicledb
#
# Idempotent — safe to re-run. Detects existing clones and existing
# junctions and skips work that's already done.

[CmdletBinding()]
param(
    [switch]$ExternalPostgres,
    [switch]$SkipClone,
    [string]$StDir = $env:ST_DIR,
    [string]$RepoDir = $(if ($env:REPO_DIR) { $env:REPO_DIR } else { Join-Path $HOME '.chronicledb' })
)

$ErrorActionPreference = 'Stop'

# ── Output helpers ──────────────────────────────────────────────────
function Write-Log  { param($m) Write-Host "[chronicledb] $m" -ForegroundColor Blue }
function Write-Ok   { param($m) Write-Host "[chronicledb] $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[chronicledb] $m" -ForegroundColor Yellow }
function Fail       { param($m) Write-Host "[chronicledb] $m" -ForegroundColor Red; exit 1 }

# ── 1. Locate SillyTavern ───────────────────────────────────────────
if (-not $StDir) {
    $candidates = @(
        (Join-Path $HOME 'SillyTavern'),
        (Join-Path $HOME 'SillyTavern-Launcher\SillyTavern'),
        (Join-Path $HOME 'sillytavern'),
        (Join-Path $HOME 'Documents\SillyTavern')
    )
    foreach ($c in $candidates) {
        if ((Test-Path (Join-Path $c 'server.js')) -and (Test-Path (Join-Path $c 'config.yaml'))) {
            $StDir = $c
            break
        }
    }
}
if (-not $StDir) {
    $StDir = Read-Host 'Where is your SillyTavern install?'
    if ($StDir.StartsWith('~')) { $StDir = $StDir -replace '^~', $HOME }
}
if (-not (Test-Path (Join-Path $StDir 'server.js')))  { Fail "$StDir doesn't look like a SillyTavern install (no server.js)." }
if (-not (Test-Path (Join-Path $StDir 'config.yaml'))) { Fail "$StDir has no config.yaml. Start SillyTavern at least once first." }
Write-Ok "Found SillyTavern at $StDir"

# ── 2. Check Node.js ────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'Node.js is required (you need 18+). Install Node and re-run.'
}
$nodeVersion = & node --version
$nodeMajor = [int](($nodeVersion -replace '^v','') -split '\.' | Select-Object -First 1)
if ($nodeMajor -lt 18) { Fail "Node.js 18+ required (you have $nodeVersion). Upgrade Node and re-run." }
Write-Ok "Node $nodeVersion"

# ── 3. (Optional) external Postgres pre-flight ──────────────────────
if ($ExternalPostgres) {
    Write-Log 'External Postgres mode (-ExternalPostgres). You will paste your'
    Write-Log '  host/port/db/user/password into the ST settings panel after'
    Write-Log "  install. Make sure your DB has the 'vector' and 'pg_trgm'"
    Write-Log '  extensions available.'
}

# ── 4. Clone or update the repo ─────────────────────────────────────
$RepoUrl = 'https://github.com/alani-fan-club/chronicledb.git'
if ($SkipClone) {
    if (-not (Test-Path $RepoDir)) {
        Fail "-SkipClone set but $RepoDir doesn't exist. Drop the tree there or pass -RepoDir <path>."
    }
    foreach ($required in 'server-plugin','ui-extension','package.json') {
        if (-not (Test-Path (Join-Path $RepoDir $required))) {
            Fail "$RepoDir\$required is missing — -SkipClone expects a full ChronicleDB tree."
        }
    }
    Write-Log "Skipping clone/fetch (-SkipClone). Using existing tree at $RepoDir."
} elseif (Test-Path (Join-Path $RepoDir '.git')) {
    Write-Log "Updating existing clone at $RepoDir ..."
    & git -C $RepoDir fetch --quiet origin master
    if ($LASTEXITCODE -ne 0) { Fail 'git fetch failed.' }
    & git -C $RepoDir reset --hard --quiet origin/master
    if ($LASTEXITCODE -ne 0) { Fail 'git reset failed.' }
    $sha = (& git -C $RepoDir rev-parse --short HEAD).Trim()
    Write-Ok "Updated to $sha"
} else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Fail 'git is required to clone the repo. Install Git for Windows and re-run, or pass -SkipClone after extracting a release zip.'
    }
    Write-Log "Cloning ChronicleDB to $RepoDir ..."
    & git clone --quiet $RepoUrl $RepoDir
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed.' }
    $sha = (& git -C $RepoDir rev-parse --short HEAD).Trim()
    Write-Ok "Cloned to $sha"
}

# ── 5. npm install (top-level + server-plugin) ──────────────────────
# npm.cmd is the actual shim on Windows; Get-Command 'npm' usually
# resolves to it but we call through `npm` for parity with Linux logs.
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail 'npm is required (ships with Node). Reinstall Node and re-run.'
}
Write-Log 'Installing top-level dependencies (PGlite, express, openai, zod...) ...'
Push-Location $RepoDir
try {
    & npm install --silent --no-audit --no-fund --no-progress
    if ($LASTEXITCODE -ne 0) { Fail 'Top-level npm install failed.' }
} finally { Pop-Location }
Write-Ok 'Top-level dependencies installed'

Write-Log 'Installing server plugin dependencies ...'
Push-Location (Join-Path $RepoDir 'server-plugin')
try {
    & npm install --silent --no-audit --no-fund --no-progress
    if ($LASTEXITCODE -ne 0) { Fail 'Plugin npm install failed.' }
} finally { Pop-Location }
Write-Ok 'Plugin dependencies installed'

# ── 6. Junction the server plugin into SillyTavern ──────────────────
# Junctions are NTFS reparse points for directories. They don't need
# admin or Developer Mode (unlike SymbolicLinks), and SillyTavern's
# plugin loader follows them transparently. The trade-off is they're
# local-only — fine here, since both ends sit under the user profile.
function Remove-JunctionSafely {
    # CRITICAL: do NOT use `Remove-Item -Recurse` on a junction.
    #
    # PowerShell 5.1 — which is what ships with Windows 10/11 as
    # `powershell.exe`, and is the thing our `irm | iex` one-liner
    # invokes — follows junctions during recursive delete and wipes
    # the TARGET directory's contents. This is a well-documented
    # footgun (see PowerShell/PowerShell#621 and related). PS 7 fixed
    # it, but we can't assume PS 7.
    #
    # A previous revision of this script used `Remove-Item -Force
    # -Recurse` on junctions and quietly nuked content inside the
    # chronicledb repo (and adjacent ST extension folders) when a
    # user re-ran install.ps1 over a pre-existing wrong-target
    # junction. [System.IO.Directory]::Delete with recursive=$false
    # only removes the reparse-point entry itself without traversing
    # into the target, which is what we actually want.
    param([string]$JunctionPath)
    [System.IO.Directory]::Delete($JunctionPath, $false)
}

function Set-Junction {
    param([string]$LinkPath, [string]$TargetPath)
    if (Test-Path $LinkPath) {
        $item = Get-Item -LiteralPath $LinkPath -Force
        # ReparsePoint covers both junctions and symlinks. If it already
        # points at the right target we leave it alone for idempotency.
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            # $item.Target is string[] on PS 7 and string on PS 5; coerce
            # to a single value so the equality check works on either.
            $existingTarget = @($item.Target) | Select-Object -First 1
            if ($existingTarget -and ($existingTarget -eq $TargetPath)) { return $true }
            Remove-JunctionSafely $LinkPath
        } else {
            Fail "$LinkPath exists and is not a junction/symlink. Move it aside or delete it and re-run."
        }
    }
    # New-Item -ItemType Junction works without elevation on Windows 10/11.
    New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
    return $false
}

$pluginDir = Join-Path $StDir 'plugins'
if (-not (Test-Path $pluginDir)) { New-Item -ItemType Directory -Path $pluginDir | Out-Null }
$pluginLink   = Join-Path $pluginDir 'chronicle-db'
$pluginTarget = Join-Path $RepoDir 'server-plugin'
if (Set-Junction $pluginLink $pluginTarget) {
    Write-Ok 'Server plugin junction already in place'
} else {
    Write-Ok "Linked server plugin -> $pluginLink"
}

# ── 7. Junction the UI extension into SillyTavern ───────────────────
$uiParent = Join-Path $StDir 'public\scripts\extensions\third-party'
if (-not (Test-Path $uiParent)) { New-Item -ItemType Directory -Path $uiParent | Out-Null }
$uiLink   = Join-Path $uiParent 'chronicle-db'
$uiTarget = Join-Path $RepoDir 'ui-extension'
if (Set-Junction $uiLink $uiTarget) {
    Write-Ok 'UI extension junction already in place'
} else {
    Write-Ok "Linked UI extension -> $uiLink"
}

# ── 8. Patch config.yaml to enable server plugins ───────────────────
# Use raw read/write to preserve original line endings (ST is happy
# with either CRLF or LF; we don't want to flip them on existing files).
$config = Join-Path $StDir 'config.yaml'
$raw = Get-Content -LiteralPath $config -Raw
if ($raw -match '(?m)^enableServerPlugins:\s*true\s*$') {
    Write-Ok 'Server plugins already enabled in config.yaml'
} elseif ($raw -match '(?m)^enableServerPlugins:.*$') {
    $patched = [regex]::Replace($raw, '(?m)^enableServerPlugins:.*$', 'enableServerPlugins: true')
    Set-Content -LiteralPath $config -Value $patched -NoNewline
    Write-Ok 'Set enableServerPlugins: true in config.yaml'
} else {
    $sep = if ($raw.EndsWith("`n")) { '' } else { "`r`n" }
    Add-Content -LiteralPath $config -Value "${sep}enableServerPlugins: true"
    Write-Ok 'Appended enableServerPlugins: true to config.yaml'
}

# ── 9. Final report ─────────────────────────────────────────────────
if ($ExternalPostgres) {
    $dbLine    = 'Database:      external (paste creds in ST settings panel)'
    $rerunLine = "  powershell -File $RepoDir\install.ps1 -ExternalPostgres"
} else {
    $dbLine    = "Database:      embedded (PGlite @ $HOME\.chronicledb\pgdata, created on first plugin load)"
    $rerunLine = "  powershell -File $RepoDir\install.ps1"
}

Write-Host ''
Write-Host '===================================================================' -ForegroundColor Green
Write-Host 'ChronicleDB installed successfully!' -ForegroundColor Green
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Restart SillyTavern (close it and run `node server.js` again).'
Write-Host '  2. Open the ChronicleDB section under Extensions in the ST UI.'
Write-Host '  3. Paste your Gemini API key (or OpenAI-compatible endpoint).'
Write-Host '  4. Send a chat message — memory builds automatically from there.'
Write-Host ''
Write-Host 'Where things landed:'
Write-Host "  Repo:          $RepoDir"
Write-Host "  Server plugin: $pluginLink"
Write-Host "                 -> $pluginTarget"
Write-Host "  UI extension:  $uiLink"
Write-Host "                 -> $uiTarget"
Write-Host "  $dbLine"
Write-Host ''
Write-Host 'Re-run later (idempotent — fixes any drift):'
Write-Host $rerunLine
Write-Host ''
Write-Host 'Uninstall:'
Write-Host "  Remove-Item -LiteralPath '$pluginLink' -Force"
Write-Host "  Remove-Item -LiteralPath '$uiLink' -Force"
Write-Host "  Remove-Item -LiteralPath '$RepoDir' -Recurse -Force"
Write-Host '===================================================================' -ForegroundColor Green
