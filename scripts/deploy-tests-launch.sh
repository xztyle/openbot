#!/usr/bin/env bash
# Runs every test of one revision beside its build and deploy (OpenBot AGENTS.md, "Deploys and critical
# flows"). build-vps.sh starts it in the background for every build; it never blocks or delays the
# deploy, and it has no skip flag.
#
# 1. A checkout of the revision with the shared node_modules, in its own worktree.
# 2. The whole suite: `scripts/deploy-tests.ts` (critical flows first, then every standalone E2E script
#    and the Vitest suite). It sends the owner an urgent push on any failure.
# 3. When the deploy of the revision finishes (its deployment.json appears, at most 2 h later), the
#    critical flows once more, against the code that is now live.
#
# Results: .openbot-build/deploy-tests/<revision>-<time>/ (deploy-tests.json, logs/, FAILED on a
# failure, after-deploy/), linked from the release folder as deploy-tests.
#
# Only the newest deploy is tested (the owner's rule, 2026-11-26): a new deploy's launcher stops every
# suite that still runs or waits, with all its processes and browsers, removes its worktree, notes it
# in that suite's launcher.log, and then runs its own. The lock stays as a guard against overlap.
# Usage: deploy-tests-launch.sh <revision> <release-dir>
set -u
revision=$1 release=$2
work=/home/ubuntu/openbot-release-work
base="$work/openbot-release/.openbot-build/deploy-tests"
out="$base/${revision}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
exec >> "$out/launcher.log" 2>&1
echo "Tests of $revision for $release, queued $(date -u +%FT%TZ)."
ln -sfn "$out" "$release/deploy-tests" 2>/dev/null || true

# Every process under a pid: the test scripts run in process groups of their own, so a kill of the
# launcher's group alone would leave them and their browsers.
descendants() {
  local child
  for child in $(ps -o pid= --ppid "$1"); do
    echo "$child"
    descendants "$child"
  done
}
for other in $(pgrep -f '^bash scripts/deploy-tests-launch\.sh '); do
  [[ $other == "$$" ]] && continue
  other_log=$(readlink "/proc/$other/fd/1" 2>/dev/null)
  other_args=($(tr '\0' ' ' < "/proc/$other/cmdline" 2>/dev/null))
  victims="$other $(descendants "$other")"
  kill -TERM $victims 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$other" 2>/dev/null || break; sleep 0.5; done
  kill -KILL $victims 2>/dev/null
  if [[ $other_log == "$base"/*/launcher.log ]]; then
    echo "Stopped $(date -u +%FT%TZ): the deploy of $revision started its own tests." >> "$other_log"
  fi
  echo "Stopped the tests of ${other_args[2]:-an older deploy} (pid $other)."
done
# The worktrees of the stopped suites (the launcher's own is made below).
for old in "$work"/wt-deploy-tests-*; do
  [[ -d $old ]] || continue
  git -C "$work/openbot-dev" worktree remove --force "$old" 2>/dev/null || rm -rf "$old"
done
git -C "$work/openbot-dev" worktree prune 2>/dev/null || true

exec 8> "$base/suite.lock"
flock 8
echo "Started $(date -u +%FT%TZ)."
export PATH=/opt/openbot/build-tools:/opt/openbot/build-tools/node/bin:$PATH

# One worktree per run: two runs of one revision never share (and so never remove) a worktree.
tree="$work/wt-deploy-tests-${revision:0:12}-${out##*-}"
dev="$work/openbot-dev"
git -C "$dev" fetch -q fork main || true
git -C "$dev" worktree remove --force "$tree" 2>/dev/null || rm -rf "$tree"
git -C "$dev" worktree add -q --detach "$tree" "$revision"
# The shared node_modules as real folders of hard links (a few seconds, no extra disk): a symbolic
# link to another checkout makes Vite refuse files outside this one, and a container that mounts this
# checkout cannot follow it. The workspace packages link back into this checkout.
source_modules="$work/wt-ux-polish/node_modules"
[[ -d $source_modules ]] || source_modules="$dev/node_modules"
mkdir -p "$tree/node_modules"
for entry in $(ls -A "$source_modules"); do
  if [[ $entry == @openbot || $entry == .bin ]]; then cp -a "$source_modules/$entry" "$tree/node_modules/"
  elif ! cp -alL "$source_modules/$entry" "$tree/node_modules/" 2>/dev/null; then
    # A copy that stopped part way (a cyclic link in the source) would otherwise get the link
    # inside it, which loops; the whole entry becomes the link instead.
    rm -rf "${tree:?}/node_modules/$entry"
    ln -sfn "$(readlink -f "$source_modules/$entry")" "$tree/node_modules/$entry"
  fi
done
email_modules="$(dirname "$source_modules")/apps/email-app/node_modules"
if [[ -d $email_modules ]]; then
  mkdir -p "$tree/apps/email-app/node_modules"
  for entry in $(ls -A "$email_modules"); do
    if ! cp -alL "$email_modules/$entry" "$tree/apps/email-app/node_modules/" 2>/dev/null; then
      rm -rf "${tree:?}/apps/email-app/node_modules/$entry"
      ln -sfn "$(readlink -f "$email_modules/$entry")" "$tree/apps/email-app/node_modules/$entry"
    fi
  done
fi

label="release ${revision:0:12}"
if [[ ! -f "$tree/scripts/deploy-tests.ts" ]]; then
  echo "This revision has no scripts/deploy-tests.ts; nothing to run."
  git -C "$dev" worktree remove --force "$tree" 2>/dev/null || rm -rf "$tree"
  exit 0
fi
(cd "$tree" && nice -n 10 bun scripts/deploy-tests.ts --out="$out" --label="$label")
echo "Suite exit $? at $(date -u +%FT%TZ)."

# The check after the deploy: once the release says it is live, the critical flows again. The wait
# does not hold the suite lock, so the next build's suite starts at once; a release folder that is
# gone (a build that was not deployed and was cleaned up) ends the wait.
exec 8>&-
for _ in $(seq 1 720); do
  [[ -f "$release/deployment.json" || -f "$release/worker-deployment.json" || ! -d $release ]] && break
  sleep 10
done
# A web-only deploy (--worker-only) writes worker-deployment.json; a full one deployment.json.
if [[ -f "$release/deployment.json" || -f "$release/worker-deployment.json" ]]; then
  (cd "$tree" && nice -n 10 bun scripts/deploy-tests.ts --out="$out/after-deploy" --label="$label (live)" --critical-only)
  echo "After-deploy exit $? at $(date -u +%FT%TZ)."
else
  echo "No deployment of $release within 2 h; no after-deploy run."
fi

git -C "$dev" worktree remove --force "$tree" 2>/dev/null || rm -rf "$tree"
echo "Done $(date -u +%FT%TZ)."
