#!/bin/bash
# Runs as root inside the `openbot-bench` WSL distro, called by install.ps1.
#   setup-distro.sh base <bundle-dir>   packages, Docker, NVIDIA Container Toolkit, bench user, units
#   setup-distro.sh check               after the restart with systemd: Docker, firewall, GPU
set -euo pipefail
phase="${1:-}"
CODE=/opt/openbot-bench
HOME_DIR=/var/lib/openbot-bench

if [ "$phase" = "base" ]; then
    bundle="$2"
    export DEBIAN_FRONTEND=noninteractive
    cat > /etc/wsl.conf <<'CONF'
# Written by the OpenBot bench installer.
[boot]
systemd=true

[user]
default=bench

[interop]
enabled=true
appendWindowsPath=false
CONF
    getent group bench >/dev/null || groupadd -g 10010 bench
    id bench >/dev/null 2>&1 || useradd -m -u 10010 -g 10010 -s /bin/bash bench

    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 iptables docker.io
    # NVIDIA Container Toolkit (GPU containers through WSL's /usr/lib/wsl driver).
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update
    apt-get install -y --no-install-recommends nvidia-container-toolkit
    nvidia-ctk runtime configure --runtime=docker
    # Containers resolve names through public resolvers, never the Windows host (blocked by the firewall).
    python3 - <<'PY'
import json, pathlib
p = pathlib.Path("/etc/docker/daemon.json")
cfg = json.loads(p.read_text()) if p.exists() and p.read_text().strip() else {}
cfg["dns"] = ["1.1.1.1", "9.9.9.9"]
cfg.setdefault("log-driver", "json-file")
cfg.setdefault("log-opts", {"max-size": "20m", "max-file": "2"})
p.write_text(json.dumps(cfg, indent=2) + "\n")
PY
    usermod -aG docker bench

    install -d -m 755 "$CODE"
    rm -rf "$CODE"/*
    cp -r "$bundle"/. "$CODE"/
    chown -R root:root "$CODE"
    chmod -R go-w "$CODE"
    chmod 755 "$CODE"/runner.py "$CODE"/run-runner.sh "$CODE"/firewall.sh "$CODE"/setup-distro.sh
    install -d -m 750 -o bench -g bench "$HOME_DIR"
    cat > /usr/local/bin/openbot-bench <<'CLI'
#!/bin/sh
exec python3 /opt/openbot-bench/runner.py "$@"
CLI
    chmod 755 /usr/local/bin/openbot-bench

    cat > /etc/systemd/system/openbot-bench-firewall.service <<'UNIT'
[Unit]
Description=OpenBot bench: job network without LAN access
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/openbot-bench/firewall.sh
ExecStop=/bin/rm -f /run/openbot-bench/firewall.ok

[Install]
WantedBy=multi-user.target
UNIT
    systemctl enable docker.service openbot-bench-firewall.service 2>/dev/null || true
    echo "base setup done"
    exit 0
fi

if [ "$phase" = "check" ]; then
    systemctl start docker openbot-bench-firewall
    systemctl is-active --quiet docker || { echo "Docker is not running"; exit 1; }
    [ -e /run/openbot-bench/firewall.ok ] || { echo "the bench firewall is not active"; exit 1; }
    if [ -x /usr/lib/wsl/lib/nvidia-smi ]; then
        /usr/lib/wsl/lib/nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
    else
        echo "warning: no NVIDIA driver visible in WSL; GPU jobs will not be sent to this bench"
    fi
    echo "check ok"
    exit 0
fi
echo "usage: setup-distro.sh base <bundle-dir> | check" >&2
exit 2
