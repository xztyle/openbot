#!/usr/bin/env python3
"""OpenBot apps broker.

A host-side service that lets OpenBot agents (inside the `openbot` container) deploy, observe and
operate small apps and their databases on this machine, without ever holding the Docker socket.

Agents reach it through a unix socket mounted into the container and the `appctl` client next to it.
Every request is translated into fixed, hardened container settings: the caller can pick a name, a
source folder under the OpenBot workspace tree, a port and (bounded) resource sizes, nothing else.

Subcommands: serve | install | env-set | config | status
Python standard library only.
"""

import json
import os
import re
import secrets
import shlex
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler
from pathlib import Path

BASE = Path(os.environ.get("APPS_BASE", "/opt/openbot/apps"))
DATA_ROOT = Path(os.environ.get("APPS_DATA_ROOT", "/opt/openbot/data/OpenBot"))
CONTAINER_ROOT = "/data/OpenBot"
BACKUPS = Path(os.environ.get("APPS_BACKUPS", "/opt/openbot/backups/apps"))
NGINX_CONF = Path(os.environ.get("APPS_NGINX_CONF", "/etc/nginx/conf.d/openbot-apps.conf"))
CLIENT_DIR = BASE / "client"
SOCKET_PATH = CLIENT_DIR / "appctl.sock"
STATE = BASE / "state"
LOGS = BASE / "logs"
APP_UID = 10001
OWNER_UID = int(os.environ.get("APPS_SOCKET_UID", "1000"))

DEFAULT_CONFIG = {
    "domain": "apps.delynith.com",
    "max_apps": 20,
    "max_total_memory_mb": 30720,
    "default_memory_mb": 1024,
    "default_cpus": 1.0,
    "max_memory_mb": 4096,
    "max_cpus": 4.0,
    "port_range": [20000, 20999],
    "tls_cert": "",
    "tls_key": "",
    "min_free_build_mb": 8000,
    "build_timeout_s": 1200,
    "db_backup_keep": 7,
    "deleted_keep_days": 30,
}

CLOUDFLARE_RANGES = """173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15
104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32
2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32 127.0.0.1/32 ::1/128""".split()

NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,28}[a-z0-9]$")
ENV_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
USER_ONLY_ENV_RE = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION", re.I)
RESERVED_ENV = {"PORT", "DATABASE_URL", "REDIS_URL", "PATH", "HOME", "HOSTNAME"}
RESERVED_NAMES = {"www", "api", "admin", "mail", "signal", "turn", "bots", "app", "apps", "dashboard", "root"}
ENGINES = {
    "postgres": {"image": "postgres:17-alpine", "port": 5432, "data": "/var/lib/postgresql/data", "memory_mb": 1024},
    "mariadb": {"image": "mariadb:11", "port": 3306, "data": "/var/lib/mysql", "memory_mb": 1024},
    "redis": {"image": "redis:7-alpine", "port": 6379, "data": "/data", "memory_mb": 512},
}
DB_CAPS = ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]
MAX_LOG_BYTES = 200_000
MAX_QUERY_BYTES = 1_000_000


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now():
    return int(time.time())


def iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts if ts is not None else time.time()))


def say(msg):
    print(msg, flush=True)


# ---- configuration and state ------------------------------------------------------------------


def load_config():
    path = BASE / "config.json"
    cfg = dict(DEFAULT_CONFIG)
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
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def app_path(name):
    return STATE / "apps" / f"{name}.json"


def db_path(name):
    return STATE / "dbs" / f"{name}.json"


def env_path(name):
    return STATE / "env" / f"{name}.json"


def list_state(kind):
    folder = STATE / kind
    return sorted(p.stem for p in folder.glob("*.json")) if folder.exists() else []


_locks = {}
_locks_guard = threading.Lock()
build_lock = threading.Lock()
nginx_lock = threading.Lock()


def lock_for(key):
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


class Held:
    """Non-blocking per-object lock: a second mutation while one runs is a 409, not a queue."""

    def __init__(self, key):
        self.lock = lock_for(key)
        self.key = key

    def __enter__(self):
        if not self.lock.acquire(blocking=False):
            raise ApiError(f"{self.key} is busy with another operation; try again shortly.", 409)

    def __exit__(self, *exc):
        self.lock.release()


def check_name(name, kind="app"):
    if not NAME_RE.match(name or ""):
        raise ApiError(f"Invalid {kind} name. Use 3-30 lowercase letters, digits and hyphens, starting with a letter.")
    if name in RESERVED_NAMES:
        raise ApiError(f"The name {name} is reserved.")


def event(state, message):
    events = state.setdefault("events", [])
    events.append({"at": iso(), "message": message})
    del events[:-50]


# ---- docker -----------------------------------------------------------------------------------


def docker(*args, check=True, timeout=180, input=None, text=True):
    result = subprocess.run(
        ["docker", *args], capture_output=True, text=text, timeout=timeout, input=input
    )
    if check and result.returncode != 0:
        err = result.stderr if text else result.stderr.decode("utf8", "replace")
        raise ApiError(f"docker {args[0]} failed: {err.strip()[-800:]}", 500)
    return result


def container_info(cname):
    result = docker("inspect", cname, check=False)
    if result.returncode != 0:
        return None
    return json.loads(result.stdout)[0]


def ensure_network(name, internal=False):
    if docker("network", "inspect", name, check=False).returncode == 0:
        return
    args = ["network", "create", "--driver", "bridge", "--label", "openbot.apps=1"]
    if internal:
        args.append("--internal")
    docker(*args, name)


def free_memory_mb():
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    return 0


def dir_size_mb(path):
    if not path.exists():
        return 0
    result = subprocess.run(["du", "-sm", str(path)], capture_output=True, text=True)
    try:
        return int(result.stdout.split()[0])
    except (IndexError, ValueError):
        return 0


# ---- nginx ------------------------------------------------------------------------------------


def render_nginx(cfg):
    mapping = []
    for name in list_state("apps"):
        app = read_json(app_path(name))
        if app and app.get("host_port"):
            mapping.append(f'    "{name}.{cfg["domain"]}" {app["host_port"]};')
    ranges = "\n".join(f"    {r} 1;" for r in CLOUDFLARE_RANGES)
    tls = ""
    if cfg.get("tls_cert") and cfg.get("tls_key"):
        tls = (
            "    listen 443 ssl;\n    listen [::]:443 ssl;\n"
            f"    ssl_certificate {cfg['tls_cert']};\n    ssl_certificate_key {cfg['tls_key']};\n"
        )
    return f"""# Managed by the OpenBot apps broker. Do not edit: it is rewritten on every change.
log_format openbot_apps_safe '$remote_addr $host "$request_method $uri" $status $body_bytes_sent';

map $host $openbot_app_port {{
    default 0;
{chr(10).join(mapping)}
}}

map $http_upgrade $openbot_apps_connection {{
    default upgrade;
    '' close;
}}

# Apps are reachable only through Cloudflare (so a Cloudflare Access policy cannot be bypassed) and loopback.
geo $realip_remote_addr $openbot_apps_allowed {{
    default 0;
{ranges}
}}

server {{
    listen 80;
    listen [::]:80;
{tls}    server_name *.{cfg["domain"]};
    access_log /var/log/nginx/openbot-apps-access.log openbot_apps_safe;
    client_max_body_size 50m;

    if ($openbot_apps_allowed = 0) {{ return 444; }}

    location / {{
        if ($openbot_app_port = 0) {{ return 404; }}
        proxy_pass http://127.0.0.1:$openbot_app_port;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $openbot_apps_connection;
        proxy_read_timeout 300s;
    }}
}}
"""


def apply_nginx():
    cfg = load_config()
    with nginx_lock:
        text = render_nginx(cfg)
        previous = NGINX_CONF.read_text() if NGINX_CONF.exists() else None
        if previous == text:
            return
        NGINX_CONF.write_text(text)
        test = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
        if test.returncode != 0:
            if previous is None:
                NGINX_CONF.unlink()
            else:
                NGINX_CONF.write_text(previous)
            raise ApiError(f"nginx rejected the generated config: {test.stderr.strip()[-400:]}", 500)
        subprocess.run(["systemctl", "reload", "nginx"], check=False)


# ---- source and build -------------------------------------------------------------------------


def resolve_source(name, src):
    container_path = src or f"{CONTAINER_ROOT}/Shared/apps/{name}"
    if container_path != CONTAINER_ROOT and not container_path.startswith(CONTAINER_ROOT + "/"):
        raise ApiError(f"The source must be a folder under {CONTAINER_ROOT}/ (got {container_path}).")
    host = DATA_ROOT / container_path[len(CONTAINER_ROOT) :].lstrip("/")
    try:
        real = host.resolve(strict=True)
    except FileNotFoundError:
        raise ApiError(f"Source folder not found: {container_path}") from None
    root = DATA_ROOT.resolve()
    if real != root and root not in real.parents:
        raise ApiError("The source folder resolves outside the OpenBot workspace tree.")
    if not real.is_dir():
        raise ApiError("The source must be a folder.")
    if not (real / "Dockerfile").is_file():
        raise ApiError("The source folder has no Dockerfile at its top level.")
    return real


def snapshot_source(real, name):
    target = BASE / "build" / name
    shutil.rmtree(target, ignore_errors=True)
    total = 0
    for dirpath, _dirs, files in os.walk(real, followlinks=False):
        for f in files:
            try:
                total += os.lstat(os.path.join(dirpath, f)).st_size
            except OSError:
                pass
        if total > 500 * 1024 * 1024:
            raise ApiError("The source folder is larger than 500 MB; add a .dockerignore or trim it.")
    shutil.copytree(real, target, symlinks=True, ignore=shutil.ignore_patterns(".git"))
    return target


def manifest_from(context):
    path = context / "app.json"
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text())
    except json.JSONDecodeError as err:
        raise ApiError(f"app.json is not valid JSON: {err}") from None
    return value if isinstance(value, dict) else {}


def pick(opts, manifest, key, default):
    return opts.get(key) if opts.get(key) is not None else manifest.get(key, default)


# ---- jobs -------------------------------------------------------------------------------------

jobs = {}
jobs_guard = threading.Lock()


class Job:
    def __init__(self, kind, name):
        self.id = secrets.token_hex(4)
        self.kind, self.name = kind, name
        self.status = "running"
        self.error = None
        self.started = now()
        self.finished = None
        LOGS.mkdir(parents=True, exist_ok=True)
        (LOGS / "jobs").mkdir(exist_ok=True)
        self.path = LOGS / "jobs" / f"{self.id}.log"
        self.path.write_text("")
        with jobs_guard:
            jobs[self.id] = self
            for old in sorted(jobs.values(), key=lambda j: j.started)[:-100]:
                jobs.pop(old.id, None)

    def log(self, message):
        with open(self.path, "a") as handle:
            handle.write(message.rstrip("\n") + "\n")

    def describe(self, offset=0):
        data = self.path.read_bytes()
        return {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "status": self.status,
            "error": self.error,
            "log": data[offset:].decode("utf8", "replace"),
            "next": len(data),
        }


def run_job(kind, name, fn):
    job = Job(kind, name)

    def target():
        try:
            fn(job)
            job.status = "ok"
        except ApiError as err:
            job.status, job.error = "failed", str(err)
            job.log(f"FAILED: {err}")
        except Exception as err:  # noqa: BLE001
            job.status, job.error = "failed", f"internal error: {err}"
            job.log(traceback.format_exc())
        finally:
            job.finished = now()

    threading.Thread(target=target, daemon=True).start()
    return job


# ---- apps -------------------------------------------------------------------------------------


def total_memory_mb(exclude=None):
    total = 0
    for name in list_state("apps"):
        if name != exclude:
            total += (read_json(app_path(name)) or {}).get("memory_mb", 0)
    for name in list_state("dbs"):
        total += (read_json(db_path(name)) or {}).get("memory_mb", 0)
    return total


def allocate_port(cfg):
    used = {(read_json(app_path(n)) or {}).get("host_port") for n in list_state("apps")}
    low, high = cfg["port_range"]
    for port in range(low, high + 1):
        if port in used:
            continue
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise ApiError("No free host port is left in the app range.", 500)


def db_urls(app):
    urls, first_sql = {}, None
    for db_name in app.get("dbs", []):
        db = read_json(db_path(db_name))
        if not db:
            continue
        pw = db["password"]
        host = f"db-{db_name}"
        if db["engine"] == "postgres":
            url = f"postgres://app:{pw}@{host}:5432/app"
        elif db["engine"] == "mariadb":
            url = f"mysql://app:{pw}@{host}:3306/app"
        else:
            url = f"redis://:{pw}@{host}:6379"
        urls[f"DB_{db_name.upper().replace('-', '_')}_URL"] = url
        if db["engine"] == "redis":
            urls.setdefault("REDIS_URL", url)
        elif first_sql is None:
            first_sql = url
    if first_sql:
        urls["DATABASE_URL"] = first_sql
    return urls


def write_runtime_env(app):
    values = {}
    values.update(read_json(env_path(app["name"]), {}))
    values.update(db_urls(app))
    values["PORT"] = str(app["port"])
    values["OPENBOT_APP_NAME"] = app["name"]
    path = STATE / "run" / f"{app['name']}.env"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")
    return path


def start_container(app, image):
    name = app["name"]
    cname = f"app-{name}"
    docker("rm", "-f", cname, check=False)
    ensure_network(f"appnet-{name}")
    data = BASE / "data" / name
    data.mkdir(parents=True, exist_ok=True)
    os.chown(data, APP_UID, APP_UID)
    mem = f"{app['memory_mb']}m"
    docker(
        "create", "--name", cname, "--init", "--restart", "unless-stopped",
        "--network", f"appnet-{name}",
        "-p", f"127.0.0.1:{app['host_port']}:{app['port']}",
        "--memory", mem, "--memory-swap", mem, "--cpus", str(app["cpus"]), "--pids-limit", "256",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--user", f"{APP_UID}:{APP_UID}",
        "-v", f"{data}:/data",
        "--env-file", str(write_runtime_env(app)),
        "--label", "openbot.apps=1", "--label", f"openbot.apps.name={name}",
        "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
        image,
    )
    for db_name in app.get("dbs", []):
        if container_info(f"db-{db_name}"):
            docker("network", "connect", f"dbnet-{db_name}", cname)
    docker("start", cname)


def probe_http(app):
    import http.client

    path = app.get("health") or "/"
    strict = bool(app.get("health"))
    try:
        conn = http.client.HTTPConnection("127.0.0.1", app["host_port"], timeout=3)
        conn.request("GET", path, headers={"Host": f"{app['name']}.local", "User-Agent": "openbot-apps-broker"})
        code = conn.getresponse().status
        conn.close()
    except (OSError, http.client.HTTPException):
        return None
    ok = 200 <= code < 400 if strict else code < 500
    return code if ok else -code


def wait_healthy(app, job, seconds=90):
    deadline = time.time() + seconds
    while time.time() < deadline:
        info = container_info(f"app-{app['name']}")
        if not info:
            return False, "the container is gone"
        if info["RestartCount"] >= 2:
            return False, "the container keeps crashing; read its logs"
        if info["State"]["Status"] in ("exited", "dead"):
            return False, f"the container exited (exit code {info['State'].get('ExitCode')})"
        code = probe_http(app)
        if code and code > 0:
            return True, f"answering HTTP {code}"
        time.sleep(2)
    return False, f"no healthy answer within {seconds}s"


def wait_for_memory(job, need_mb, timeout=600):
    deadline = time.time() + timeout
    while free_memory_mb() < need_mb:
        if time.time() > deadline:
            raise ApiError(f"Not enough free memory to build (need {need_mb} MB free).", 503)
        job.log(f"waiting for free memory ({free_memory_mb()} MB available, {need_mb} MB needed)")
        time.sleep(10)


def deploy(name, opts):
    cfg = load_config()
    check_name(name)
    real = resolve_source(name, opts.get("src"))
    existing = read_json(app_path(name))
    if not existing and len(list_state("apps")) >= cfg["max_apps"]:
        raise ApiError(f"The limit of {cfg['max_apps']} apps is reached.")

    def work(job):
        with Held(f"app:{name}"):
            context = snapshot_source(real, name)
            manifest = manifest_from(context)
            app = read_json(app_path(name)) or {"name": name, "dbs": [], "events": []}
            app["port"] = int(pick(opts, manifest, "port", app.get("port", 3000)))
            app["health"] = pick(opts, manifest, "health", app.get("health", "")) or ""
            app["memory_mb"] = int(pick(opts, manifest, "memory_mb", app.get("memory_mb", cfg["default_memory_mb"])))
            app["cpus"] = float(pick(opts, manifest, "cpus", app.get("cpus", cfg["default_cpus"])))
            if not 1 <= app["port"] <= 65535:
                raise ApiError("port must be 1-65535.")
            if not 64 <= app["memory_mb"] <= cfg["max_memory_mb"]:
                raise ApiError(f"memory_mb must be 64-{cfg['max_memory_mb']}.")
            if not 0.1 <= app["cpus"] <= cfg["max_cpus"]:
                raise ApiError(f"cpus must be 0.1-{cfg['max_cpus']}.")
            if app["health"] and not app["health"].startswith("/"):
                raise ApiError("health must be a path starting with /.")
            if total_memory_mb(exclude=name) + app["memory_mb"] > cfg["max_total_memory_mb"]:
                raise ApiError("The shared memory budget for apps and databases would be exceeded.")
            if not app.get("host_port"):
                app["host_port"] = allocate_port(cfg)
            tag = f"openbot-app/{name}:{time.strftime('%Y%m%d%H%M%S')}"
            job.log(f"Building {tag} from {real}")
            with build_lock:
                wait_for_memory(job, cfg["min_free_build_mb"])
                build_log = LOGS / "apps" / name
                build_log.mkdir(parents=True, exist_ok=True)
                proc = subprocess.Popen(
                    ["docker", "build", "--progress=plain", "-t", tag, str(context)],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                    env={**os.environ, "DOCKER_BUILDKIT": "1"},
                )
                started = time.time()
                with open(build_log / "build.log", "w") as out:
                    for line in proc.stdout:
                        out.write(line)
                        job.log(line)
                        if time.time() - started > cfg["build_timeout_s"]:
                            proc.kill()
                            raise ApiError("The build exceeded the time limit and was stopped.")
                if proc.wait() != 0:
                    event(app, "build failed")
                    write_json(app_path(name), app) if existing else None
                    raise ApiError("The build failed. The running version (if any) was left untouched.")
            previous = app.get("image")
            app["previous_image"] = previous
            app["image"] = tag
            job.log("Starting the new version")
            start_container(app, tag)
            healthy, why = wait_healthy(app, job)
            if not healthy:
                job.log(f"The new version is not healthy: {why}")
                tail = docker("logs", "--tail", "40", f"app-{name}", check=False)
                job.log((tail.stdout + tail.stderr)[-3000:])
                if previous and docker("image", "inspect", previous, check=False).returncode == 0:
                    job.log("Rolling back to the previous version")
                    app["image"], app["previous_image"] = previous, None
                    start_container(app, previous)
                    event(app, f"deploy of {tag} failed ({why}); rolled back")
                    write_json(app_path(name), app)
                    raise ApiError(f"The new version failed its health check ({why}); the previous version is running again.")
                docker("stop", f"app-{name}", check=False)
                event(app, f"deploy of {tag} failed ({why}); no previous version")
                write_json(app_path(name), app)
                raise ApiError(f"The new version failed its health check ({why}) and there is no previous version.")
            app["deployed_at"] = iso()
            app["desired"] = "running"
            event(app, f"deployed {tag} ({why})")
            write_json(app_path(name), app)
            apply_nginx()
            prune_images(name, keep={app["image"], app.get("previous_image")})
            job.log(f"Running: http://{name}.{cfg['domain']} (container port {app['port']})")

    return run_job("deploy", name, work)


def prune_images(name, keep):
    out = docker("images", f"openbot-app/{name}", "--format", "{{.Repository}}:{{.Tag}}", check=False).stdout
    for image in out.split():
        if image not in keep:
            docker("rmi", image, check=False)


def get_app(name):
    check_name(name)
    app = read_json(app_path(name))
    if not app:
        raise ApiError(f"No app named {name}.", 404)
    return app


def app_status(name, brief=False):
    app = get_app(name)
    cfg = load_config()
    info = container_info(f"app-{name}")
    state = "not-created"
    out = {
        "name": name,
        "url": f"https://{name}.{cfg['domain']}",
        "port": app["port"],
        "host_port": app["host_port"],
        "image": app.get("image"),
        "previous_image": app.get("previous_image"),
        "databases": app.get("dbs", []),
        "memory_limit_mb": app["memory_mb"],
        "cpus": app["cpus"],
        "deployed_at": app.get("deployed_at"),
        "health_path": app.get("health") or "/",
    }
    if info:
        st = info["State"]
        state = "running" if st["Running"] else st["Status"]
        out.update(
            restarts=info["RestartCount"],
            oom_killed=st.get("OOMKilled", False),
            started_at=st.get("StartedAt"),
            exit_code=None if st["Running"] else st.get("ExitCode"),
        )
        if st["Running"]:
            code = probe_http(app)
            out["http"] = abs(code) if code else None
            out["healthy"] = bool(code and code > 0)
            stats = docker("stats", "--no-stream", "--format", "{{.CPUPerc}} {{.MemUsage}}", f"app-{name}", check=False)
            if stats.returncode == 0 and stats.stdout.strip():
                out["usage"] = stats.stdout.strip()
    out["state"] = state
    if not brief:
        out["data_mb"] = dir_size_mb(BASE / "data" / name)
        out["env_names"] = sorted(read_json(env_path(name), {}))
        out["events"] = app.get("events", [])[-10:]
    return out


def list_apps():
    return [app_status(n, brief=True) for n in list_state("apps")]


def app_action(name, action):
    app = get_app(name)
    cname = f"app-{name}"
    with Held(f"app:{name}"):
        if action == "stop":
            docker("stop", "-t", "20", cname, check=False)
            app["desired"] = "stopped"
            event(app, "stopped")
        elif action == "start":
            if not container_info(cname):
                start_container(app, app["image"])
            else:
                docker("start", cname)
            app["desired"] = "running"
            event(app, "started")
        elif action == "restart":
            if container_info(cname):
                docker("restart", "-t", "20", cname)
            else:
                start_container(app, app["image"])
            app["desired"] = "running"
            event(app, "restarted")
        elif action == "recreate":
            start_container(app, app["image"])
            app["desired"] = "running"
            event(app, "recreated with current settings")
        elif action == "rollback":
            prev = app.get("previous_image")
            if not prev or docker("image", "inspect", prev, check=False).returncode != 0:
                raise ApiError("There is no previous version to roll back to.")
            app["image"], app["previous_image"] = prev, app["image"]
            start_container(app, prev)
            event(app, f"rolled back to {prev}")
        else:
            raise ApiError(f"Unknown action {action}.", 404)
        write_json(app_path(name), app)
    return app_status(name, brief=True)


def delete_app(name, confirm):
    app = get_app(name)
    if confirm != name:
        raise ApiError(f"To delete, confirm by sending the exact app name: --confirm {name}")
    with Held(f"app:{name}"):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        graveyard = BACKUPS / "_deleted" / f"app-{name}-{stamp}"
        graveyard.mkdir(parents=True, exist_ok=True)
        docker("rm", "-f", f"app-{name}", check=False)
        docker("network", "rm", f"appnet-{name}", check=False)
        data = BASE / "data" / name
        if data.exists():
            shutil.move(str(data), str(graveyard / "data"))
        shutil.copy2(app_path(name), graveyard / "app.json")
        if env_path(name).exists():
            shutil.move(str(env_path(name)), str(graveyard / "env.json"))
        app_path(name).unlink()
        (STATE / "run" / f"{name}.env").unlink(missing_ok=True)
        prune_images(name, keep=set())
        shutil.rmtree(BASE / "build" / name, ignore_errors=True)
    apply_nginx()
    return {"deleted": name, "kept_until_days": load_config()["deleted_keep_days"], "archive": str(graveyard)}


def app_logs(name, tail, since, build):
    get_app(name)
    if build:
        path = LOGS / "apps" / name / "build.log"
        if not path.exists():
            return {"log": ""}
        data = path.read_bytes()[-MAX_LOG_BYTES:]
        return {"log": data.decode("utf8", "replace")}
    args = ["logs", "--tail", str(max(1, min(int(tail), 2000))), "--timestamps"]
    if since:
        if not re.match(r"^\d+[smhd]$", since):
            raise ApiError("since must look like 30s, 10m, 2h or 1d.")
        args += ["--since", since]
    result = docker(*args, f"app-{name}", check=False)
    text = (result.stdout + result.stderr)[-MAX_LOG_BYTES:]
    return {"log": text}


def env_list(name):
    get_app(name)
    values = read_json(env_path(name), {})
    return {"names": sorted(values), "user_only_pattern": USER_ONLY_ENV_RE.pattern}


def env_set(name, pairs, admin=False):
    app = get_app(name)
    values = read_json(env_path(name), {})
    for key, value in pairs.items():
        if not ENV_NAME_RE.match(key):
            raise ApiError(f"Invalid variable name {key}; use A-Z, 0-9 and underscores.")
        if key in RESERVED_ENV or key.startswith("OPENBOT_"):
            raise ApiError(f"{key} is set by the broker.")
        if "\n" in value or "\r" in value or len(value) > 4096:
            raise ApiError(f"The value of {key} must be one line of at most 4096 characters.")
        if USER_ONLY_ENV_RE.search(key) and not admin:
            raise ApiError(
                f"{key} looks like a secret. Secret values are set only by the user "
                f"(on the host: `appsd.py env-set {name} {key}`). Ask the user to set it; "
                "your app can read it from the environment once it exists."
            )
        values[key] = value
    write_json(env_path(name), values)
    event(app, "environment changed: " + ", ".join(sorted(pairs)))
    write_json(app_path(name), app)
    return {"names": sorted(values), "note": "Run `appctl restart <app> --recreate` (or redeploy) to apply."}


def env_unset(name, key):
    app = get_app(name)
    values = read_json(env_path(name), {})
    if key not in values:
        raise ApiError(f"{key} is not set.", 404)
    if USER_ONLY_ENV_RE.search(key):
        raise ApiError(f"{key} is a user-owned secret; ask the user to remove it.")
    del values[key]
    write_json(env_path(name), values)
    event(app, f"environment variable removed: {key}")
    write_json(app_path(name), app)
    return {"names": sorted(values)}


# ---- databases --------------------------------------------------------------------------------


def get_db(name):
    check_name(name, "database")
    db = read_json(db_path(name))
    if not db:
        raise ApiError(f"No database named {name}.", 404)
    return db


def create_db(name, engine):
    check_name(name, "database")
    if engine not in ENGINES:
        raise ApiError(f"engine must be one of: {', '.join(ENGINES)}.")
    if read_json(db_path(name)):
        raise ApiError(f"A database named {name} already exists.", 409)
    spec = ENGINES[engine]
    cfg = load_config()
    if total_memory_mb() + spec["memory_mb"] > cfg["max_total_memory_mb"]:
        raise ApiError("The shared memory budget for apps and databases would be exceeded.")
    with Held(f"db:{name}"):
        password = secrets.token_urlsafe(24).replace("-", "a").replace("_", "b")
        cname = f"db-{name}"
        net = f"dbnet-{name}"
        ensure_network(net, internal=True)
        data = BASE / "data" / f"db-{name}"
        data.mkdir(parents=True, exist_ok=True)
        base = [
            "run", "-d", "--name", cname, "--restart", "unless-stopped", "--network", net,
            "--memory", f"{spec['memory_mb']}m", "--memory-swap", f"{spec['memory_mb']}m",
            "--cpus", "1", "--pids-limit", "512",
            "--cap-drop", "ALL", *sum((["--cap-add", c] for c in DB_CAPS), []),
            "--security-opt", "no-new-privileges:true",
            "-v", f"{data}:{spec['data']}",
            "--label", "openbot.apps=1", "--label", f"openbot.apps.db={name}",
            "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
        ]
        if engine == "postgres":
            base += ["-e", "POSTGRES_USER=app", "-e", f"POSTGRES_PASSWORD={password}", "-e", "POSTGRES_DB=app"]
            tail = [spec["image"]]
        elif engine == "mariadb":
            base += [
                "-e", f"MARIADB_ROOT_PASSWORD={secrets.token_urlsafe(24)}", "-e", "MARIADB_DATABASE=app",
                "-e", "MARIADB_USER=app", "-e", f"MARIADB_PASSWORD={password}",
            ]
            tail = [spec["image"]]
        else:
            tail = [spec["image"], "redis-server", "--requirepass", password, "--appendonly", "yes"]
        docker(*base, *tail, timeout=600)
        db = {
            "name": name, "engine": engine, "password": password, "memory_mb": spec["memory_mb"],
            "created_at": iso(), "last_backup": 0, "events": [],
        }
        write_json(db_path(name), db)
    return db_status(name)


def db_status(name):
    db = get_db(name)
    info = container_info(f"db-{name}")
    out = {
        "name": name, "engine": db["engine"], "memory_limit_mb": db["memory_mb"],
        "created_at": db["created_at"],
        "state": ("running" if info and info["State"]["Running"] else (info["State"]["Status"] if info else "missing")),
        "attached_apps": [a for a in list_state("apps") if name in (read_json(app_path(a)) or {}).get("dbs", [])],
        "host": f"db-{name}",
        "data_mb": dir_size_mb(BASE / "data" / f"db-{name}"),
        "backups": [b.name for b in sorted((BACKUPS / name).glob("*"))] if (BACKUPS / name).exists() else [],
    }
    if info:
        out["restarts"] = info["RestartCount"]
    return out


def db_exec_args(db, name, sql):
    c = f"db-{name}"
    if db["engine"] == "postgres":
        return ["exec", "-i", c, "psql", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1", "-P", "pager=off", "-c", sql]
    if db["engine"] == "mariadb":
        return ["exec", "-i", "-e", f"MYSQL_PWD={db['password']}", c, "mariadb", "-uapp", "app", "-t", "-e", sql]
    return ["exec", "-i", "-e", f"REDISCLI_AUTH={db['password']}", c, "redis-cli", *shlex.split(sql)]


def db_query(name, sql):
    db = get_db(name)
    if not sql or not sql.strip():
        raise ApiError("sql is required.")
    result = docker(*db_exec_args(db, name, sql), check=False, timeout=60)
    out = (result.stdout + result.stderr)[:MAX_QUERY_BYTES]
    return {"ok": result.returncode == 0, "output": out}


def backup_db(name, reason="manual"):
    db = get_db(name)
    folder = BACKUPS / name
    folder.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    c = f"db-{name}"
    if db["engine"] == "redis":
        docker("exec", "-e", f"REDISCLI_AUTH={db['password']}", c, "redis-cli", "SAVE")
        target = folder / f"{stamp}.rdb"
        docker("cp", f"{c}:/data/dump.rdb", str(target))
    else:
        target = folder / f"{stamp}.sql.gz"
        if db["engine"] == "postgres":
            cmd = ["docker", "exec", c, "pg_dump", "-U", "app", "--clean", "--if-exists", "app"]
        else:
            cmd = ["docker", "exec", "-e", f"MYSQL_PWD={db['password']}", c, "mariadb-dump", "-uapp", "--single-transaction", "app"]
        with open(target, "wb") as out:
            dump = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            gz = subprocess.Popen(["gzip", "-c"], stdin=dump.stdout, stdout=out)
            dump.stdout.close()
            gz.wait()
            err = dump.stderr.read().decode("utf8", "replace")
            if dump.wait() != 0 or gz.returncode != 0:
                target.unlink(missing_ok=True)
                raise ApiError(f"Backup failed: {err.strip()[-400:]}", 500)
    os.chmod(target, 0o600)
    db["last_backup"] = now()
    write_json(db_path(name), db)
    keep = load_config()["db_backup_keep"]
    files = sorted(folder.glob("*"))
    for old in files[:-keep]:
        old.unlink(missing_ok=True)
    return {"file": target.name, "bytes": target.stat().st_size, "reason": reason}


def restore_db(name, file, confirm):
    db = get_db(name)
    if not confirm:
        raise ApiError("Restoring replaces the current contents of the database. Pass --yes to confirm.")
    if db["engine"] == "redis":
        raise ApiError("Restore is not supported for redis; recreate the keys from the app or the backup file by hand.")
    path = (BACKUPS / name / os.path.basename(file or ""))
    if not path.is_file():
        raise ApiError("Backup file not found. See `appctl db status <name>` for the list.", 404)
    with Held(f"db:{name}"):
        backup_db(name, reason="pre-restore")
        c = f"db-{name}"
        if db["engine"] == "postgres":
            wipe = docker("exec", c, "psql", "-U", "app", "-d", "app", "-c",
                          "DROP SCHEMA public CASCADE; CREATE SCHEMA public;", check=False)
            loader = ["docker", "exec", "-i", c, "psql", "-U", "app", "-d", "app", "-v", "ON_ERROR_STOP=1"]
        else:
            wipe = docker("exec", "-e", f"MYSQL_PWD={db['password']}", c, "mariadb", "-uapp", "app", "-e",
                          "DROP DATABASE app; CREATE DATABASE app;", check=False)
            # The app user cannot drop its own database on some setups; fall back to the load alone.
            loader = ["docker", "exec", "-i", "-e", f"MYSQL_PWD={db['password']}", c, "mariadb", "-uapp", "app"]
        del wipe
        gz = subprocess.Popen(["gzip", "-dc", str(path)], stdout=subprocess.PIPE)
        load = subprocess.run(loader, stdin=gz.stdout, capture_output=True, text=True, timeout=1800)
        gz.stdout.close()
        gz.wait()
        if load.returncode != 0:
            raise ApiError(f"Restore failed: {load.stderr.strip()[-400:]}", 500)
    return {"restored": path.name}


def attach_db(db_name, app_name, detach=False):
    db = get_db(db_name)
    app = get_app(app_name)
    dbs = app.setdefault("dbs", [])
    if detach:
        if db_name not in dbs:
            raise ApiError(f"{db_name} is not attached to {app_name}.", 404)
        dbs.remove(db_name)
        event(app, f"database {db_name} detached")
    else:
        if db_name in dbs:
            raise ApiError(f"{db_name} is already attached to {app_name}.", 409)
        dbs.append(db_name)
        event(app, f"database {db_name} ({db['engine']}) attached")
    write_json(app_path(app_name), app)
    if app.get("image"):
        app_action(app_name, "recreate")
    names = sorted(db_urls(app))
    return {"app": app_name, "databases": dbs, "env_names": names}


def delete_db(name, confirm):
    db = get_db(name)
    if confirm != name:
        raise ApiError(f"To delete, confirm by sending the exact database name: --confirm {name}")
    attached = db_status(name)["attached_apps"]
    if attached:
        raise ApiError(f"Detach {name} from {', '.join(attached)} first.", 409)
    with Held(f"db:{name}"):
        snapshot = None
        info = container_info(f"db-{name}")
        if info and info["State"]["Running"]:
            snapshot = backup_db(name, reason="final")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        graveyard = BACKUPS / "_deleted" / f"db-{name}-{stamp}"
        graveyard.mkdir(parents=True, exist_ok=True)
        docker("rm", "-f", f"db-{name}", check=False)
        docker("network", "rm", f"dbnet-{name}", check=False)
        data = BASE / "data" / f"db-{name}"
        if data.exists():
            shutil.move(str(data), str(graveyard / "data"))
        if (BACKUPS / name).exists():
            shutil.move(str(BACKUPS / name), str(graveyard / "backups"))
        shutil.copy2(db_path(name), graveyard / "db.json")
        db_path(name).unlink()
    return {"deleted": name, "final_backup": snapshot, "archive": str(graveyard)}


# ---- overview and watchdog --------------------------------------------------------------------


def overview():
    cfg = load_config()
    return {
        "domain": cfg["domain"],
        "apps": len(list_state("apps")),
        "databases": len(list_state("dbs")),
        "memory_budget_mb": cfg["max_total_memory_mb"],
        "memory_reserved_mb": total_memory_mb(),
        "host_free_memory_mb": free_memory_mb(),
        "limits": {k: cfg[k] for k in ("max_apps", "max_memory_mb", "max_cpus", "default_memory_mb", "default_cpus")},
    }


_last_seen = {}


def watchdog_once():
    for name in list_state("apps"):
        app = read_json(app_path(name))
        if not app or not app.get("image") or app.get("desired") == "stopped":
            continue
        info = container_info(f"app-{name}")
        key = None
        if not info:
            key = "container missing"
        elif not info["State"]["Running"]:
            key = f"not running ({info['State']['Status']}, exit {info['State'].get('ExitCode')})"
        elif info["State"].get("OOMKilled"):
            key = "was killed for exceeding its memory limit"
        elif info["RestartCount"] != _last_seen.get((name, "restarts"), info["RestartCount"]):
            key = f"restarted (count {info['RestartCount']})"
        if info:
            _last_seen[(name, "restarts")] = info["RestartCount"]
        if key and _last_seen.get((name, "key")) != key:
            event(app, key)
            write_json(app_path(name), app)
        _last_seen[(name, "key")] = key


def backup_and_cleanup_once():
    cfg = load_config()
    for name in list_state("dbs"):
        db = read_json(db_path(name))
        if db and now() - db.get("last_backup", 0) > 86400 and (container_info(f"db-{name}") or {}).get("State", {}).get("Running"):
            try:
                backup_db(name, reason="scheduled")
            except ApiError as err:
                say(f"scheduled backup of {name} failed: {err}")
    graveyard = BACKUPS / "_deleted"
    if graveyard.exists():
        cutoff = time.time() - cfg["deleted_keep_days"] * 86400
        for entry in graveyard.iterdir():
            if entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)


def background_loop():
    tick = 0
    while True:
        try:
            watchdog_once()
            if tick % 20 == 0:
                backup_and_cleanup_once()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        tick += 1
        time.sleep(30)


# ---- HTTP API ---------------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "openbot-apps/1"

    def log_message(self, fmt, *args):  # request lines only, never bodies
        say("%s %s" % (self.command, urllib.parse.urlsplit(self.path).path))

    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            raise ApiError("Request body too large.", 413)
        if not length:
            return {}
        try:
            value = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            raise ApiError("Request body is not valid JSON.") from None
        if not isinstance(value, dict):
            raise ApiError("Request body must be a JSON object.")
        return value

    def handle_any(self):
        parts = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(parts.query))
        segs = [urllib.parse.unquote(s) for s in parts.path.strip("/").split("/")]
        method = self.command
        try:
            if segs[:1] != ["v1"]:
                raise ApiError("Not found.", 404)
            segs = segs[1:]
            body = self.body() if method in ("POST", "PUT", "DELETE") else {}
            self.reply(200, route(method, segs, query, body))
        except ApiError as err:
            self.reply(err.status, {"error": str(err)})
        except subprocess.TimeoutExpired:
            self.reply(504, {"error": "The operation timed out."})
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            self.reply(500, {"error": f"internal error: {err}"})

    do_GET = do_POST = do_PUT = do_DELETE = handle_any


def route(method, segs, query, body):
    if segs == ["health"]:
        return {"ok": True}
    if segs == ["overview"]:
        return overview()
    if segs and segs[0] == "jobs" and len(segs) == 2:
        job = jobs.get(segs[1])
        if not job:
            raise ApiError("Unknown job (the broker may have restarted).", 404)
        return job.describe(int(query.get("offset", 0)))
    if segs == ["apps"] and method == "GET":
        return {"apps": list_apps()}
    if segs[:1] == ["apps"] and len(segs) >= 2:
        name = segs[1]
        rest = segs[2:]
        if not rest and method == "GET":
            return app_status(name)
        if not rest and method == "DELETE":
            return delete_app(name, body.get("confirm"))
        if rest == ["deploy"] and method == "POST":
            job = deploy(name, body)
            return {"job": job.id}
        if rest == ["logs"] and method == "GET":
            return app_logs(name, query.get("tail", 200), query.get("since"), query.get("build") == "1")
        if rest == ["env"]:
            if method == "GET":
                return env_list(name)
            if method == "POST":
                pairs = body.get("set") or {}
                if not isinstance(pairs, dict) or not all(isinstance(v, str) for v in pairs.values()):
                    raise ApiError("set must be an object of NAME: value strings.")
                return env_set(name, pairs)
            if method == "DELETE":
                return env_unset(name, body.get("name", ""))
        if len(rest) == 1 and method == "POST" and rest[0] in ("stop", "start", "restart", "recreate", "rollback"):
            return app_action(name, rest[0])
    if segs == ["dbs"] and method == "GET":
        return {"databases": [db_status(n) for n in list_state("dbs")]}
    if segs[:1] == ["dbs"] and len(segs) >= 2:
        name = segs[1]
        rest = segs[2:]
        if not rest and method == "POST":
            return create_db(name, body.get("engine", "postgres"))
        if not rest and method == "GET":
            return db_status(name)
        if not rest and method == "DELETE":
            return delete_db(name, body.get("confirm"))
        if rest == ["query"] and method == "POST":
            return db_query(name, body.get("sql", ""))
        if rest == ["backup"] and method == "POST":
            with Held(f"db:{name}"):
                return backup_db(name)
        if rest == ["restore"] and method == "POST":
            return restore_db(name, body.get("file"), bool(body.get("yes")))
        if rest == ["attach"] and method == "POST":
            return attach_db(name, body.get("app", ""))
        if rest == ["detach"] and method == "POST":
            return attach_db(name, body.get("app", ""), detach=True)
    raise ApiError("Not found.", 404)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve():
    for sub in ("apps", "dbs", "env", "run"):
        (STATE / sub).mkdir(parents=True, exist_ok=True)
    for path in (BASE / "data", BASE / "build", LOGS, BACKUPS):
        path.mkdir(parents=True, exist_ok=True)
    if SOCKET_PATH.exists():
        SOCKET_PATH.unlink()
    server = Server(str(SOCKET_PATH), Handler)
    os.chown(SOCKET_PATH, OWNER_UID, OWNER_UID)
    os.chmod(SOCKET_PATH, 0o600)
    try:
        apply_nginx()
    except ApiError as err:
        say(f"nginx config not applied at start: {err}")
    threading.Thread(target=background_loop, daemon=True).start()
    say(f"openbot apps broker listening on {SOCKET_PATH}")
    server.serve_forever()


# ---- admin ------------------------------------------------------------------------------------

UNIT = """[Unit]
Description=OpenBot apps broker
After=docker.service network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/bin/python3 {script} serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""


def install():
    if os.geteuid() != 0:
        sys.exit("install must run as root")
    script_dir = Path(__file__).resolve().parent
    for sub in ("client", "state", "data", "build", "logs"):
        (BASE / sub).mkdir(parents=True, exist_ok=True)
    BACKUPS.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUPS, 0o700)
    target = BASE / "appsd.py"
    shutil.copy2(script_dir / "appsd.py", target)
    shutil.copy2(script_dir / "appctl", CLIENT_DIR / "appctl")
    os.chmod(CLIENT_DIR / "appctl", 0o755)
    os.chmod(target, 0o755)
    if not (BASE / "config.json").exists():
        write_json(BASE / "config.json", DEFAULT_CONFIG, 0o644)
    shared = DATA_ROOT / "Shared" / "apps"
    shared.mkdir(parents=True, exist_ok=True)
    os.chown(shared, OWNER_UID, OWNER_UID)
    Path("/etc/systemd/system/openbot-apps.service").write_text(UNIT.format(script=target))
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", "openbot-apps.service"], check=True)
    subprocess.run(["systemctl", "restart", "openbot-apps.service"], check=True)
    say("installed; broker restarted")


def admin_env_set(app, key):
    if not ENV_NAME_RE.match(key):
        sys.exit("invalid variable name")
    value = sys.stdin.read().rstrip("\n")
    env_set(app, {key: value}, admin=True)
    say(f"set {key} for {app} (apply with: appctl restart {app} --recreate)")


def main():
    args = sys.argv[1:]
    if not args or args[0] not in ("serve", "install", "env-set", "config", "status"):
        sys.exit(__doc__)
    if args[0] == "serve":
        serve()
    elif args[0] == "install":
        install()
    elif args[0] == "env-set" and len(args) == 3:
        admin_env_set(args[1], args[2])
    elif args[0] == "config":
        print(json.dumps(load_config(), indent=2))
    elif args[0] == "status":
        print(json.dumps(overview(), indent=2))
    else:
        sys.exit("usage: appsd.py env-set <app> <NAME>  (value on stdin)")


if __name__ == "__main__":
    main()
