#!/usr/bin/env python3
"""OpenBot bench broker.

Lets OpenBot agents (inside the `openbot` container) run heavy jobs - compilations, GPU-rendered
tests, screenshots - on a "bench": a user's PC that runs the bench runner and connects outbound to
this broker over HTTPS. If no bench is available the job runs on this server in Docker, with the same
image and the same hardening (no GPU). Agents never reach a bench directly.

Agents talk to the broker through a unix socket and the `benchctl` client next to it. A job is a fixed
spec: an allowlisted image, a command, gpu/display flags, a timeout and the outputs to copy back.
Nothing else (no Docker flags, no mounts, no env from the caller).

Runners authenticate every request with a per-bench secret (HMAC-SHA256 over method, path,
timestamp, nonce and body hash). The secret is issued once, at enrollment, for a one-time code.

Subcommands:
  serve                         run the broker (systemd: openbot-bench.service)
  install                       install or update (root): files, unit, nginx vhost
  build-images                  build the allowlisted images on this server (root)
  enroll <name> --priority N    print a one-time enrollment code (valid 30 minutes)
  list                          benches with their live state
  revoke <name>                 delete a bench and its secret (immediate)
  priority <name> N | pause <name> | resume <name>
  status | config
Python standard library only.
"""

import glob
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import socket
import socketserver
import subprocess
import sys
import tarfile
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(os.environ.get("BENCH_BASE", "/opt/openbot/bench"))
NGINX_CONF = Path(os.environ.get("BENCH_NGINX_CONF", "/etc/nginx/conf.d/openbot-bench.conf"))
CLIENT_DIR = BASE / "client"
SOCKET_PATH = CLIENT_DIR / "benchctl.sock"
KEYS = BASE / "keys"
STATE = BASE / "state"
JOBS_DIR = BASE / "jobs"
DIST = BASE / "runner-dist"
AUDIT = BASE / "audit.jsonl"
OWNER_UID = int(os.environ.get("BENCH_SOCKET_UID", "1000"))
JOB_UID = 10010  # the uid jobs run as, on the server and on every bench
NETWORK = "openbot-bench"
BRIDGE = "obbench0"
SUBNET = "10.213.0.0/24"
BLOCKED_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]

DEFAULT_CONFIG = {
    "public_url": "https://bench.delynith.com",
    "server_name": "bench.delynith.com",
    "listen_port": 8461,
    "tls_cert": "/opt/openbot/apps/tls/origin.pem",
    "tls_key": "/opt/openbot/apps/tls/origin.key",
    # Name agents use -> image reference. Every image must be built FROM openbot-bench/base (entrypoint).
    "images": {"bench-base": "openbot-bench/base:1"},
    "default_image": "bench-base",
    "default_timeout_s": 1800,
    "max_timeout_s": 7200,
    "max_upload_mb": 1024,
    "max_output_mb": 2048,
    "max_log_mb": 20,
    "heartbeat_s": 30,
    "enroll_ttl_s": 1800,
    "max_queued_jobs": 16,
    "min_free_disk_mb": 10000,
    "job_keep_hours": 24,
    "server_fallback": True,
    "server_slots": 2,
    "server_limits": {"memory_mb": 8192, "cpus": 4, "pids": 4096, "tmp_mb": 4096},
}

CLOUDFLARE_RANGES = """173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15
104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32
2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32 127.0.0.1/32 ::1/128""".split()

NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,28}[a-z0-9]$")
JOB_RE = re.compile(r"^[0-9a-f]{10}$")
IMAGE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
MAX_CMD_ARGS = 256
MAX_CMD_BYTES = 65536
MAX_OUTPUTS = 64
SKEW_S = 300
POLL_HOLD_S = 20
CHUNK_MAX = 64 * 1024 * 1024
DIST_FILES = re.compile(r"^(?:[A-Za-z0-9_.-]+|images/[a-z0-9._-]+/[A-Za-z0-9_.-]+)$")
GPU_HINTS = {"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True", "TF_FORCE_GPU_ALLOW_GROWTH": "true"}

STARTED_AT = time.time()


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now():
    return time.time()


def iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts if ts is not None else time.time()))


def say(msg):
    print(msg, flush=True)


def load_config():
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    path = BASE / "config.json"
    if path.exists():
        cfg.update(json.loads(path.read_text()))
    return cfg


def write_json(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def check_name(name):
    if not NAME_RE.match(name or ""):
        raise ApiError("Invalid bench name. Use 3-30 lowercase letters, digits and hyphens, starting with a letter.")


# ---- benches: registry on disk (admin CLI writes it), live state in memory --------------------


def bench_path(name):
    return STATE / "benches" / f"{name}.json"


def key_path(name):
    return KEYS / f"{name}.key"


def list_benches():
    folder = STATE / "benches"
    out = []
    for path in sorted(folder.glob("*.json")) if folder.exists() else []:
        bench = read_json(path)
        if bench and key_path(bench["name"]).exists():
            out.append(bench)
    return out


def bench_secret(name):
    """Read on every request, so a revocation applies to the very next request."""
    if not NAME_RE.match(name or ""):
        return None
    try:
        return bytes.fromhex(key_path(name).read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


live = {}  # name -> {"last_seen", "polling", "status", "ip"}
live_lock = threading.Lock()


def bench_online(name, cfg):
    with live_lock:
        entry = live.get(name)
    if not entry:
        return False
    return entry["polling"] > 0 or now() - entry["last_seen"] < cfg["heartbeat_s"]


def bench_view(bench, cfg):
    with live_lock:
        entry = dict(live.get(bench["name"]) or {})
    status = entry.get("status") or {}
    manual = status.get("paused_until") or 0
    return {
        "name": bench["name"],
        "priority": bench.get("priority", 0),
        "online": bench_online(bench["name"], cfg),
        "paused": bool(bench.get("paused")) or manual > now(),
        "paused_by": "admin" if bench.get("paused") else ("user until " + iso(manual) if manual > now() else None),
        "user_busy": bool(status.get("user_busy")),
        "gpu": status.get("gpu") or None,
        "capacity": capacity_of(bench, status),
        "running": len([j for j in jobs_snapshot() if j.bench == bench["name"] and j.state in ("assigned", "running")]),
        "images": [n for n, ref in cfg["images"].items() if ref in (status.get("images") or [])],
        "last_seen": iso(entry["last_seen"]) if entry.get("last_seen") else None,
        "runner_version": status.get("version"),
    }


def capacity_of(bench, status):
    cap = int(status.get("capacity") or 1)
    if bench.get("capacity"):
        cap = min(cap, int(bench["capacity"]))
    return max(0, cap)


# ---- request signing ---------------------------------------------------------------------------


def signing_string(method, path, ts, nonce, body_hash):
    return f"{method}\n{path}\n{ts}\n{nonce}\n{body_hash}".encode()


def sign(secret, method, path, ts, nonce, body_hash):
    return hmac.new(secret, signing_string(method, path, ts, nonce, body_hash), hashlib.sha256).hexdigest()


def response_sig(secret, nonce, body):
    return hmac.new(secret, b"resp\n" + nonce.encode() + b"\n" + hashlib.sha256(body).hexdigest().encode(),
                    hashlib.sha256).hexdigest()


_nonces = {}
_nonce_lock = threading.Lock()


def verify_request(headers, method, path, body_hash):
    """Returns (name, secret, nonce). Raises 401 on any failure, without saying which part failed,
    except clock skew (the runner corrects its clock from server_time)."""
    name = headers.get("X-Bench-Name", "")
    ts_raw = headers.get("X-Bench-Time", "")
    nonce = headers.get("X-Bench-Nonce", "")
    sig = headers.get("X-Bench-Sig", "")
    secret = bench_secret(name)
    if not secret or not re.fullmatch(r"[A-Za-z0-9_-]{16,64}", nonce) or not re.fullmatch(r"[0-9a-f]{64}", sig):
        raise ApiError("unauthorized", 401)
    try:
        ts = int(ts_raw)
    except ValueError:
        raise ApiError("unauthorized", 401) from None
    expected = sign(secret, method, path, ts, nonce, body_hash)
    if not hmac.compare_digest(expected, sig):
        raise ApiError("unauthorized", 401)
    t = now()
    # Requests older than the broker's start could be replays of requests seen before a restart.
    if abs(t - ts) > SKEW_S or ts < STARTED_AT - 1:
        raise ApiError("clock skew", 401)
    with _nonce_lock:
        for key in [k for k, exp in _nonces.items() if exp < t]:
            del _nonces[key]
        if nonce in _nonces:
            raise ApiError("unauthorized", 401)
        _nonces[nonce] = t + 2 * SKEW_S
    return name, secret, nonce


# ---- enrollment --------------------------------------------------------------------------------


def code_hash(code):
    return hashlib.sha256(re.sub(r"[^A-Z0-9]", "", code.upper()).encode()).hexdigest()


def create_enrollment(name, priority, cfg):
    check_name(name)
    if key_path(name).exists():
        raise ApiError(f"A bench named {name} already exists; revoke it first to enroll it again.")
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    raw = "".join(secrets.choice(alphabet) for _ in range(20))
    code = "-".join(raw[i : i + 5] for i in range(0, 20, 5))
    folder = STATE / "enroll"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.json"):
        entry = read_json(old) or {}
        if entry.get("expires", 0) < now() or entry.get("name") == name:
            old.unlink(missing_ok=True)
    write_json(folder / f"{code_hash(code)}.json",
               {"name": name, "priority": int(priority), "expires": now() + cfg["enroll_ttl_s"]})
    return code


_enroll_attempts = []
_enroll_lock = threading.Lock()


def redeem_enrollment(code):
    with _enroll_lock:
        t = now()
        _enroll_attempts[:] = [a for a in _enroll_attempts if a > t - 600]
        if len(_enroll_attempts) >= 30:
            raise ApiError("Too many enrollment attempts; wait a few minutes.", 429)
        _enroll_attempts.append(t)
        if not isinstance(code, str) or len(code) > 64:
            raise ApiError("Invalid enrollment code.", 403)
        path = STATE / "enroll" / f"{code_hash(code)}.json"
        entry = read_json(path)
        path.unlink(missing_ok=True)  # single use, even when expired
        if not entry or entry["expires"] < t:
            raise ApiError("Invalid or expired enrollment code.", 403)
        name = entry["name"]
        if key_path(name).exists():
            raise ApiError("This bench is already enrolled.", 409)
        secret = secrets.token_bytes(32)
        KEYS.mkdir(parents=True, exist_ok=True)
        os.chmod(KEYS, 0o700)
        fd = os.open(key_path(name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(secret.hex())
        write_json(bench_path(name), {"name": name, "priority": entry["priority"], "paused": False,
                                      "enrolled": iso()})
        audit({"event": "enrolled", "bench": name, "priority": entry["priority"]})
        say(f"bench {name} enrolled")
        return {"name": name, "secret": secret.hex()}


# ---- jobs --------------------------------------------------------------------------------------

jobs = {}
jobs_lock = threading.Lock()
wake = threading.Condition()  # notified on any scheduling-relevant change


def jobs_snapshot():
    with jobs_lock:
        return list(jobs.values())


def notify():
    with wake:
        wake.notify_all()


def audit(entry):
    entry = {"at": iso(), **entry}
    with open(AUDIT, "a") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


class Job:
    def __init__(self, spec, upload):
        self.id = secrets.token_hex(5)
        self.spec = spec
        self.created = now()
        self.state = "queued"  # queued, assigned, running, done, failed, cancelled
        self.bench = None  # bench name, "server", or None
        self.assigned_at = None
        self.fetched = False
        self.attempts = []  # {"target", "started", "ended", "outcome"}
        self.drops = 0
        self.exclude = set()
        self.exit_code = None
        self.error = None
        self.finished = None
        self.paused = False
        self.cancel_requested = False
        self.output_ready = False
        self.output_size = 0
        self.dir = JOBS_DIR / self.id
        self.dir.mkdir(parents=True, exist_ok=True)
        os.replace(upload, self.dir / "input.tar.gz")
        self.input_size = (self.dir / "input.tar.gz").stat().st_size
        self.input_sha = sha256_file(self.dir / "input.tar.gz")
        self.log_path = self.dir / "log"
        self.log_path.write_bytes(b"")
        self.log_bytes = 0
        self.log_capped = False
        self.out_tmp = None
        self.lock = threading.Lock()

    def log(self, data, cap):
        if isinstance(data, str):
            data = data.encode()
        with self.lock:
            if self.log_capped:
                return
            if self.log_bytes + len(data) > cap:
                data = data[: max(0, cap - self.log_bytes)] + b"\n[bench] log limit reached; further output dropped\n"
                self.log_capped = True
            with open(self.log_path, "ab") as handle:
                handle.write(data)
            self.log_bytes += len(data)
        notify()

    def note(self, message):
        self.log(f"[bench] {message}\n", 1 << 40)

    def describe(self, offset=0):
        with open(self.log_path, "rb") as handle:
            handle.seek(offset)
            chunk = handle.read(1_000_000)
        return {
            "id": self.id,
            "state": self.state,
            "where": self.bench,
            "paused": self.paused,
            "exit_code": self.exit_code,
            "error": self.error,
            "output_ready": self.output_ready,
            "output_size": self.output_size,
            "log": chunk.decode("utf8", "replace"),
            "next": offset + len(chunk),
            "created": iso(self.created),
            "spec": {k: self.spec[k] for k in ("image", "cmd", "gpu", "display", "timeout_s", "outputs")},
        }

    def summary(self):
        return {"id": self.id, "state": self.state, "where": self.bench, "exit_code": self.exit_code,
                "cmd": " ".join(self.spec["cmd"])[:120], "gpu": self.spec["gpu"], "created": iso(self.created),
                "attempts": len(self.attempts), "error": self.error}

    def finish(self, state, exit_code=None, error=None):
        with self.lock:
            if self.state in ("done", "failed", "cancelled"):
                return False
            self.state, self.exit_code, self.error, self.finished = state, exit_code, error, now()
        if self.attempts and not self.attempts[-1].get("ended"):
            self.attempts[-1].update(ended=iso(), outcome=state)
        audit({"event": "job", "job": self.id, "state": state, "exit_code": exit_code, "error": error,
               "cmd": self.spec["cmd"], "image": self.spec["image"], "gpu": self.spec["gpu"],
               "display": self.spec["display"], "timeout_s": self.spec["timeout_s"], "outputs": self.spec["outputs"],
               "attempts": self.attempts, "input_bytes": self.input_size, "output_bytes": self.output_size,
               "duration_s": round(self.finished - self.created, 1), "client_cwd": self.spec.get("client_cwd")})
        notify()
        return True


def validate_spec(body, cfg):
    cmd = body.get("cmd")
    if not isinstance(cmd, list) or not cmd or not all(isinstance(a, str) for a in cmd):
        raise ApiError("cmd must be a non-empty list of strings.")
    if len(cmd) > MAX_CMD_ARGS or sum(len(a.encode()) for a in cmd) > MAX_CMD_BYTES or any("\0" in a for a in cmd):
        raise ApiError("cmd is too long or contains NUL bytes.")
    image = body.get("image") or cfg["default_image"]
    if not isinstance(image, str) or image not in cfg["images"]:
        raise ApiError(f"Image {image!r} is not allowed. Allowed: {', '.join(sorted(cfg['images']))}.")
    timeout = body.get("timeout_s", cfg["default_timeout_s"])
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= cfg["max_timeout_s"]:
        raise ApiError(f"timeout must be 1-{cfg['max_timeout_s']} seconds.")
    outputs = body.get("outputs") or []
    if not isinstance(outputs, list) or len(outputs) > MAX_OUTPUTS:
        raise ApiError(f"outputs must be a list of at most {MAX_OUTPUTS} relative paths.")
    for out in outputs:
        check_rel_path(out)
    workdir = body.get("workdir") or "."
    check_rel_path(workdir)
    client_cwd = body.get("client_cwd") if isinstance(body.get("client_cwd"), str) else None
    return {"cmd": cmd, "image": image, "image_ref": cfg["images"][image], "gpu": bool(body.get("gpu")),
            "display": bool(body.get("display")), "timeout_s": timeout, "outputs": outputs,
            "workdir": workdir, "client_cwd": (client_cwd or "")[:512]}


def check_rel_path(path):
    if not isinstance(path, str) or not path or len(path) > 512 or "\0" in path or "\\" in path:
        raise ApiError(f"Invalid relative path: {path!r}")
    if path.startswith("/") or any(part == ".." for part in path.split("/")):
        raise ApiError(f"Paths must be relative to the job folder and stay inside it: {path!r}")


def free_disk_mb(path):
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize // (1024 * 1024)


def submit_job(body, cfg):
    upload = body.get("upload")
    if not isinstance(upload, str) or not re.fullmatch(r"[0-9a-f]{16}", upload):
        raise ApiError("upload is missing; send the packed folder to /v1/uploads first.")
    path = JOBS_DIR / "uploads" / f"{upload}.tar.gz"
    if not path.exists():
        raise ApiError("Unknown upload (it may have expired).", 404)
    spec = validate_spec(body, cfg)
    active = [j for j in jobs_snapshot() if j.state in ("queued", "assigned", "running")]
    if len(active) >= cfg["max_queued_jobs"]:
        raise ApiError(f"Too many jobs in flight ({len(active)}); wait for some to finish.", 429)
    job = Job(spec, path)
    with jobs_lock:
        jobs[job.id] = job
    write_json(job.dir / "spec.json", spec)
    flags = " ".join(f for f, on in (("gpu", spec["gpu"]), ("display", spec["display"])) if on)
    job.note(f"job {job.id} queued: image {spec['image']}{', ' + flags if flags else ''}, timeout {spec['timeout_s']}s")
    notify()
    return job


def get_job(job_id):
    with jobs_lock:
        job = jobs.get(job_id) if JOB_RE.match(job_id or "") else None
    if not job:
        raise ApiError("Unknown job (it may be older than the retention or the broker restarted).", 404)
    return job


def cancel_job(job_id):
    job = get_job(job_id)
    job.cancel_requested = True
    if job.state == "queued":
        job.finish("cancelled", error="cancelled")
    elif job.bench == "server":
        subprocess.run(["docker", "kill", f"obbench-{job.id}"], capture_output=True, timeout=30)
    elif job.state in ("assigned", "running"):
        job.note("cancelled; the bench stops it")
        job.finish("cancelled", error="cancelled")
    return {"id": job.id, "state": job.state}


# ---- scheduling --------------------------------------------------------------------------------

outbox = {}  # bench name -> [job ids to hand out on its next poll]
outbox_lock = threading.Lock()
server_running = set()


def pick_bench(job, cfg, benches):
    """Highest-priority bench that is online, not paused, not user-busy, has the image (and a GPU
    for --gpu) and a free slot. None means: run on the server."""
    candidates = []
    for bench in benches:
        view = bench_view(bench, cfg)
        if bench["name"] in job.exclude or not view["online"] or view["paused"] or view["user_busy"]:
            continue
        if job.spec["image"] not in view["images"]:
            continue
        if job.spec["gpu"] and not view["gpu"]:
            continue
        if view["running"] >= view["capacity"]:
            continue
        candidates.append((-view["priority"], bench["name"]))
    return sorted(candidates)[0][1] if candidates else None


def assign(job, target):
    job.bench = target
    job.assigned_at = now()
    job.fetched = False
    job.paused = False
    job.attempts.append({"target": target, "started": iso()})
    if target == "server":
        job.state = "running"
        job.note("no bench available; running on the main server" + (" without a GPU" if job.spec["gpu"] else ""))
        server_running.add(job.id)
        threading.Thread(target=run_on_server, args=(job,), daemon=True).start()
    else:
        job.state = "assigned"
        job.note(f"assigned to bench {target}")
        with outbox_lock:
            outbox.setdefault(target, []).append(job.id)
    notify()


def requeue(job, reason, cfg, count_drop=True):
    if count_drop:
        job.drops += 1
    if job.attempts and not job.attempts[-1].get("ended"):
        job.attempts[-1].update(ended=iso(), outcome=reason)
    if job.bench and job.bench != "server":
        job.exclude.add(job.bench)
    if (count_drop and job.drops > 1) or len(job.attempts) >= 3:
        job.note(f"{reason}; no more retries")
        job.finish("failed", error=reason)
        return
    job.note(f"{reason}; running it again on the next option")
    job.state, job.bench, job.paused = "queued", None, False
    with job.lock:
        job.output_ready = False
        job.output_size = 0
        if job.out_tmp:
            Path(job.out_tmp).unlink(missing_ok=True)
            job.out_tmp = None
    notify()


def dispatch_once(cfg):
    benches = list_benches()
    names = {b["name"] for b in benches}
    t = now()
    for job in sorted(jobs_snapshot(), key=lambda j: j.created):
        if job.state in ("assigned", "running") and job.bench and job.bench != "server":
            if job.bench not in names:
                requeue(job, f"bench {job.bench} was revoked", cfg, count_drop=False)
            elif not bench_online(job.bench, cfg):
                requeue(job, f"bench {job.bench} went offline", cfg)
            elif job.state == "assigned" and t - job.assigned_at > 90 and not job.fetched:
                requeue(job, f"bench {job.bench} did not pick the job up", cfg)
            elif t - job.assigned_at > job.spec["timeout_s"] + 1800:
                job.note("the bench did not report a result in time")
                job.finish("failed", error="no result from the bench")
    for job in sorted(jobs_snapshot(), key=lambda j: j.created):
        if job.state != "queued":
            continue
        target = pick_bench(job, cfg, benches)
        if target:
            assign(job, target)
        elif cfg["server_fallback"] and len(server_running) < cfg["server_slots"]:
            assign(job, "server")
        elif not cfg["server_fallback"] and not any(bench_online(b["name"], cfg) for b in benches) \
                and t - job.created > 600:
            job.finish("failed", error="no bench available and server fallback is off")


def cleanup_once(cfg):
    keep = cfg["job_keep_hours"] * 3600
    t = now()
    with jobs_lock:
        for job_id, job in list(jobs.items()):
            if job.finished and t - job.finished > keep:
                shutil.rmtree(job.dir, ignore_errors=True)
                del jobs[job_id]
    uploads = JOBS_DIR / "uploads"
    for path in uploads.glob("*") if uploads.exists() else []:
        if t - path.stat().st_mtime > 3600:
            path.unlink(missing_ok=True)
    for path in JOBS_DIR.glob("*"):
        if path.name != "uploads" and path.name not in jobs and t - path.stat().st_mtime > keep:
            shutil.rmtree(path, ignore_errors=True)


def scheduler_loop():
    last_cleanup = 0
    while True:
        try:
            cfg = load_config()
            dispatch_once(cfg)
            if now() - last_cleanup > 600:
                cleanup_once(cfg)
                last_cleanup = now()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        with wake:
            wake.wait(1.0)


# ---- server fallback ---------------------------------------------------------------------------


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def ensure_network():
    if run(["docker", "network", "inspect", NETWORK]).returncode != 0:
        r = run(["docker", "network", "create", "--driver", "bridge", "--subnet", SUBNET,
                 "-o", f"com.docker.network.bridge.name={BRIDGE}",
                 "-o", "com.docker.network.bridge.enable_icc=false",
                 "--label", "openbot.bench=1", NETWORK])
        if r.returncode != 0:
            raise ApiError(f"cannot create the bench network: {r.stderr.strip()[-300:]}", 500)


def firewall_rules():
    """(chain, rule) pairs: the bench network reaches the internet, not this host or private ranges."""
    rules = [("INPUT", ["-i", BRIDGE, "-j", "DROP"])]
    rules += [("DOCKER-USER", ["-i", BRIDGE, "-d", net, "-j", "DROP"]) for net in BLOCKED_RANGES]
    return rules


def ensure_firewall():
    ensure_network()
    for chain, rule in firewall_rules():
        if run(["iptables", "-C", chain, *rule]).returncode != 0:
            r = run(["iptables", "-I", chain, "1", *rule])
            if r.returncode != 0:
                raise ApiError(f"cannot apply the bench firewall: {r.stderr.strip()[-300:]}", 500)


def docker_run_args(job_id, spec, workdir, limits, gpu, where):
    """The one fixed shape of a job container. Mirrors runner.py docker_run_args."""
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


def safe_extract(archive, dest):
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(dest, filter="data")


def pack_outputs(work, patterns, dest, cap, note):
    """Tar the declared outputs (globs relative to the job folder). Skips links that leave it."""
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
            raise ApiError(f"outputs are larger than the {cap // (1024 * 1024)} MB cap")
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        return info

    with tarfile.open(dest, "w:gz", compresslevel=1) as tar:
        for match in dict.fromkeys(found):
            tar.add(work / match, arcname=os.path.normpath(match), recursive=True, filter=keep)
    return total[0]


def run_on_server(job):
    cfg = load_config()
    work = job.dir / "work"
    cname = f"obbench-{job.id}"
    try:
        ensure_firewall()
        if run(["docker", "image", "inspect", job.spec["image_ref"]]).returncode != 0:
            raise ApiError(f"image {job.spec['image_ref']} is not built on the server "
                           "(sudo python3 /opt/openbot/bench/benchd.py build-images)")
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir()
        safe_extract(job.dir / "input.tar.gz", work)
        subprocess.run(["chown", "-hR", f"{JOB_UID}:{JOB_UID}", str(work)], check=True)
        os.chmod(work, 0o755)
        if job.cancel_requested:
            job.finish("cancelled", error="cancelled")
            return
        args = docker_run_args(job.id, job.spec, work, cfg["server_limits"], False, "server")
        cap = cfg["max_log_mb"] * 1024 * 1024
        proc = subprocess.Popen(["nice", "-n", "10", "docker", *args], stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT)
        deadline = now() + job.spec["timeout_s"]
        timed_out = [False]

        def watchdog():
            while proc.poll() is None:
                if now() > deadline and not timed_out[0]:
                    timed_out[0] = True
                    job.note(f"timeout after {job.spec['timeout_s']}s; stopping")
                    run(["docker", "kill", cname], timeout=30)
                time.sleep(1)

        threading.Thread(target=watchdog, daemon=True).start()
        while True:
            chunk = proc.stdout.read1(65536)
            if not chunk:
                break
            job.log(chunk, cap)
        code = proc.wait()
        if job.cancel_requested:
            job.finish("cancelled", error="cancelled")
            return
        if job.spec["outputs"]:
            tmp = job.dir / "output.tar.gz"
            job.output_size = pack_outputs(work, job.spec["outputs"], tmp, cfg["max_output_mb"] * 1024 * 1024,
                                           job.note)
            job.output_ready = True
        if timed_out[0]:
            job.finish("failed", exit_code=124, error="timeout")
        else:
            job.note(f"finished on the server with exit code {code}")
            job.finish("done", exit_code=code)
    except ApiError as err:
        job.note(f"failed: {err}")
        job.finish("failed", error=str(err))
    except Exception as err:  # noqa: BLE001
        traceback.print_exc()
        job.note(f"internal error: {err}")
        job.finish("failed", error=f"internal error: {err}")
    finally:
        run(["docker", "rm", "-f", cname], timeout=60)
        shutil.rmtree(work, ignore_errors=True)
        server_running.discard(job.id)
        notify()


# ---- agent API (unix socket) -------------------------------------------------------------------


def status_view(cfg):
    recent = sorted(jobs_snapshot(), key=lambda j: j.created)[-20:]
    return {
        "benches": [bench_view(b, cfg) for b in sorted(list_benches(), key=lambda b: -b.get("priority", 0))],
        "server_fallback": {"enabled": cfg["server_fallback"], "slots": cfg["server_slots"],
                            "running": len(server_running), "gpu": False},
        "jobs": [j.summary() for j in reversed(recent)],
        "limits": {"images": sorted(cfg["images"]), "default_image": cfg["default_image"],
                   "default_timeout_s": cfg["default_timeout_s"], "max_timeout_s": cfg["max_timeout_s"],
                   "max_upload_mb": cfg["max_upload_mb"], "max_output_mb": cfg["max_output_mb"]},
    }


def read_body_to_file(rfile, length, dest, cap):
    if length > cap:
        raise ApiError(f"Body too large ({length // (1024 * 1024)} MB > {cap // (1024 * 1024)} MB).", 413)
    digest = hashlib.sha256()
    remaining = length
    with open(dest, "wb") as handle:
        while remaining:
            block = rfile.read(min(1 << 20, remaining))
            if not block:
                raise ApiError("Upload was cut off.", 400)
            digest.update(block)
            handle.write(block)
            remaining -= len(block)
    return digest.hexdigest()


class BaseHandler(BaseHTTPRequestHandler):
    server_version = "openbot-bench/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # request lines only, never bodies
        pass

    def reply(self, status, value, headers=None):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for key, val in (headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        self.wfile.write(data)
        return data

    def send_file(self, path, content_type="application/gzip"):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as handle:
            shutil.copyfileobj(handle, self.wfile, 1 << 20)

    def length(self):
        try:
            return int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError("Bad Content-Length.") from None

    def json_body(self, raw):
        if not raw:
            return {}
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            raise ApiError("Request body is not valid JSON.") from None
        if not isinstance(value, dict):
            raise ApiError("Request body must be a JSON object.")
        return value

    def guarded(self, fn):
        try:
            fn()
        except ApiError as err:
            self.close_connection = True
            self.reply(err.status, {"error": str(err), "server_time": int(now())})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            self.close_connection = True
            self.reply(500, {"error": f"internal error: {err}"})


class AgentHandler(BaseHandler):
    def handle_any(self):
        self.guarded(self.route)

    do_GET = do_POST = handle_any

    def route(self):
        cfg = load_config()
        parts = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(parts.query))
        segs = parts.path.strip("/").split("/")
        method = self.command
        if segs[:1] != ["v1"]:
            raise ApiError("Not found.", 404)
        segs = segs[1:]
        if segs == ["health"]:
            return self.reply(200, {"ok": True})
        if segs == ["status"] and method == "GET":
            return self.reply(200, status_view(cfg))
        if segs == ["uploads"] and method == "POST":
            if free_disk_mb(BASE) < cfg["min_free_disk_mb"]:
                raise ApiError("The server is low on disk space; try again later.", 507)
            (JOBS_DIR / "uploads").mkdir(parents=True, exist_ok=True)
            upload = secrets.token_hex(8)
            dest = JOBS_DIR / "uploads" / f"{upload}.tar.gz"
            try:
                read_body_to_file(self.rfile, self.length(), dest, cfg["max_upload_mb"] * 1024 * 1024)
            except ApiError:
                dest.unlink(missing_ok=True)
                raise
            return self.reply(200, {"upload": upload})
        if segs == ["jobs"] and method == "POST":
            body = self.json_body(self.rfile.read(min(self.length(), 1_000_000)))
            job = submit_job(body, cfg)
            return self.reply(200, {"job": job.id})
        if len(segs) >= 2 and segs[0] == "jobs":
            job = get_job(segs[1])
            rest = segs[2:]
            if not rest and method == "GET":
                offset = max(0, int(query.get("offset", 0)))
                wait = min(max(0.0, float(query.get("wait", 0))), 25.0)
                deadline = now() + wait
                with wake:
                    while (now() < deadline and job.state in ("queued", "assigned", "running")
                           and job.log_path.stat().st_size <= offset):
                        wake.wait(deadline - now())
                return self.reply(200, job.describe(offset))
            if rest == ["output"] and method == "GET":
                path = job.dir / "output.tar.gz"
                if not job.output_ready or not path.exists():
                    raise ApiError("This job has no outputs (yet).", 404)
                return self.send_file(path)
            if rest == ["cancel"] and method == "POST":
                return self.reply(200, cancel_job(job.id))
        raise ApiError("Not found.", 404)


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        request, _ = super().get_request()
        return request, ("benchctl", 0)


# ---- runner API (HTTPS via nginx, loopback listener) -------------------------------------------


def job_spec_for_runner(job, cfg):
    s = job.spec
    return {"id": job.id, "image": s["image"], "image_ref": s["image_ref"], "cmd": s["cmd"], "gpu": s["gpu"],
            "display": s["display"], "timeout_s": s["timeout_s"], "outputs": s["outputs"], "workdir": s["workdir"],
            "input_sha256": job.input_sha, "input_size": job.input_size,
            "max_output_bytes": cfg["max_output_mb"] * 1024 * 1024, "max_log_bytes": cfg["max_log_mb"] * 1024 * 1024}


def dist_manifest(cfg):
    files = {}
    for path in sorted(DIST.rglob("*")) if DIST.exists() else []:
        rel = path.relative_to(DIST).as_posix()
        if path.is_file() and DIST_FILES.match(rel):
            files[rel] = sha256_file(path)
    return {"files": files, "images": cfg["images"], "public_url": cfg["public_url"]}


class RunnerHandler(BaseHandler):
    def handle_any(self):
        self.guarded(self.route)

    do_GET = do_POST = handle_any

    def route(self):
        cfg = load_config()
        parts = urllib.parse.urlsplit(self.path)
        segs = parts.path.strip("/").split("/")
        method = self.command
        if segs == ["v1", "health"]:
            return self.reply(200, {"ok": True, "server_time": int(now())})
        if segs == ["v1", "dist", "manifest.json"] and method == "GET":
            return self.reply(200, dist_manifest(cfg))
        if segs[:2] == ["v1", "dist"] and method == "GET":
            rel = "/".join(segs[2:])
            if not DIST_FILES.match(rel) or not (DIST / rel).is_file():
                raise ApiError("Not found.", 404)
            return self.send_file(DIST / rel, "text/plain; charset=utf-8")
        if segs == ["v1", "runner", "enroll"] and method == "POST":
            body = self.json_body(self.rfile.read(min(self.length(), 4096)))
            return self.reply(200, redeem_enrollment(body.get("code")))
        if segs[:2] != ["v1", "runner"]:
            raise ApiError("Not found.", 404)
        rest = segs[2:]
        length = self.length()
        # Small bodies are read into memory; output chunks are streamed to disk and hashed.
        is_chunk = len(rest) == 3 and rest[0] == "jobs" and rest[2] == "output"
        if is_chunk:
            if length > CHUNK_MAX:
                raise ApiError("Chunk too large.", 413)
            tmp = JOBS_DIR / "uploads" / f"chunk-{secrets.token_hex(8)}"
            tmp.parent.mkdir(parents=True, exist_ok=True)
            try:
                body_hash = read_body_to_file(self.rfile, length, tmp, CHUNK_MAX)
                name, secret, nonce = verify_request(self.headers, method, self.path, body_hash)
                return self.reply(200, self.output_chunk(name, rest[1], tmp, parts.query, cfg))
            finally:
                tmp.unlink(missing_ok=True)
        if length > 2_000_000:
            raise ApiError("Body too large.", 413)
        raw = self.rfile.read(length) if length else b""
        name, secret, nonce = verify_request(self.headers, method, self.path, hashlib.sha256(raw).hexdigest())
        if rest == ["poll"] and method == "POST":
            data = self.poll(name, self.json_body(raw), cfg)
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Bench-Resp-Sig", response_sig(secret, nonce, body))
            self.end_headers()
            self.wfile.write(body)
            return None
        if len(rest) == 3 and rest[0] == "jobs":
            job = get_job(rest[1])
            if job.bench != name or job.state not in ("assigned", "running"):
                raise ApiError("This job is not assigned to this bench any more.", 409)
            action = rest[2]
            if action == "input" and method == "GET":
                job.fetched = True
                if job.state == "assigned":
                    job.state = "running"
                    job.note(f"running on bench {name}")
                return self.send_file(job.dir / "input.tar.gz")
            if action == "log" and method == "POST":
                job.log(raw, cfg["max_log_mb"] * 1024 * 1024)
                return self.reply(200, {"ok": True})
            if action == "state" and method == "POST":
                body = self.json_body(raw)
                paused = bool(body.get("paused"))
                if paused != job.paused:
                    job.paused = paused
                    job.note(f"paused on {name}: {body.get('reason', 'the user needs the PC')}" if paused
                             else f"resumed on {name}")
                return self.reply(200, {"ok": True})
            if action == "result" and method == "POST":
                return self.reply(200, self.result(job, name, self.json_body(raw), cfg))
        raise ApiError("Not found.", 404)

    def poll(self, name, body, cfg):
        status = body.get("status") if isinstance(body.get("status"), dict) else {}
        clean = {
            "user_busy": bool(status.get("user_busy")),
            "paused_until": float(status.get("paused_until") or 0),
            "gpu": str(status.get("gpu"))[:80] if status.get("gpu") else None,
            "images": [str(i)[:128] for i in (status.get("images") or [])][:50],
            "capacity": min(max(int(status.get("capacity") or 1), 0), 8),
            "version": str(status.get("version") or "")[:32],
        }
        ip = self.headers.get("X-Real-IP", "")
        with live_lock:
            entry = live.setdefault(name, {"last_seen": 0, "polling": 0, "status": {}, "ip": ""})
            entry.update(last_seen=now(), status=clean, ip=ip)
            entry["polling"] += 1
        notify()
        try:
            hold = POLL_HOLD_S if not body.get("no_wait") else 0
            deadline = now() + hold
            with wake:
                while not outbox.get(name) and now() < deadline:
                    wake.wait(max(0.0, deadline - now()))
            with outbox_lock:
                ids = outbox.pop(name, [])
        finally:
            with live_lock:
                entry["polling"] -= 1
                entry["last_seen"] = now()
        handed = []
        for job_id in ids:
            with jobs_lock:
                job = jobs.get(job_id)
            if job and job.bench == name and job.state == "assigned":
                job.assigned_at = now()
                handed.append(job_spec_for_runner(job, cfg))
        active = [j.id for j in jobs_snapshot() if j.bench == name and j.state in ("assigned", "running")]
        return {"jobs": handed, "active": active, "server_time": int(now())}

    def output_chunk(self, name, job_id, tmp, query, cfg):
        job = get_job(job_id)
        if job.bench != name or job.state not in ("assigned", "running"):
            raise ApiError("This job is not assigned to this bench any more.", 409)
        offset = int(dict(urllib.parse.parse_qsl(query)).get("offset", "-1"))
        with job.lock:
            if job.out_tmp is None:
                job.out_tmp = str(job.dir / f"output.part-{secrets.token_hex(4)}")
                Path(job.out_tmp).write_bytes(b"")
            current = os.path.getsize(job.out_tmp)
            if offset != current:
                raise ApiError(f"Expected offset {current}.", 409)
            if current + os.path.getsize(tmp) > cfg["max_output_mb"] * 1024 * 1024 + (1 << 20):
                raise ApiError("Outputs exceed the cap.", 413)
            with open(job.out_tmp, "ab") as out, open(tmp, "rb") as src:
                shutil.copyfileobj(src, out, 1 << 20)
            return {"ok": True, "next": os.path.getsize(job.out_tmp)}

    def result(self, job, name, body, cfg):
        if body.get("handback"):
            requeue(job, f"bench {name} handed the job back ({body.get('reason', 'paused too long')})", cfg,
                    count_drop=False)
            return {"ok": True}
        if body.get("error") and body.get("exit_code") is None:
            job.note(f"bench {name}: {str(body['error'])[:500]}")
            if body.get("retry"):
                requeue(job, f"bench {name} could not run the job", cfg)
            else:
                job.finish("failed", error=str(body["error"])[:500])
            return {"ok": True}
        with job.lock:
            out_tmp, job.out_tmp = job.out_tmp, None
        final = job.dir / "output.tar.gz"
        if out_tmp:
            if sha256_file(out_tmp) != body.get("output_sha256"):
                Path(out_tmp).unlink(missing_ok=True)
                requeue(job, "outputs from the bench were corrupted", cfg)
                return {"ok": False}
            os.replace(out_tmp, final)
            job.output_size = int(body.get("output_bytes") or 0)
            job.output_ready = True
        if body.get("warning"):
            job.note(str(body["warning"])[:500])
        code = body.get("exit_code")
        code = int(code) if isinstance(code, int) else None
        if body.get("timed_out"):
            job.finish("failed", exit_code=124, error="timeout")
        else:
            job.note(f"finished on bench {name} with exit code {code}")
            job.finish("done", exit_code=code)
        return {"ok": True}


class RunnerServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64


# ---- serve -------------------------------------------------------------------------------------


def serve():
    cfg = load_config()
    for path in (STATE / "benches", STATE / "enroll", JOBS_DIR / "uploads"):
        path.mkdir(parents=True, exist_ok=True)
    KEYS.mkdir(parents=True, exist_ok=True)
    os.chmod(KEYS, 0o700)
    for path in (STATE, JOBS_DIR):
        os.chmod(path, 0o700)
    # Jobs from before a restart cannot be resumed: their clients get an error and the runner drops them.
    for stale in JOBS_DIR.iterdir():
        if stale.name != "uploads" and stale.is_dir():
            shutil.rmtree(stale, ignore_errors=True)
    subprocess.run("docker ps -aq --filter label=openbot.bench=1 | xargs -r docker rm -f", shell=True,
                   capture_output=True)
    try:
        ensure_firewall()
    except ApiError as err:
        say(f"bench firewall not applied at start (server fallback will retry): {err}")
    CLIENT_DIR.mkdir(parents=True, exist_ok=True)
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    agent_server = UnixServer(str(SOCKET_PATH), AgentHandler)
    os.chown(SOCKET_PATH, OWNER_UID, OWNER_UID)
    os.chmod(SOCKET_PATH, 0o600)
    runner_server = RunnerServer(("127.0.0.1", int(cfg["listen_port"])), RunnerHandler)
    threading.Thread(target=runner_server.serve_forever, daemon=True).start()
    threading.Thread(target=scheduler_loop, daemon=True).start()
    say(f"openbot bench broker: agents on {SOCKET_PATH}, runners on 127.0.0.1:{cfg['listen_port']}")
    agent_server.serve_forever()


# ---- install and admin -------------------------------------------------------------------------

UNIT = """[Unit]
Description=OpenBot bench broker
After=docker.service network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/bin/python3 {script} serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""


def render_nginx(cfg):
    ranges = "\n".join(f"    {r} 1;" for r in CLOUDFLARE_RANGES)
    return f"""# Managed by the OpenBot bench broker (benchd.py install). Do not edit.
log_format openbot_bench_safe '$remote_addr "$request_method $uri" $status $body_bytes_sent $request_time';

# Runners are reachable only through Cloudflare and loopback.
geo $realip_remote_addr $openbot_bench_allowed {{
    default 0;
{ranges}
}}

server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {cfg["server_name"]};
    ssl_certificate {cfg["tls_cert"]};
    ssl_certificate_key {cfg["tls_key"]};
    access_log /var/log/nginx/openbot-bench-access.log openbot_bench_safe;
    client_max_body_size 80m;

    if ($openbot_bench_allowed = 0) {{ return 444; }}

    location /v1/ {{
        proxy_pass http://127.0.0.1:{int(cfg["listen_port"])};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 120s;
        proxy_send_timeout 600s;
    }}

    location / {{ return 404; }}
}}
"""


def apply_nginx(cfg):
    text = render_nginx(cfg)
    previous = NGINX_CONF.read_text() if NGINX_CONF.exists() else None
    if previous == text:
        return "unchanged"
    NGINX_CONF.write_text(text)
    test = run(["nginx", "-t"])
    if test.returncode != 0:
        if previous is None:
            NGINX_CONF.unlink()
        else:
            NGINX_CONF.write_text(previous)
        sys.exit(f"nginx rejected the bench vhost; restored the previous state:\n{test.stderr}")
    subprocess.run(["systemctl", "reload", "nginx"], check=True)
    return "reloaded"


def install():
    if os.geteuid() != 0:
        sys.exit("install must run as root")
    here = Path(__file__).resolve().parent
    runner_src = here.parent / "bench-runner"
    for path, mode in ((BASE, 0o755), (CLIENT_DIR, 0o755), (KEYS, 0o700), (STATE, 0o700), (JOBS_DIR, 0o700)):
        path.mkdir(parents=True, exist_ok=True)
        os.chmod(path, mode)
    shutil.copy2(here / "benchd.py", BASE / "benchd.py")
    os.chmod(BASE / "benchd.py", 0o755)
    shutil.copy2(here / "benchctl", CLIENT_DIR / "benchctl")
    os.chmod(CLIENT_DIR / "benchctl", 0o755)
    if runner_src.is_dir():
        shutil.rmtree(DIST, ignore_errors=True)
        shutil.copytree(runner_src, DIST, ignore=shutil.ignore_patterns("__pycache__", "test_*", "*.pyc"))
        subprocess.run(["chmod", "-R", "go+rX", str(DIST)], check=True)
    if not (BASE / "config.json").exists():
        write_json(BASE / "config.json", DEFAULT_CONFIG, 0o644)
    AUDIT.touch(mode=0o600, exist_ok=True)
    Path("/etc/systemd/system/openbot-bench.service").write_text(UNIT.format(script=BASE / "benchd.py"))
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "openbot-bench.service"], check=True)
    subprocess.run(["systemctl", "restart", "openbot-bench.service"], check=True)
    say(f"nginx vhost: {apply_nginx(load_config())}")
    say("installed; broker restarted")


def build_images():
    if os.geteuid() != 0:
        sys.exit("build-images must run as root")
    cfg = load_config()
    order = sorted(cfg["images"].items(), key=lambda kv: kv[0] != "bench-base")  # the base first
    for name, ref in order:
        folder = DIST / "images" / name
        if not (folder / "Dockerfile").exists():
            say(f"{name}: no Dockerfile in {folder}; skipped")
            continue
        say(f"building {name} as {ref} ...")
        subprocess.run(["nice", "-n", "10", "docker", "build", "-t", ref, str(folder)], check=True)


def agent_call(method, path):
    """Admin commands read the broker's live view over the agent socket (root may open it)."""
    import http.client

    class Conn(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(10)
            self.sock.connect(str(SOCKET_PATH))

    conn = Conn("broker")
    try:
        conn.request(method, path)
        return json.loads(conn.getresponse().read())
    except OSError:
        return None
    finally:
        conn.close()


def admin(args):
    cfg = load_config()
    cmd = args[0]
    if cmd == "enroll":
        if len(args) < 2:
            sys.exit("usage: benchd.py enroll <name> --priority N")
        priority = 0
        if "--priority" in args:
            priority = int(args[args.index("--priority") + 1])
        code = create_enrollment(args[1], priority, cfg)
        say(f"Enrollment code for {args[1]} (priority {priority}, single use, valid {cfg['enroll_ttl_s'] // 60} min):")
        say(f"  {code}")
        say(f"Server URL: {cfg['public_url']}")
        return
    if cmd == "list":
        live_view = agent_call("GET", "/v1/status")
        rows = live_view["benches"] if live_view else [dict(b, online="?") for b in list_benches()]
        if not rows:
            say("(no benches)")
        for row in rows:
            say(json.dumps(row, sort_keys=True))
        return
    if len(args) < 2:
        sys.exit(__doc__)
    name = args[1]
    check_name(name)
    bench = read_json(bench_path(name))
    if cmd == "revoke":
        existed = key_path(name).exists() or bench is not None
        key_path(name).unlink(missing_ok=True)
        bench_path(name).unlink(missing_ok=True)
        audit({"event": "revoked", "bench": name})
        say(f"revoked {name}" if existed else f"{name} was not enrolled")
        return
    if not bench:
        sys.exit(f"no bench named {name}")
    if cmd == "priority" and len(args) == 3:
        bench["priority"] = int(args[2])
    elif cmd in ("pause", "resume"):
        bench["paused"] = cmd == "pause"
    else:
        sys.exit(__doc__)
    write_json(bench_path(name), bench)
    audit({"event": cmd, "bench": name, "priority": bench["priority"], "paused": bench["paused"]})
    say(json.dumps(bench, sort_keys=True))


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    if args[0] == "serve":
        serve()
    elif args[0] == "install":
        install()
    elif args[0] == "build-images":
        build_images()
    elif args[0] == "config":
        print(json.dumps(load_config(), indent=2))
    elif args[0] == "status":
        print(json.dumps(agent_call("GET", "/v1/status"), indent=2))
    elif args[0] in ("enroll", "list", "revoke", "priority", "pause", "resume"):
        if os.geteuid() != 0 and not os.environ.get("BENCH_BASE"):
            sys.exit("admin commands must run as root (sudo)")
        try:
            admin(args)
        except ApiError as err:
            sys.exit(str(err))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
