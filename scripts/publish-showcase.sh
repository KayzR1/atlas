#!/usr/bin/env bash
# Publish a scrubbed, SINGLE-COMMIT snapshot of this repo to a separate showcase repo (default: <you>/pallas).
#
#   scripts/publish-showcase.sh                 build, scrub, scan, then push (creates the repo PRIVATE if it doesn't exist)
#   DRY_RUN=1 scripts/publish-showcase.sh       build, scrub and scan only; push nothing
#
# What it does, every time:
#   1. exports exactly what is COMMITTED at HEAD (uncommitted changes and gitignored files are never included)
#   2. re-applies the scrub (real -> fictional identifiers from the gitignored .scrub.local), then scans the result
#      (mapped/forbidden strings, your .env values, emails, phone-shaped numbers, token shapes, session links, local state files)
#      and ABORTS on any finding
#   3. makes one fresh commit under your GitHub no-reply identity (no history, no session trailers) and scans its metadata too
#   4. creates <you>/<repo> as PRIVATE if missing, then force-pushes that one commit
# It never changes the repo's visibility. If the target is already PUBLIC it refuses unless CONFIRM_PUBLIC=1.
#
# Environment: SHOWCASE_REPO (default pallas) · SCRUB_MAP (default .scrub.local) · SHOWCASE_TRAILER (optional commit trailer line)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
REPO_NAME="${SHOWCASE_REPO:-pallas}"
MAP="${SCRUB_MAP:-.scrub.local}"
fail() { echo "ERROR: $*" >&2; exit 1; }
for tool in git gh bun tar; do command -v "$tool" >/dev/null 2>&1 || fail "missing required tool: $tool"; done
[ -f "$MAP" ] || fail "no mapping file at $MAP (real=>fake lines; see the header of scripts/scrub.ts)"
gh auth status >/dev/null 2>&1 || fail "gh is not logged in (run: gh auth login)"

LOGIN="$(gh api user --jq .login)"
USER_ID="$(gh api user --jq .id)"
NOREPLY="${USER_ID}+${LOGIN}@users.noreply.github.com"

TMP="$(mktemp -d)"
[ -n "$TMP" ] && [ -d "$TMP" ] || fail "could not create a temp directory"
trap 'rm -rf "$TMP"' EXIT        # removes only the directory created above
SNAP="$TMP/snapshot"; mkdir "$SNAP"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "note: you have uncommitted changes; the snapshot uses the last COMMIT (HEAD $(git rev-parse --short HEAD)), not your working tree."
fi

echo "== 1/4 exporting HEAD ($(git rev-parse --short HEAD))"
git archive HEAD | tar -x -C "$SNAP"
echo "   $(find "$SNAP" -type f | wc -l | tr -d ' ') files"

echo "== 2/4 scrubbing and scanning the export"
bun scripts/scrub.ts apply "$SNAP" --map "$MAP"
ENV_ARGS=(); [ -f .env ] && ENV_ARGS=(--env .env)
bun scripts/scrub.ts check "$SNAP" --map "$MAP" "${ENV_ARGS[@]}" || fail "the scan found personal data in the snapshot: nothing was pushed. Fix the source (or extend $MAP) and re-run."

echo "== 3/4 creating the single commit as ${LOGIN} <${NOREPLY}>"
cd "$SNAP"
git init -q -b main
MSG_FILE="$TMP/commit-message.txt"
{
  echo "Pallas: single-commit snapshot ($(date -u +%Y-%m-%d))"
  echo
  echo "Scrubbed export of the private working repository: fictional data throughout, no history."
  [ -n "${SHOWCASE_TRAILER:-}" ] && { echo; echo "$SHOWCASE_TRAILER"; }
} > "$MSG_FILE"
git -c user.name="$LOGIN" -c user.email="$NOREPLY" add -A
git -c user.name="$LOGIN" -c user.email="$NOREPLY" commit -q -F "$MSG_FILE"
[ "$(git rev-list --count HEAD)" = "1" ] || fail "expected exactly one commit"
# scan the commit's own metadata (author, committer, message) with the same rules. The one thing exempted is the
# GitHub handle we deliberately use as the author (it may be forbidden inside FILES, but it IS the chosen identity here).
META="$TMP/meta"; mkdir "$META"
git log -1 --format='%an%n%ae%n%cn%n%ce%n%B' > "$META/commit-metadata.txt"
cd - >/dev/null
grep -v -i -x -F -- "!${LOGIN}" "$MAP" > "$TMP/meta.map" || true
bun scripts/scrub.ts check "$META" --map "$TMP/meta.map" "${ENV_ARGS[@]}" || fail "the commit metadata contains personal data: nothing was pushed."
echo "   1 commit, $(git -C "$SNAP" ls-files | wc -l | tr -d ' ') files, author $(git -C "$SNAP" log -1 --format='%an <%ae>')"

if [ "${DRY_RUN:-0}" = "1" ]; then echo "== DRY_RUN=1: stopping before the push. Everything above passed."; exit 0; fi

echo "== 4/4 pushing to ${LOGIN}/${REPO_NAME}"
if gh repo view "${LOGIN}/${REPO_NAME}" >/dev/null 2>&1; then
  VIS="$(gh repo view "${LOGIN}/${REPO_NAME}" --json visibility -q .visibility)"
  if [ "$VIS" = "PUBLIC" ] && [ "${CONFIRM_PUBLIC:-0}" != "1" ]; then
    fail "${LOGIN}/${REPO_NAME} is PUBLIC; this replaces its contents. Re-run with CONFIRM_PUBLIC=1 if that is what you want."
  fi
else
  gh repo create "${LOGIN}/${REPO_NAME}" --private --description "Pallas: an iMessage assistant that keeps your semester under control (Canvas, grades, deadlines, calendar)." >/dev/null
  VIS="PRIVATE"; echo "   created ${LOGIN}/${REPO_NAME} (private)"
fi
git -C "$SNAP" remote add origin "https://github.com/${LOGIN}/${REPO_NAME}.git"
git -C "$SNAP" push --force origin main 2>&1 | tail -2
echo "== done: https://github.com/${LOGIN}/${REPO_NAME}  (visibility: ${VIS}; this script never changes it)"
