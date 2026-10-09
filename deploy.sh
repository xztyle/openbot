#!/usr/bin/env bash
# Upload and start an already-built release. Nothing is compiled on the VPS.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
server=${1:-}
key=${2:-}
release=${3:-}
if [[ -z "$server" || -z "$key" || -z "$release" ]]; then
  echo "Usage: ./deploy.sh ubuntu@SERVER SSH_KEY RELEASE_DIRECTORY" >&2
  exit 2
fi
[[ -r "$key" && -f "$release/image.sha256" ]] || { echo "Missing key or built release." >&2; exit 2; }
revision=$(cat "$release/revision.txt")
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid release revision." >&2; exit 2; }
(cd "$release" && shasum -a 256 -c image.sha256)
remote="/opt/openbot/releases/local-$revision"
started=$SECONDS
ssh -i "$key" -S none -o BatchMode=yes "$server" "mkdir -p '$remote' && chmod 700 '$remote'"
COPYFILE_DISABLE=1 tar -czf - -C "$release" image.tar.gz image.sha256 image.txt revision.txt worker deploy.py timing.json \
  | ssh -i "$key" -S none -o BatchMode=yes "$server" "tar -xzf - -C '$remote'"
ssh -i "$key" -S none -o BatchMode=yes "$server" "python3 '$remote/deploy.py' '$remote'"
echo "Upload and deployment took $((SECONDS - started)) seconds."
