#!/bin/bash
# Started hidden at logon by the "OpenBot Bench" scheduled task (as user bench). Keeps the runner
# alive; while it runs, WSL keeps the distro (and Docker) up.
HOME_DIR=/var/lib/openbot-bench
LOG="$HOME_DIR/runner.log"
exec 9>"$HOME_DIR/runner.lock"
flock -n 9 || exit 0
while true; do
    if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 10485760 ]; then mv -f "$LOG" "$LOG.1"; fi
    for _ in $(seq 1 90); do
        docker info >/dev/null 2>&1 && [ -e /run/openbot-bench/firewall.ok ] && break
        sleep 2
    done
    nice -n 5 python3 /opt/openbot-bench/runner.py run >>"$LOG" 2>&1
    echo "$(date '+%F %T') runner exited with $?; restarting in 10 s" >>"$LOG"
    sleep 10
done
