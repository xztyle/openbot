#!/usr/bin/env bash
# Build locally. No application restart or deployment happens here.
set -euo pipefail
umask 077
cd "$(dirname "$0")"

server=${1:-}
key=${2:-}
ref=${3:-fork/main}
if [[ -z "$server" || -z "$key" ]]; then
  echo "Usage: ./build.sh ubuntu@SERVER SSH_KEY [git-ref]" >&2
  exit 2
fi
[[ -r "$key" ]] || { echo "SSH key is not readable." >&2; exit 2; }
mkdir -p .openbot-build
if [[ "$ref" == fork/main ]]; then
  git fetch fork main > .openbot-build/release-fetch.log 2>&1
fi
revision=$(git rev-parse "$ref^{commit}")
release="$PWD/.openbot-build/releases/$revision"
builder=openbot-private-builder
image="openbot-private:main-${revision:0:12}"
mkdir -p "$release/context" "$release/worker"
started=$SECONDS

echo "Reading your private website configuration from the VPS."
ssh -i "$key" -S none -o BatchMode=yes "$server" \
  'cat /opt/openbot/source/apps/auth-api/wrangler.jsonc' > "$release/wrangler.jsonc"
config_sha=$(shasum -a 256 "$release/wrangler.jsonc" | cut -d ' ' -f 1)
git archive "$revision" | tar -x -C "$release/context"
# Git archives cannot include local credentials, dependency folders, or user data.
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container \
    --driver-opt memory=8g --driver-opt memory-swap=8g \
    --buildkitd-config docker/private-buildkit.toml >/dev/null
fi
docker buildx inspect "$builder" --bootstrap > "$release/builder.log"
cap=$(docker inspect "buildx_buildkit_${builder}0" --format '{{.HostConfig.Memory}}')
[[ "$cap" == 8589934592 ]] || { echo "Builder must have an 8 GB memory cap." >&2; exit 1; }

echo "Building Linux amd64 locally; maximum build memory is 8 GB."
docker buildx build --builder "$builder" --platform linux/amd64 \
  --file docker/private-release.Dockerfile --target runtime --load \
  --build-arg "REVISION=$revision" --build-arg "PRIVATE_CONFIG_SHA=$config_sha" --secret "id=private_wrangler,src=$release/wrangler.jsonc" \
  --tag "$image" "$release/context" > "$release/build.log" 2>&1
docker buildx build --builder "$builder" --platform linux/amd64 \
  --file docker/private-release.Dockerfile --target website --output "type=local,dest=$release/worker" \
  --build-arg "REVISION=$revision" --build-arg "PRIVATE_CONFIG_SHA=$config_sha" --secret "id=private_wrangler,src=$release/wrangler.jsonc" \
  "$release/context" > "$release/website-export.log" 2>&1
docker image inspect "$image" --format '{{.Architecture}}' | grep -qx amd64
docker save "$image" | gzip > "$release/image.tar.gz"
printf '%s\n' "$image" > "$release/image.txt"
printf '%s\n' "$revision" > "$release/revision.txt"
cp scripts/private-release-deploy.py "$release/deploy.py"
elapsed=$((SECONDS - started))
printf '{"build_seconds":%s,"memory_limit_bytes":8589934592,"architecture":"amd64"}\n' "$elapsed" > "$release/timing.json"
(cd "$release" && shasum -a 256 image.tar.gz > image.sha256)
printf 'Built %s in %s seconds.\nRelease: %s\n' "$image" "$elapsed" "$release"
printf 'Deploy separately: ./deploy.sh %q %q %q\n' "$server" "$key" "$release"
