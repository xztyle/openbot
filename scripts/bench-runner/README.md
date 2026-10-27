# OpenBot bench runner (Windows 11 + WSL2)

Turns a Windows PC into a background bench for OpenBot jobs (see
[the broker](../bench-broker/README.md)). Everything runs in a dedicated WSL2 distro `openbot-bench`
(Ubuntu 24.04) with Docker Engine and the NVIDIA Container Toolkit (the GPU comes from WSL's
`/usr/lib/wsl` driver; nothing to install in Windows besides the normal NVIDIA driver). The runner
connects **outbound** to the broker over HTTPS; the PC opens no port. Nothing appears on the desktop.

Files: `install.ps1`, `uninstall.ps1`, `setup-distro.sh` (root, inside the distro), `firewall.sh`
(job network without LAN access), `run-runner.sh` (keeps the runner alive), `runner.py` (runner and the
`openbot-bench` command), `images/` (job images, built locally). The broker serves this folder at
`https://bench.delynith.com/v1/dist/`.

## Install (once, normal PowerShell window)

```powershell
$f = "$env:TEMP\openbot-bench-install.ps1"
Invoke-WebRequest -UseBasicParsing https://bench.delynith.com/v1/dist/install.ps1 -OutFile $f
powershell -ExecutionPolicy Bypass -File $f -Server https://bench.delynith.com
```

It asks for the enrollment code (`sudo python3 /opt/openbot/bench/benchd.py enroll <name> --priority N`
on the server, valid 30 minutes) and:

1. checks WSL (if it is missing: `wsl --install --no-distribution` in an admin PowerShell, reboot);
2. downloads the runner files (SHA-256 checked) and creates the distro with
   `wsl --install Ubuntu-24.04 --name openbot-bench --no-launch`;
3. installs Docker Engine, the NVIDIA Container Toolkit, a non-root `bench` user (uid 10010, in the
   docker group), systemd units for Docker and the firewall, and `/etc/wsl.conf` (systemd on, no
   Windows PATH);
4. shows the proposed `%UserProfile%\.wslconfig` change (`memory=32GB`, `processors=<half the logical
   cores>`), which applies to **all** WSL distros, and writes it only after you confirm (merged into the
   existing file, backup `.wslconfig.bak-<date>`). It takes effect after `wsl --shutdown` (asked
   separately; it stops every running distro) or the next Windows restart;
5. enrolls the PC, builds the job images (5-15 minutes the first time), checks GPU containers;
6. registers the hidden Scheduled Task "OpenBot Bench" (at logon, `conhost --headless wsl.exe ...`,
   restarts on failure) and starts it; adds the `openbot-bench` command and two Desktop shortcuts.

Running the installer again updates the runner and keeps the enrollment.

## Everyday use

```
openbot-bench pause 2h      # or: pause 30m, pause (until resume); Desktop: "OpenBot Bench - pause 2h"
openbot-bench resume        # Desktop: "OpenBot Bench - resume"
openbot-bench status
openbot-bench sync-images   # build newly allowlisted images now
wsl -d openbot-bench -- tail -f /var/lib/openbot-bench/runner.log
```

A pause stops new jobs and freezes running ones (`docker pause`); after 10 minutes paused a job is
handed back to the server. The server shows the pause in `benchctl status`.

## Staying out of the way

- Jobs run at low priority: `nice 10` and idle I/O class inside the container, `--cpu-shares 256`, and
  WSL itself is capped by `.wslconfig` (half the cores, 32 GB).
- GPU: every 5 s the runner reads `nvidia-smi` and, through a hidden PowerShell child, the Windows GPU
  counters per process (WMI classes, so it works on any Windows language), which tell other programs
  apart from WSL. When other programs use more than 50% of the GPU or of its memory, the bench is
  "user busy": it takes no new jobs, pauses a running GPU job, resumes it after 60 s of calm and hands
  it back to the server after 10 minutes paused. Without the Windows counters it falls back to
  `nvidia-smi` totals while no GPU job runs.
- GPU jobs get `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` and `TF_FORCE_GPU_ALLOW_GROWTH=true`.
  A hard cap on GPU time or memory is not possible on consumer NVIDIA cards (no MIG/vGPU), so the
  pause above is the protection. A paused job keeps its GPU memory until it resumes or is handed back.

Settings (optional) in `/var/lib/openbot-bench/settings.json`: `memory_mb` (default 75% of the distro),
`cpus` (default all of the distro's), `pids`, `tmp_mb`, `capacity` (1), `busy_percent` (50), `calm_s`
(60), `handback_s` (600).

## Job sandbox

Each job: a fresh container from an allowlisted image, read-only root, `/tmp` tmpfs, only the job folder
mounted and writable, `--cap-drop ALL`, `no-new-privileges`, uid 10010, memory/CPU/pids limits,
`--gpus all` only for GPU jobs, Xvfb inside the container for display jobs, no host mounts, no Docker
socket. Network: the `openbot-bench` bridge; iptables in the distro drops traffic from it (and from the
build bridge `docker0`) to the distro itself, the Windows host and 10/8, 172.16/12, 192.168/16,
169.254/16, 100.64/10. The runner refuses jobs while the firewall unit is not active. The input archive
is checked against the SHA-256 in the signed job spec.

## Remove

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\OpenBotBench\bundle\uninstall.ps1"
```

and on the server: `sudo python3 /opt/openbot/bench/benchd.py revoke <name>`.

## Not verified

`install.ps1`, the WSL distro setup, the NVIDIA toolkit, the Windows GPU counters and the hidden task
were written for Windows 11 with a current WSL (`wsl --install --name` needs WSL 2.4.4 or later) but
have not run on a real PC yet. The runner protocol, pause and hand-back, drop-and-rerun, cancel, the
chunked output upload through Cloudflare and revocation were tested with `runner.py` on the server
itself. GPU-accelerated OpenGL inside containers on WSL uses Mesa's D3D12 driver (set by the
entrypoint when `/dev/dxg` exists); CUDA works through the toolkit; Vulkan in WSL containers may fall
back to software (`llvmpipe`).
