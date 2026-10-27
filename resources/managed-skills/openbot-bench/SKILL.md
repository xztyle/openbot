---
name: openbot-bench
description: Run heavy work (compilations, test suites, GPU-rendered tests, game or app builds, screenshots of graphical programs) on the user's bench PC with the benchctl command, instead of in your own container. Use for builds and tests that need a lot of CPU or memory, a GPU, or a display.
---

# Heavy jobs on the bench

`benchctl` sends a folder and a command to a **bench**: one of the user's own PCs (with a strong GPU) that runs jobs in the background. If no bench is free, the same job runs on the server instead, with the same image and limits but without a GPU. This fallback is automatic; you do not choose where a job runs. Run `python3 /opt/benchctl/benchctl --help` for the full syntax. In the examples below `benchctl` means that command.

If `benchctl` says it cannot reach the bench broker, the feature is not installed on this server. Run the work in your own container as usual and do not mention it again.

## When to use it

- Compiling a large project (Rust, C++, Godot exports, Electron or other big JavaScript builds), and full test suites.
- Anything that needs a GPU (`--gpu`): CUDA, GPU-rendered tests, game rendering, shader compilation.
- Anything that needs a screen (`--display`): screenshots of a game or desktop app, browser or UI tests that need a real X display.
- Quick edits, small scripts, linting and short unit tests stay in your own container. A bench job adds a few seconds of overhead.

## Running a job

```bash
cd /path/to/project
benchctl run [--gpu] [--display] [--out PATH]... [--timeout SECONDS] [--image NAME] -- <command...>
```

- It packs the current folder (or `--cwd DIR`), sends it, prints the log live, copies the paths given with `--out` back into the folder, and exits with the command's exit code. Read the exit code like any local command.
- `--out` takes a path or a glob relative to the folder, and can repeat: `--out build/game.x86_64 --out 'screenshots/*.png'`. Only declared outputs come back; everything else is discarded.
- Not sent by default: `.git`, `node_modules`, `__pycache__`, `.venv`, `venv`, `.cache`, `target`, `.gradle`. Add `--exclude PATTERN` or a `.benchignore` file (one pattern per line) to skip more, such as big assets the job does not need. The packed folder is limited to 1 GB, the outputs to 2 GB.
- The job installs its own dependencies (`npm ci`, `pip install`, `cargo build`) inside the command: each job starts from a clean container. Chain the steps: `benchctl run -- bash -c 'npm ci && npm run build'`.
- Default timeout 30 minutes, at most 2 hours (`--timeout 7200`). For long jobs, use `--detach` and then `benchctl wait <job>`, which streams the rest of the log and copies the outputs back. `benchctl cancel <job>` stops a job.
- Exit codes 124 (timeout), 125 (bench or transfer problem) and 130 (cancelled) come from the bench, not from your command.

## Inside the job

- The folder is `/work` and the job starts there. Besides it, only `/tmp` is writable. `HOME` is `/tmp`. The job runs as an unprivileged user, so no `sudo` and no `apt-get install`.
- The default image `bench-base` is Ubuntu 24.04 with build-essential, cmake, ninja, git, Python 3, Node.js 22, Xvfb, Mesa (OpenGL and Vulkan), ImageMagick and xdotool. `benchctl status` lists the other allowed images, such as one for Godot. If you need a tool that no image has, install it under `/work` or `/tmp` inside the command (for example a downloaded binary, or a virtualenv: `python3 -m venv /tmp/venv`), or ask the user to add an image.
- With `--display`, `DISPLAY=:99` is a virtual screen. Take a screenshot with `import -window root shot.png` and bring it back with `--out shot.png`. Nothing appears on the user's real screen.
- With `--gpu`, `nvidia-smi` and CUDA work on a bench. `BENCH_GPU` is `1` when a GPU is present and `0` when the job fell back to the server, where rendering is software only (`llvmpipe`). Check `BENCH_GPU` before reporting GPU performance.
- `BENCH_HOST` names where the job ran (a bench name or `server`).
- Internet access works. The user's home network, the server's services and other jobs are not reachable from a job.

## Rules

- Never try to reach a bench PC directly (no SSH, no IP addresses, no shared folders). `benchctl` is the only way.
- Never put secrets, tokens or credentials in the folder you send or in the command.
- The bench is the user's own PC. Send real work, not experiments in a loop. If a job fails, read the log, fix the cause, then run it again.
- A job may pause while the user plays a game or otherwise uses the GPU, and continue later or move to the server. This is normal: the log says so. Do not cancel and resubmit because of it.
- `benchctl status` shows the benches (online, paused, busy, GPU) and recent jobs. Use it when the user asks about the bench, or when jobs keep running on the server.

## Talking to the user

Report the outcome: what was built or tested, whether it passed, where the outputs are, and where it ran if it matters (for example "rendered on your PC's GPU", or "no bench was free, so it ran on the server without a GPU"). Do not paste whole build logs.
