#!/usr/bin/env bash
# The weekly text-fit audit on the server: English and Spanish, every story of the newest main.
#
#   scripts/i18n-fit-weekly.sh
#
# 1. Puts a dedicated worktree (OPENBOT_I18N_WORKTREE) at the newest fork/main and installs its
#    packages.
# 2. Builds the static Storybook and serves it on a free local port.
# 3. Runs scripts/i18n-fit-e2e.ts and copies its report and screenshots to
#    OPENBOT_I18N_REPORTS/<UTC date>/.
# 4. Sends the owner a push through the live host's control socket (`POST /v1/owner-alert`) with the
#    count of problems found.
# The crontab of the user ubuntu starts the pushed copy once a week, on Monday at 03:00 UTC:
#   0 3 * * 1  cd /home/ubuntu/openbot-release-work/openbot-dev && git fetch -q fork main && git show fork/main:scripts/i18n-fit-weekly.sh | bash
set -euo pipefail

REPO="${OPENBOT_I18N_REPO:-/home/ubuntu/openbot-release-work/openbot-dev}"
WORKTREE="${OPENBOT_I18N_WORKTREE:-/home/ubuntu/openbot-release-work/wt-i18n-weekly}"
REPORTS="${OPENBOT_I18N_REPORTS:-/home/ubuntu/openbot-release-work/i18n-fit-weekly}"
TEST_LIBS=/opt/openbot/test-libs
export PATH="/opt/openbot/build-tools:/opt/openbot/build-tools/node/bin:$PATH"
export CI=1
if [ -d "$TEST_LIBS" ]; then
  export LD_LIBRARY_PATH="$TEST_LIBS/root/usr/lib/x86_64-linux-gnu:$TEST_LIBS/root/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export FONTCONFIG_FILE="$TEST_LIBS/fonts.conf"
fi

day="$(date -u +%Y-%m-%d)"
out="$REPORTS/$day"
mkdir -p "$out"
log="$out/run.log"
exec > >(tee -a "$log") 2>&1

alert() {
  local title="$1" text="$2"
  python3 -I -c 'import json,sys; print(json.dumps({"title": sys.argv[1], "text": sys.argv[2]}))' "$title" "$text" |
    sudo -n docker exec -i openbot curl -s --unix-socket /run/openbot/control.sock -X POST \
      -H 'content-type: application/json' --data-binary @- http://openbot/v1/owner-alert ||
    echo "The owner alert was not sent."
}

server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'alert "Weekly text-fit audit did not finish" "The run of $day stopped at line $LINENO. Log: $log"' ERR

git -C "$REPO" fetch -q fork main
if [ ! -d "$WORKTREE" ]; then git -C "$REPO" worktree add -q --detach "$WORKTREE" fork/main; fi
git -C "$WORKTREE" checkout -q --detach fork/main
revision="$(git -C "$WORKTREE" rev-parse --short=12 HEAD)"
echo "Revision $revision"
cd "$WORKTREE"
bun install --frozen-lockfile

storybook="$WORKTREE/.openbot-build/i18n-weekly-storybook"
rm -rf "$storybook"
bun run build-storybook -- -o "$storybook" --quiet
port="$(python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
python3 -I -m http.server "$port" --bind 127.0.0.1 --directory "$storybook" >/dev/null 2>&1 &
server_pid=$!
sleep 2

browser="$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort -V | tail -1)"
name="i18n-fit-weekly-$day"
status=0
bun scripts/i18n-fit-e2e.ts --storybook="http://127.0.0.1:$port" ${browser:+--browser-executable="$browser"} \
  --out="$name" || status=$?
cp -r "$WORKTREE/.openbot-build/$name/." "$out/"

if [ ! -f "$out/report.json" ]; then
  alert "Weekly text-fit audit failed" "No report for $revision (exit $status). Log: $log"
  exit 1
fi
summary="$(python3 -I - "$out/report.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
failures = report.get("failures", [])
spanish = sum(1 for f in failures if f.get("locale") == "es" and not f.get("alsoInEnglish"))
english = sum(1 for f in failures if f.get("locale") == "en")
print(f"{len(failures)} {english} {spanish} {report.get('stories', 0)}")
PY
)"
read -r total english spanish stories <<<"$summary"
echo "Problems: $total (English $english, Spanish only $spanish) in $stories stories."
alert "Weekly text-fit audit: $total problems" \
  "$stories stories of $revision in English and Spanish: $english in English, $spanish in Spanish only. Report: $out/report.json"
exit "$status"
