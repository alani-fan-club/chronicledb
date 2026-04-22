#!/usr/bin/env bash
# Bump the version string across all release manifests in one shot.
#
# ChronicleDB has three places that declare a version:
#   - package.json                  (root, drives `npm install` at the repo)
#   - server-plugin/package.json    (drives the standalone plugin install)
#   - ui-extension/manifest.json    (what SillyTavern's Extensions panel shows)
#
# Pre-script, these were maintained by hand and drifted (manifest.json
# stayed at 0.1.0 across both v0.2.0 and v0.2.1 releases because nobody
# remembered to bump it). This script edits all three with a regex that
# only touches the version VALUE — the surrounding JSON formatting,
# key order, indentation, and trailing commas are preserved exactly.
#
# Usage:
#   bin/bump-version.sh <new-version>
#
# Example:
#   bin/bump-version.sh 0.2.2
#
# After running, run `git diff` to confirm only the version lines changed,
# then stage + commit + tag as part of the release flow.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bin/bump-version.sh <version>" >&2
  echo "  e.g. bin/bump-version.sh 0.2.2" >&2
  exit 1
fi

NEW_VERSION="$1"

# Naive but sufficient semver check — matches MAJOR.MINOR.PATCH with an
# optional -prerelease tail. Catches the obvious typos (commas, quotes,
# pasted version with a leading "v") without trying to be a full validator.
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "Refusing to write version '$NEW_VERSION' — expected MAJOR.MINOR.PATCH" >&2
  echo "(Drop any leading 'v' and double-check for typos.)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

FILES=(
  "$REPO_ROOT/package.json"
  "$REPO_ROOT/server-plugin/package.json"
  "$REPO_ROOT/ui-extension/manifest.json"
)

for f in "${FILES[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "missing: $f" >&2
    exit 1
  fi
done

# Read the current version from each file before mutating, so we can:
#   1. Skip files already at the target version (idempotent re-runs)
#   2. Print before/after for each file so the user sees what changed
#   3. Warn when files were out of sync to begin with (drift sanity check)
declare -a CURRENT_VERSIONS
for f in "${FILES[@]}"; do
  v=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$f" | head -1 \
      | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  if [[ -z "$v" ]]; then
    echo "could not find a \"version\": \"...\" line in $f" >&2
    exit 1
  fi
  CURRENT_VERSIONS+=("$v")
done

# Drift warning: if the three files disagree, surface it so the human
# knows their starting state was inconsistent.
unique=$(printf '%s\n' "${CURRENT_VERSIONS[@]}" | sort -u | wc -l | tr -d ' ')
if [[ "$unique" -gt 1 ]]; then
  echo "warning: version strings were out of sync before this bump:" >&2
  for i in "${!FILES[@]}"; do
    echo "  ${CURRENT_VERSIONS[$i]}  ${FILES[$i]}" >&2
  done
fi

for i in "${!FILES[@]}"; do
  f="${FILES[$i]}"
  current="${CURRENT_VERSIONS[$i]}"
  if [[ "$current" == "$NEW_VERSION" ]]; then
    echo "  ${f#$REPO_ROOT/}: already $NEW_VERSION"
    continue
  fi
  # Edit through a temp file so a Ctrl-C or disk-full mid-write can't
  # leave the manifest truncated.
  tmp="$(mktemp)"
  sed -E "s/(\"version\"[[:space:]]*:[[:space:]]*\")[^\"]+(\")/\1${NEW_VERSION}\2/" "$f" > "$tmp"
  mv "$tmp" "$f"
  echo "  ${f#$REPO_ROOT/}: $current -> $NEW_VERSION"
done

echo
echo "Done. Next steps:"
echo "  git diff                           # confirm only version lines changed"
echo "  git add -u && git commit -m 'chore(release): $NEW_VERSION'"
echo "  git tag -a v$NEW_VERSION -m 'ChronicleDB v$NEW_VERSION'"
