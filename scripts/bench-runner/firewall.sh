#!/bin/sh
# Job containers reach the internet, never this PC, the Windows host or the LAN.
# Run by openbot-bench-firewall.service (root) after Docker starts; idempotent.
set -e
NETWORK=openbot-bench
BRIDGE=obbench0
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create --driver bridge \
    --subnet 10.213.0.0/24 -o com.docker.network.bridge.name="$BRIDGE" \
    -o com.docker.network.bridge.enable_icc=false --label openbot.bench=1 "$NETWORK" >/dev/null
iptables -nL DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER
# docker0 too: image builds run on the default bridge.
for br in "$BRIDGE" docker0; do
    iptables -C INPUT -i "$br" -j DROP 2>/dev/null || iptables -I INPUT 1 -i "$br" -j DROP
    for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
        iptables -C DOCKER-USER -i "$br" -d "$net" -j DROP 2>/dev/null \
            || iptables -I DOCKER-USER 1 -i "$br" -d "$net" -j DROP
    done
done
mkdir -p /run/openbot-bench
touch /run/openbot-bench/firewall.ok
