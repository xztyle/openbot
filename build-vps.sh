#!/usr/bin/env bash
# Fast private release build, run on the VPS itself. Same release directory as build.sh (image, Worker
# export, timing.json), but each stage reads only its own files, so BuildKit reuses every layer
# that a change did not touch. See docker/private-release-vps.Dockerfile.
#
#   ./build-vps.sh [git-ref] [--deploy] [--check] [--tarball]
#     git-ref    default fork/main (fetched first)
#     --deploy   deploy the release right after the build (idle check, smoke test, Worker, host)
#     --check    also run the translation check and the typechecks (they are not part of the image)
#     --tarball  also write image.tar.gz (only a remote deploy needs it)
#     --worker-only  build only the website/Worker export (deploy it with --worker-only)
set -euo pipefail
umask 077
cd "$(dirname "$0")"
docker() { sudo -n docker "$@"; }

# The host has 11 GB and runs OpenBot; a build can take 8 GB. Starting one while other heavy jobs run
# made the kernel kill processes inside OpenBot. Wait for memory, or give up instead of risking it.
need_mb=${OPENBOT_BUILD_MIN_FREE_MB:-6500}
waited=0
while :; do
  available=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  [[ "$available" -ge "$need_mb" ]] && break
  if [[ $waited -ge 1800 ]]; then
    echo "Only ${available} MB of memory is available (need ${need_mb}); not building. Stop other heavy jobs and run again." >&2
    exit 1
  fi
  echo "Waiting for memory: ${available} MB available, need ${need_mb} MB." >&2
  sleep 30; waited=$((waited + 30))
done

ref=fork/main deploy=0 check=0 tarball=0 worker_only=0
for argument in "$@"; do
  case "$argument" in
    --deploy) deploy=1 ;;
    --check) check=1 ;;
    --tarball) tarball=1 ;;
    --worker-only) worker_only=1 ;;
    -*) echo "Unknown option $argument" >&2; exit 2 ;;
    *) ref=$argument ;;
  esac
done

mkdir -p .openbot-build
[[ "$ref" == fork/main ]] && git fetch fork main > .openbot-build/release-fetch.log 2>&1
revision=$(git rev-parse "$ref^{commit}")
suffix=${OPENBOT_BUILD_SUFFIX:-}  # a test build of a deployed revision, kept apart from the real one
release="$PWD/.openbot-build/releases/${revision}${suffix}"
image="openbot-private:main-${revision:0:12}${suffix}"
builder=openbot-private-builder
started=$SECONDS
phase_started=$SECONDS
declare -A phases
phase() { phases[$1]=$((SECONDS - phase_started)); phase_started=$SECONDS; }

if [[ -f "$release/deployment.json" ]]; then
  echo "$image is already deployed from this revision; commit a change first." >&2
  exit 1
fi
mkdir -p "$release"
cat /opt/openbot/source/apps/auth-api/wrangler.jsonc > "$release/wrangler.jsonc"
config_sha=$(sha256sum "$release/wrangler.jsonc" | cut -d ' ' -f 1)

# One archive of the revision, then one directory per build context. The directories hold the same
# bytes for the same inputs, so an unchanged context is a cache hit however many commits passed.
# One fixed directory: BuildKit syncs a context incrementally per path, so a path that changes with
# every revision would send the whole checkout and miss every cache. One build at a time uses it.
contexts="$PWD/.openbot-build/contexts"
exec 9> .openbot-build/build.lock
flock -n 9 || { echo "Another build is running." >&2; exit 1; }
rm -rf "$contexts" "$release/context" "$release/worker"
mkdir -p "$contexts"/{full,deps,website,package-files} "$release/worker"
git archive "$revision" | tar -x -C "$contexts/full"
full="$contexts/full"
copy() { # copy <from-dir> <to-dir> <relative path>...
  local from=$1 to=$2; shift 2
  local item
  for item in "$@"; do
    [[ -e "$from/$item" ]] || continue
    mkdir -p "$to/$(dirname "$item")"
    cp -a "$from/$item" "$to/$item"
  done
}
# deps: everything `bun install --frozen-lockfile` and the root postinstall read.
copy "$full" "$contexts/deps" package.json bun.lock bunfig.toml patches packages/logging \
  scripts/stamp-install.ts scripts/setup-mobile-skia.ts scripts/install-git-hooks.ts \
  scripts/prepare-dev-environment.ts scripts/development-secrets.ts src/main/development-profile.ts
(cd "$full" && find . -name package.json -not -path '*/node_modules/*' -print0) |
  while IFS= read -r -d '' manifest; do copy "$full" "$contexts/deps" "${manifest#./}"; done
# website: the Worker and the pages it serves, plus the renderer it embeds.
copy "$full" "$contexts/website" apps/auth-api apps/mobile/CHANGELOG.md apps/site-router packages src/renderer src/preload resources/agent-import \
  package.json CHANGELOG.md .gitignore tsconfig.base.json tsconfig.json tsconfig.web.json tsconfig.node.json
# app: the whole checkout. Tailwind scans every file under the root for class names, so leaving a
# directory out would change the CSS bytes; the desktop bundle is rebuilt for any change.
# package: what electron-builder reads besides out/ and node_modules.
copy "$full" "$contexts/package-files" package.json LICENSE NOTICE electron-builder.yml \
  electron-builder.windows-signing.yml native-runtime.lock.json build resources scripts/hosting packages
# BuildKit sends and keys a file by size and modification time. A commit date on every file would
# make an unchanged file look new, and one fixed date would hide an edit that keeps the size. So each
# file gets a date derived from its own content: the same bytes always carry the same date.
python3 -I - "$contexts" <<'PY'
import hashlib, os, sys
for base, directories, files in os.walk(sys.argv[1]):
    for name in files:
        path = os.path.join(base, name)
        data = os.readlink(path).encode() if os.path.islink(path) else open(path, "rb").read()
        stamp = 946684800 + int(hashlib.sha1(data).hexdigest()[:8], 16) % 315360000
        os.utime(path, (stamp, stamp), follow_symlinks=False)
    for name in directories:
        os.utime(os.path.join(base, name), (946684800, 946684800), follow_symlinks=False)
PY
phase contexts

# Builder size: 8 GB and one job at a time on the small host. A bigger host sets these in the
# environment or in /opt/openbot/build.env (OPENBOT_BUILDER_MEMORY=24g, OPENBOT_BUILDER_PARALLELISM=4).
[[ -f /opt/openbot/build.env ]] && . /opt/openbot/build.env
builder_memory=${OPENBOT_BUILDER_MEMORY:-8g}
builder_parallelism=${OPENBOT_BUILDER_PARALLELISM:-1}
builder_bytes=$(( ${builder_memory%g} * 1073741824 ))
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  toml=$(mktemp)
  printf '[worker.oci]\n  max-parallelism = %s\n' "$builder_parallelism" > "$toml"
  docker buildx create --name "$builder" --driver docker-container \
    --driver-opt memory="$builder_memory" --driver-opt memory-swap="$builder_memory" \
    --buildkitd-config "$toml" >/dev/null
  rm -f "$toml"
fi
docker buildx inspect "$builder" --bootstrap > "$release/builder.log"
cap=$(docker inspect "buildx_buildkit_${builder}0" --format '{{.HostConfig.Memory}}')
[[ "$cap" == "$builder_bytes" ]] || { echo "Builder must have a ${builder_memory} memory cap (has $cap bytes)." >&2; exit 1; }

build() { # build <log> <buildx args...>; the contexts and arguments every target shares
  local log=$1; shift
  docker buildx build --builder "$builder" --platform linux/amd64 \
    --file docker/private-release-vps.Dockerfile \
    --build-context deps-src="$contexts/deps" --build-context website-src="$contexts/website" \
    --build-context app-src="$contexts/full" --build-context package-src="$contexts/package-files" \
    --build-context full-src="$contexts/full" \
    --build-arg "REVISION=$revision" --build-arg "PRIVATE_CONFIG_SHA=$config_sha" \
    --secret "id=private_wrangler,src=$release/wrangler.jsonc" \
    --progress=plain "$@" "$contexts/full" > "$log" 2>&1
}
# A busy host can make BuildKit drop its client session ("no active session ... deadline exceeded").
# The finished layers are cached, so a second attempt is quick.
attempt() { # attempt <log> <buildx args...>
  local log=$1
  build "$@" && return 0
  if grep -q "no active session\|DeadlineExceeded\|ResourceExhausted\|cannot allocate memory" "$log"; then
    echo "BuildKit ran short of time or memory; waiting 60 s and trying once more." >&2
    sleep 60
    build "$@" && return 0
  fi
  tail -40 "$log" >&2
  exit 1
}
echo "Building $image (build memory ${builder_memory}, ${builder_parallelism} parallel)."
if [[ $check == 1 ]]; then
  attempt "$release/checks.log" --target checks
  phase checks
fi
if [[ $worker_only == 0 ]]; then
  attempt "$release/build.log" --target runtime --load --tag "$image"
fi
phase image
attempt "$release/website-export.log" --target website --output "type=local,dest=$release/worker"
phase website
[[ $worker_only == 1 ]] || docker image inspect "$image" --format '{{.Architecture}}' | grep -qx amd64
if [[ $tarball == 1 ]]; then
  docker save "$image" | gzip > "$release/image.tar.gz"
  (cd "$release" && sha256sum image.tar.gz > image.sha256)
  phase tarball
fi
printf '%s\n' "$image" > "$release/image.txt"
printf '%s\n' "$revision" > "$release/revision.txt"
cp scripts/private-release-deploy.py "$release/deploy.py"
elapsed=$((SECONDS - started))
cached=$(grep -c ' CACHED' "$release/build.log" || true)
printf '{"build_seconds":%s,"memory_limit_bytes":8589934592,"architecture":"amd64","cached_steps":%s}\n' \
  "$elapsed" "$cached" > "$release/timing.json"
# sudo docker writes the exported files as root; the deploy helper runs as ubuntu.
sudo -n chown -R ubuntu:ubuntu "$release"
{
  printf 'Built %s in %s seconds (%s cached steps).' "$image" "$elapsed" "$cached"
  for name in "${!phases[@]}"; do printf ' %s=%ss' "$name" "${phases[$name]}"; done
  printf '\nRelease: %s\n' "$release"
}
if [[ $deploy == 1 ]]; then
  # wrangler sometimes answers 7403 while it refreshes its login; that step runs before the host is
  # touched, so one more attempt is safe.
  python3 -I scripts/private-release-deploy.py "$release" --existing-image && exit 0
  if grep -q 7403 "$release/logs/worker-migrations.log" 2>/dev/null; then
    echo "Cloudflare login refresh (7403); trying once more."
    python3 -I scripts/private-release-deploy.py "$release" --existing-image
  else
    exit 1
  fi
else
  printf 'Deploy: python3 -I scripts/private-release-deploy.py %q --existing-image\n' "$release"
fi
