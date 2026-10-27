#!/usr/bin/env python3
"""OpenBot bench runner: runs OpenBot jobs on this PC (WSL2 distro `openbot-bench`) in hardened containers.

It connects OUTBOUND to the bench broker over HTTPS (long-poll), so the PC opens no port. Every request is
signed with the bench secret issued at enrollment. Jobs run in fresh containers: read-only root, only the
job folder writable, no capabilities, non-root, memory/CPU/pids limits, the GPU only for GPU jobs, no LAN.

It stays out of the user's way: low CPU/IO priority, and when the user needs the GPU (another program uses
more than 50% of it or of its memory) it takes no new jobs and pauses a running GPU job; it resumes after
60 s of calm and hands the job back to the server after 10 minutes paused.

  runner.py enroll --server URL --code CODE     one time, during install
  runner.py run                                 the service loop (started hidden at logon)
  runner.py pause [2h|30m|forever] | resume | status
  runner.py sync-images                         build missing allowlisted images now
Python standard library only.
"""

import base64
import glob
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "1"
HOME = Path(os.environ.get("OPENBOT_BENCH_HOME", "/var/lib/openbot-bench"))
CODE_DIR = Path(__file__).resolve().parent
CONFIG = HOME / "config.json"
SETTINGS = HOME / "settings.json"
PAUSE = HOME / "pause.json"
JOBS = HOME / "jobs"
JOB_UID = 10010
NETWORK = "openbot-bench"
FIREWALL_OK = Path("/run/openbot-bench/firewall.ok")
POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
CHUNK = 32 * 1024 * 1024  # below Cloudflare's 100 MB request limit
GPU_HINTS = {"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True", "TF_FORCE_GPU_ALLOW_GROWTH": "true"}
DEFAULT_SETTINGS = {
    "memory_mb": None,  # default: 75% of the distro's memory
    "cpus": None,  # default: every CPU the distro has (.wslconfig caps it at half the PC)
    "pids": 4096,
    "tmp_mb": 8192,
    "capacity": 1,
    "busy_percent": 50,
    "calm_s": 60,
    "handback_s": 600,
    "poll_interval_s": 5,
}


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S ") + msg, flush=True)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, value, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, indent=2)
    os.replace(tmp, path)


def settings():
    s = dict(DEFAULT_SETTINGS)
    s.update(read_json(SETTINGS, {}) or {})
    if not s["memory_mb"]:
        total = 0
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                total = int(line.split()[1]) // 1024
        s["memory_mb"] = max(1024, int(total * 0.75))
    if not s["cpus"]:
        s["cpus"] = os.cpu_count() or 2
    return s


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class RunnerError(Exception):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


# ---- signed HTTPS client -----------------------------------------------------------------------


def sign(secret, method, path, ts, nonce, body_hash):
    text = f"{method}\n{path}\n{ts}\n{nonce}\n{body_hash}".encode()
    return hmac.new(secret, text, hashlib.sha256).hexdigest()


def response_sig(secret, nonce, body):
    return hmac.new(secret, b"resp\n" + nonce.encode() + b"\n" + hashlib.sha256(body).hexdigest().encode(),
                    hashlib.sha256).hexdigest()


class Client:
    def __init__(self, server, name, secret):
        self.server = server.rstrip("/")
        self.name = name
        self.secret = bytes.fromhex(secret)
        self.offset = 0.0

    def request(self, method, path, body=b"", content_type="application/json", timeout=60, sink=None,
                body_hash=None, verify_response=False):
        ts = int(time.time() + self.offset)
        nonce = secrets.token_urlsafe(18)
        if body_hash is None:
            body_hash = hashlib.sha256(body if isinstance(body, bytes) else b"").hexdigest()
        headers = {
            "User-Agent": f"openbot-bench-runner/{VERSION}",
            "Content-Type": content_type,
            "X-Bench-Name": self.name,
            "X-Bench-Time": str(ts),
            "X-Bench-Nonce": nonce,
            "X-Bench-Sig": sign(self.secret, method, path, ts, nonce, body_hash),
        }
        data = body if method == "POST" else None
        if hasattr(body, "read"):
            headers["Content-Length"] = str(body.length)
        req = urllib.request.Request(self.server + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if sink is not None:
                    shutil.copyfileobj(resp, sink, 1 << 20)
                    return None
                raw = resp.read()
                if verify_response:
                    expected = response_sig(self.secret, nonce, raw)
                    if not hmac.compare_digest(expected, resp.headers.get("X-Bench-Resp-Sig", "")):
                        raise RunnerError("the server's response signature is wrong; ignoring it")
                return json.loads(raw or b"{}")
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read() or b"{}")
            except (json.JSONDecodeError, OSError):
                payload = {}
            finally:
                err.close()
            if err.code == 401 and payload.get("error") == "clock skew" and payload.get("server_time"):
                self.offset = payload["server_time"] - time.time()
                log(f"adjusted the clock offset to {self.offset:.0f}s")
            raise RunnerError(payload.get("error") or f"HTTP {err.code}", err.code) from None
        except (urllib.error.URLError, OSError, TimeoutError) as err:
            raise RunnerError(f"network: {err}") from None

    def post_json(self, path, value, **kw):
        return self.request("POST", path, json.dumps(value).encode(), **kw)


class FileSlice:
    """A file region as a request body (urllib reads it in blocks)."""

    def __init__(self, path, offset, length):
        self.handle = open(path, "rb")
        self.handle.seek(offset)
        self.length = length
        self.left = length

    def read(self, n=-1):
        if self.left <= 0:
            return b""
        n = self.left if n is None or n < 0 else min(n, self.left)
        block = self.handle.read(n)
        self.left -= len(block)
        return block

    def close(self):
        self.handle.close()


def slice_hash(path, offset, length):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        handle.seek(offset)
        left = length
        while left:
            block = handle.read(min(1 << 20, left))
            if not block:
                break
            digest.update(block)
            left -= len(block)
    return digest.hexdigest()


# ---- the user's GPU ----------------------------------------------------------------------------

MONITOR_PS = r"""
$ErrorActionPreference = 'SilentlyContinue'
$wslNames = @('vmmem', 'vmmemWSL', 'vmwp', 'wslservice', 'wslhost', 'wslrelay', 'wsl')
while ($true) {
  $wsl = @{}
  Get-Process -Name $wslNames | ForEach-Object { $wsl[[int]$_.Id] = $true }
  $eng = @{}
  foreach ($c in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)) {
    if ($c.Name -match '^pid_(\d+)_.*_engtype_(.+)$' -and -not $wsl.ContainsKey([int]$Matches[1])) {
      $eng[$Matches[2]] = [double]$eng[$Matches[2]] + [double]$c.UtilizationPercentage
    }
  }
  $util = 0.0
  foreach ($v in $eng.Values) { if ($v -gt $util) { $util = $v } }
  $mem = 0.0
  foreach ($c in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory)) {
    if ($c.Name -match '^pid_(\d+)_' -and -not $wsl.ContainsKey([int]$Matches[1])) { $mem += [double]$c.DedicatedUsage }
  }
  [Console]::Out.WriteLine((@{ util = [math]::Round([math]::Min($util, 100), 1); vram_mb = [math]::Round($mem / 1MB) } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 5
}
"""


def nvidia_smi():
    for candidate in ("/usr/lib/wsl/lib/nvidia-smi", shutil.which("nvidia-smi")):
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def query_gpu():
    smi = nvidia_smi()
    if not smi:
        return None
    try:
        out = subprocess.run([smi, "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        name, util, used, total = [x.strip() for x in out.stdout.splitlines()[0].split(",")]
        return {"name": name, "util": float(util), "used_mb": float(used), "total_mb": float(total)}
    except (OSError, IndexError, ValueError, subprocess.SubprocessError):
        return None


class GpuWatch:
    """Decides whether the user is using the GPU. Windows counters tell other programs apart from
    WSL (and so from our jobs); without them, nvidia-smi totals are used while no GPU job runs."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.name = None
        self.total_mb = 0
        self.user_busy = False
        self.last_busy = 0.0
        self.others = None  # {"util", "vram_mb", "at"}
        self.reason = ""
        self.lock = threading.Lock()
        self.gpu_jobs_running = lambda: False

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()
        if os.path.exists(POWERSHELL):
            threading.Thread(target=self.windows_monitor, daemon=True).start()

    def windows_monitor(self):
        encoded = base64.b64encode(MONITOR_PS.encode("utf-16-le")).decode()
        while True:
            try:
                proc = subprocess.Popen([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                         "-EncodedCommand", encoded], stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, text=True)
                for line in proc.stdout:
                    try:
                        value = json.loads(line)
                        with self.lock:
                            self.others = {"util": float(value["util"]), "vram_mb": float(value["vram_mb"]),
                                           "at": time.time()}
                    except (ValueError, KeyError, TypeError):
                        continue
                proc.wait()
            except OSError as err:
                log(f"GPU monitor via Windows is unavailable: {err}")
                return
            time.sleep(30)

    def loop(self):
        while True:
            try:
                self.check()
            except Exception:  # noqa: BLE001
                traceback.print_exc()
            time.sleep(self.cfg["poll_interval_s"])

    def check(self):
        smi = query_gpu()
        if smi:
            self.name, self.total_mb = smi["name"], smi["total_mb"]
        with self.lock:
            others = self.others if self.others and time.time() - self.others["at"] < 30 else None
        limit = self.cfg["busy_percent"]
        busy, reason = False, ""
        if others and self.total_mb:
            vram_pct = 100.0 * others["vram_mb"] / self.total_mb
            busy = others["util"] > limit or vram_pct > limit
            reason = f"other programs use {others['util']:.0f}% of the GPU and {vram_pct:.0f}% of its memory"
        elif smi and not self.gpu_jobs_running():
            vram_pct = 100.0 * smi["used_mb"] / max(smi["total_mb"], 1)
            busy = smi["util"] > limit or vram_pct > limit
            reason = f"the GPU is {smi['util']:.0f}% busy with {vram_pct:.0f}% of its memory used"
        elif smi:
            # A GPU job of ours runs and Windows counters are missing: only a nearly full card counts.
            vram_pct = 100.0 * smi["used_mb"] / max(smi["total_mb"], 1)
            busy = vram_pct > 90
            reason = f"GPU memory is {vram_pct:.0f}% used"
        t = time.time()
        if busy:
            if not self.user_busy:
                log(f"user busy: {reason}")
            self.user_busy, self.last_busy, self.reason = True, t, reason
        elif self.user_busy and t - self.last_busy >= self.cfg["calm_s"]:
            log("user calm again")
            self.user_busy = False


# ---- manual pause ------------------------------------------------------------------------------


def parse_duration(text):
    if text in (None, "", "forever"):
        return 10 * 365 * 86400
    m = re.fullmatch(r"(\d+)\s*([smhd]?)", text.strip().lower())
    if not m:
        raise SystemExit(f"bad duration {text!r}; use for example 30m, 2h or forever")
    return int(m.group(1)) * {"": 60, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)]


def paused_until():
    value = read_json(PAUSE, {}) or {}
    until = float(value.get("until") or 0)
    return until if until > time.time() else 0


# ---- containers --------------------------------------------------------------------------------


def docker(*args, timeout=120):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def local_images():
    r = docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
    return sorted({line for line in r.stdout.split() if line and "<none>" not in line})


def docker_run_args(job_id, spec, workdir, limits, gpu, where):
    """The one fixed shape of a job container. Mirrors benchd.py docker_run_args."""
    env = {"HOME": "/tmp", "BENCH_JOB": job_id, "BENCH_HOST": where,
           "BENCH_GPU": "1" if gpu else "0", "BENCH_DISPLAY": "1" if spec["display"] else "0", **GPU_HINTS}
    args = ["run", "--rm", "--name", f"obbench-{job_id}", "--label", "openbot.bench=1",
            "--read-only", "--tmpfs", f"/tmp:rw,nosuid,nodev,exec,size={int(limits['tmp_mb'])}m",
            "--shm-size", "1g", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", f"{JOB_UID}:{JOB_UID}", "--pids-limit", str(int(limits["pids"])),
            "--memory", f"{int(limits['memory_mb'])}m", "--memory-swap", f"{int(limits['memory_mb'])}m",
            "--cpus", str(float(limits["cpus"])), "--cpu-shares", "256",
            "--network", NETWORK, "--dns", "1.1.1.1", "--dns", "9.9.9.9",
            "--mount", f"type=bind,src={workdir},dst=/work",
            "-w", "/work" if spec["workdir"] in (".", "") else f"/work/{spec['workdir']}"]
    if gpu:
        args += ["--gpus", "all", "-e", "NVIDIA_DRIVER_CAPABILITIES=all"]
    for key, value in env.items():
        args += ["-e", f"{key}={value}"]
    return args + [spec["image_ref"], *spec["cmd"]]


def check_rel(path):
    if not isinstance(path, str) or not path or path.startswith("/") or "\0" in path or "\\" in path \
            or any(p == ".." for p in path.split("/")):
        raise RunnerError(f"invalid path in job spec: {path!r}")


def pack_outputs(work, patterns, dest, cap, note):
    """Mirrors benchd.py pack_outputs: declared globs only, no links that leave the job folder."""
    work = Path(work)
    real_work = os.path.realpath(work)
    total = [0]
    found = []
    for pattern in patterns:
        matches = sorted(glob.glob(pattern, root_dir=work, recursive=True, include_hidden=True))
        if not matches:
            note(f"output not found: {pattern}")
        for match in matches:
            full = os.path.realpath(work / os.path.dirname(match))
            if full != real_work and not full.startswith(real_work + os.sep):
                note(f"skipped output outside the job folder: {match}")
                continue
            found.append(match)

    def keep(info):
        if info.isdev() or info.isfifo():
            return None
        if info.issym() or info.islnk():
            target = os.path.normpath(os.path.join(os.path.dirname(info.name), info.linkname)) \
                if info.issym() else os.path.normpath(info.linkname)
            if os.path.isabs(info.linkname) or target.startswith(".."):
                note(f"skipped link that points outside the job folder: {info.name}")
                return None
        total[0] += info.size
        if total[0] > cap:
            raise RunnerError(f"outputs are larger than the {cap // (1024 * 1024)} MB cap")
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info

    with tarfile.open(dest, "w:gz", compresslevel=1) as tar:
        for match in dict.fromkeys(found):
            tar.add(work / match, arcname=os.path.normpath(match), recursive=True, filter=keep)
    return total[0]


class Job:
    def __init__(self, runner, spec):
        self.runner = runner
        self.spec = spec
        self.id = spec["id"]
        self.cname = f"obbench-{self.id}"
        self.dir = JOBS / self.id
        self.cancelled = False
        self.paused = False
        self.paused_since = 0.0
        self.paused_total = 0.0
        self.buffer = bytearray()
        self.buffer_lock = threading.Lock()
        self.log_sent = 0
        self.done = threading.Event()
        self.started = time.time()

    def note(self, message):
        self.append(f"[bench] {message}\n".encode())

    def append(self, data):
        with self.buffer_lock:
            if self.log_sent + len(self.buffer) < self.spec["max_log_bytes"]:
                self.buffer.extend(data)

    def flush_log(self):
        with self.buffer_lock:
            data = bytes(self.buffer[:4 * 1024 * 1024])
            del self.buffer[: len(data)]
        if data:
            try:
                self.runner.client.request("POST", f"/v1/runner/jobs/{self.id}/log", data, "application/octet-stream")
                self.log_sent += len(data)
            except RunnerError as err:
                if err.status == 409:
                    self.cancelled = True
                else:
                    with self.buffer_lock:
                        self.buffer[:0] = data

    def log_pump(self):
        while not self.done.is_set():
            self.flush_log()
            self.done.wait(1.0)
        self.flush_log()

    def set_paused(self, paused, reason=""):
        if paused == self.paused:
            return
        r = docker("pause" if paused else "unpause", self.cname)
        if r.returncode != 0:
            return
        self.paused = paused
        if paused:
            self.paused_since = time.time()
        else:
            self.paused_total += time.time() - self.paused_since
        try:
            self.runner.client.post_json(f"/v1/runner/jobs/{self.id}/state", {"paused": paused, "reason": reason})
        except RunnerError:
            pass

    def run(self):
        threading.Thread(target=self.log_pump, daemon=True).start()
        result = {}
        try:
            result = self.execute()
        except RunnerError as err:
            result = {"error": str(err), "retry": err.status in (-1, 0)}
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            result = {"error": f"runner error: {err}", "retry": True}
        finally:
            docker("rm", "-f", self.cname)
            self.done.set()
            time.sleep(0.2)
            self.flush_log()
        if not self.cancelled:
            try:
                self.upload_and_report(result)
            except RunnerError as err:
                log(f"job {self.id}: could not report the result: {err}")
        shutil.rmtree(self.dir, ignore_errors=True)
        self.runner.finished(self)

    def execute(self):
        spec = self.spec
        for path in spec["outputs"] + [spec["workdir"]]:
            check_rel(path)
        if not FIREWALL_OK.exists():
            raise RunnerError("the bench firewall is not active (openbot-bench-firewall.service)", -1)
        if spec["image_ref"] not in local_images():
            raise RunnerError(f"image {spec['image_ref']} is not built on this bench yet", -1)
        shutil.rmtree(self.dir, ignore_errors=True)
        work = self.dir / "work"
        work.mkdir(parents=True)
        archive = self.dir / "input.tar.gz"
        with open(archive, "wb") as sink:
            self.runner.client.request("GET", f"/v1/runner/jobs/{self.id}/input", timeout=600, sink=sink)
        if sha256_file(archive) != spec["input_sha256"]:
            raise RunnerError("the job input does not match its checksum", -1)
        with tarfile.open(archive, "r:gz") as tar:
            tar.extractall(work, filter="data")
        archive.unlink()
        os.chmod(work, 0o755)
        if os.geteuid() == 0:  # normally the runner is the bench user (uid 10010) itself
            subprocess.run(["chown", "-hR", f"{JOB_UID}:{JOB_UID}", str(work)], check=True)
        elif os.geteuid() != JOB_UID:
            raise RunnerError(f"the runner must run as uid {JOB_UID} (the bench user)", -1)
        gpu = bool(spec["gpu"]) and self.runner.gpu.name is not None
        args = docker_run_args(self.id, spec, work, self.runner.limits(), gpu, self.runner.client.name)
        self.note(f"bench {self.runner.client.name}: starting{' with the GPU' if gpu else ''}")
        self.started = time.time()
        proc = subprocess.Popen(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(target=self.read_output, args=(proc,), daemon=True).start()
        timed_out = handback = False
        while proc.poll() is None:
            time.sleep(1)
            if self.cancelled or self.id not in self.runner.active:
                self.cancelled = True
                docker("kill", self.cname)
                break
            running = time.time() - self.paused_since if self.paused else 0
            elapsed = time.time() - self.started - self.paused_total - running
            if elapsed > spec["timeout_s"] and not timed_out:
                timed_out = True
                self.note(f"timeout after {spec['timeout_s']}s; stopping")
                self.set_paused(False)
                docker("kill", self.cname)
                continue
            manual = paused_until() > 0
            busy = spec["gpu"] and self.runner.gpu.user_busy
            if manual or busy:
                self.set_paused(True, "paused by the user" if manual else self.runner.gpu.reason)
            elif self.paused:
                self.set_paused(False)
            if self.paused and time.time() - self.paused_since > self.runner.cfg["handback_s"]:
                handback = True
                docker("unpause", self.cname)
                docker("kill", self.cname)
                break
        code = proc.wait()
        if handback:
            limit = int(self.runner.cfg["handback_s"])
            span = f"{limit // 60} minutes" if limit >= 120 else f"{limit} seconds"
            return {"handback": True, "reason": f"paused for more than {span}"}
        if self.cancelled:
            return {}
        out = self.dir / "output.tar.gz"
        size = pack_outputs(work, spec["outputs"], out, spec["max_output_bytes"], self.note) if spec["outputs"] else None
        return {"exit_code": code, "timed_out": timed_out, "output": out if size is not None else None,
                "output_bytes": size or 0}

    def read_output(self, proc):
        while True:
            chunk = proc.stdout.read1(65536)
            if not chunk:
                break
            self.append(chunk)

    def upload_and_report(self, result):
        client = self.runner.client
        out = result.pop("output", None)
        if out and Path(out).exists():
            size = os.path.getsize(out)
            offset = 0
            while offset < size or (size == 0 and offset == 0):
                length = min(CHUNK, size - offset)
                body = FileSlice(out, offset, length)
                try:
                    reply = client.request("POST", f"/v1/runner/jobs/{self.id}/output?offset={offset}", body,
                                           "application/octet-stream", timeout=600,
                                           body_hash=slice_hash(out, offset, length))
                finally:
                    body.close()
                offset = reply["next"]
                if size == 0:
                    break
            result["output_sha256"] = sha256_file(out)
        client.post_json(f"/v1/runner/jobs/{self.id}/result", result, timeout=120)


# ---- the service loop --------------------------------------------------------------------------


class Runner:
    def __init__(self):
        config = read_json(CONFIG)
        if not config:
            raise SystemExit(f"not enrolled: {CONFIG} is missing (runner.py enroll --server URL --code CODE)")
        self.client = Client(config["server"], config["name"], config["secret"])
        self.cfg = settings()
        self.gpu = GpuWatch(self.cfg)
        self.gpu.gpu_jobs_running = lambda: any(j.spec["gpu"] for j in self.jobs.values())
        self.jobs = {}
        self.active = set()
        self.images = []
        self.images_at = 0.0
        self.lock = threading.Lock()

    def limits(self):
        return {k: self.cfg[k] for k in ("memory_mb", "cpus", "pids", "tmp_mb")}

    def finished(self, job):
        with self.lock:
            self.jobs.pop(job.id, None)

    def status(self):
        if time.time() - self.images_at > 60:
            self.images, self.images_at = local_images(), time.time()
        return {
            "user_busy": self.gpu.user_busy,
            "paused_until": paused_until(),
            "gpu": self.gpu.name,
            "images": self.images,
            "capacity": self.cfg["capacity"] if FIREWALL_OK.exists() else 0,
            "version": VERSION,
        }

    def run(self):
        JOBS.mkdir(parents=True, exist_ok=True)
        subprocess.run("docker ps -aq --filter label=openbot.bench=1 | xargs -r docker rm -f", shell=True,
                       capture_output=True)
        for stale in JOBS.iterdir():
            shutil.rmtree(stale, ignore_errors=True)
        self.gpu.start()
        threading.Thread(target=self.image_sync_loop, daemon=True).start()
        log(f"runner {VERSION} for bench {self.client.name} -> {self.client.server}; "
            f"limits {self.limits()}, gpu {query_gpu()}")
        failures = 0
        while True:
            try:
                reply = self.client.post_json("/v1/runner/poll", {"status": self.status()}, timeout=60,
                                              verify_response=True)
                failures = 0
            except RunnerError as err:
                failures += 1
                wait = min(60, 3 * failures)
                if failures in (1, 5) or failures % 20 == 0:
                    log(f"poll failed ({err}); retrying in {wait}s")
                if err.status == 401 and err.args[0] == "unauthorized" and failures >= 3:
                    log("the server rejects this bench's secret (revoked?); re-enroll to use it again")
                time.sleep(wait)
                continue
            self.active = set(reply.get("active") or [])
            for spec in reply.get("jobs") or []:
                with self.lock:
                    if spec["id"] in self.jobs:
                        continue
                    job = Job(self, spec)
                    self.jobs[job.id] = job
                log(f"job {job.id}: {' '.join(spec['cmd'])[:120]}")
                threading.Thread(target=job.run, daemon=True).start()

    def image_sync_loop(self):
        while True:
            try:
                sync_images(self.client.server)
                self.images_at = 0
            except Exception as err:  # noqa: BLE001
                log(f"image sync failed: {err}")
            time.sleep(6 * 3600)


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": f"openbot-bench-runner/{VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def sync_images(server):
    """Build every allowlisted image that is missing here, from the Dockerfiles the server publishes."""
    manifest = json.loads(fetch(server.rstrip("/") + "/v1/dist/manifest.json"))
    have = set(local_images())
    order = sorted(manifest["images"].items(), key=lambda kv: kv[0] != "bench-base")
    for name, ref in order:
        if ref in have:
            continue
        files = {p: h for p, h in manifest["files"].items() if p.startswith(f"images/{name}/")}
        if not files:
            log(f"image {name}: the server publishes no Dockerfile; skipped")
            continue
        build = HOME / "build" / name
        shutil.rmtree(build, ignore_errors=True)
        build.mkdir(parents=True)
        for rel, digest in files.items():
            data = fetch(server.rstrip("/") + "/v1/dist/" + rel)
            if hashlib.sha256(data).hexdigest() != digest:
                raise RunnerError(f"{rel} changed while downloading; try again")
            target = build / rel.split("/", 2)[2]
            target.write_bytes(data)
            if not target.suffix:
                target.chmod(0o755)
        log(f"building image {name} as {ref} (low priority) ...")
        r = subprocess.run(["nice", "-n", "19", "docker", "build", "-t", ref, str(build)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            log(f"image {name} failed to build:\n{r.stderr[-2000:]}")
        else:
            log(f"image {name} built")
        shutil.rmtree(build, ignore_errors=True)


# ---- commands ----------------------------------------------------------------------------------


def enroll(server, code):
    server = server.rstrip("/")
    if not server.startswith("https://"):
        raise SystemExit("the server URL must start with https://")
    req = urllib.request.Request(server + "/v1/runner/enroll", data=json.dumps({"code": code}).encode(),
                                 method="POST", headers={"Content-Type": "application/json",
                                                         "User-Agent": f"openbot-bench-runner/{VERSION}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            reply = json.loads(resp.read())
    except urllib.error.HTTPError as err:
        try:
            message = json.loads(err.read()).get("error")
        except (json.JSONDecodeError, OSError):
            message = f"HTTP {err.code}"
        raise SystemExit(f"enrollment failed: {message}") from None
    write_json(CONFIG, {"server": server, "name": reply["name"], "secret": reply["secret"]})
    print(f"Enrolled as bench {reply['name']}.")


def show_status():
    config = read_json(CONFIG) or {}
    until = paused_until()
    gpu = query_gpu()
    print(f"bench:  {config.get('name', '(not enrolled)')} -> {config.get('server', '-')}")
    print(f"paused: {'until ' + time.strftime('%Y-%m-%d %H:%M', time.localtime(until)) if until else 'no'}")
    print(f"gpu:    {gpu['name'] + ', ' + str(int(gpu['util'])) + '% busy, ' + str(int(gpu['used_mb'])) + ' MB used' if gpu else 'none'}")
    print(f"limits: {json.dumps({k: v for k, v in settings().items() if k in ('memory_mb', 'cpus', 'capacity')})}")
    r = docker("ps", "--filter", "label=openbot.bench=1", "--format", "{{.Names}} {{.Status}}")
    print("jobs:   " + (", ".join(r.stdout.split("\n")).strip(", ") or "none"))
    print(f"images: {', '.join(i for i in local_images() if i.startswith('openbot-bench/')) or 'none'}")


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(__doc__)
        return
    cmd = args[0]
    if cmd == "enroll":
        opts = dict(zip(args[1::2], args[2::2]))
        if "--server" not in opts or "--code" not in opts:
            raise SystemExit("usage: runner.py enroll --server URL --code CODE")
        enroll(opts["--server"], opts["--code"])
    elif cmd == "run":
        Runner().run()
    elif cmd == "pause":
        seconds = parse_duration(args[1] if len(args) > 1 else "forever")
        write_json(PAUSE, {"until": time.time() + seconds}, 0o644)
        print("Bench paused " + ("until you resume it." if seconds > 365 * 86400 else
                                 "until " + time.strftime("%H:%M", time.localtime(time.time() + seconds)) + ".")
              + " Running jobs are paused and handed back to the server after 10 minutes.")
    elif cmd == "resume":
        PAUSE.unlink(missing_ok=True)
        print("Bench resumed.")
    elif cmd == "status":
        show_status()
    elif cmd == "sync-images":
        sync_images((read_json(CONFIG) or {}).get("server") or args[1])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
