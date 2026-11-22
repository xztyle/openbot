#!/usr/bin/env python3
"""Atelier backup broker: consistent snapshots of the live host, restore, and a staging copy.

Runs as root on the host (systemd `atelier-backup.service` serves the socket, `atelier-backup.timer`
runs the nightly backup). OpenBot's main process asks it for the list, a backup now, a restore check
and a restore through a unix socket that only the main process may use (SO_PEERCRED pid check).

  backupd.py serve                        the socket API (systemd service)
  backupd.py run [--reason R]             take a backup now (nightly timer, manual)
  backupd.py list                         the backups, newest first (JSON)
  backupd.py check <id> [--spaces]        restore dry run: checksums, archive test, schema, counts
  backupd.py restore <id> --confirm <id> [--spaces]
                                          stop OpenBot (and Motion), restore, start, verify
  backupd.py prune                        apply the retention now
  backupd.py offsite <id>                 upload one backup to the off-site target
  backupd.py staging up [--from <id>] [--image <tag>] [--fresh-db] [--no-view] [--json]
  backupd.py staging down | status
  backupd.py install                      copy to the backup root, write units, enable the timer

A snapshot is a folder `<root>/snapshots/<id>/`: `manifest.json`, `openbot.db.zst` (SQLite backup
API, checked with integrity_check), `motion.db.zst`, and `files/` (rsync, unchanged files hard-linked
to the previous snapshot, so a nightly copy costs only what changed). Root never opens a database
that agents can change: SQLite work runs as the owner of the data.
"""
import datetime as dt
import fcntl
import hashlib
import hmac
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse

ROOT = Path(os.environ.get("ATELIER_BACKUP_ROOT", "/opt/openbot/backups/atelier"))
ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$")
PROVIDERS = ["codex", "claude", "grok", "opencode", "antigravity", "cursor", "cline", "pi", "muse",
             "inception", "deepseek", "openrouter"]

# Paths under the data folder that are caches, toolchains or reinstallable runtimes. Anchored at the
# data folder (leading slash) or matched anywhere (no slash).
CORE_EXCLUDES = [
    "/.config/OpenBot/openbot.db", "/.config/OpenBot/openbot.db-wal", "/.config/OpenBot/openbot.db-shm",
    "/.config/OpenBot/openbot.db-journal", "/OpenBot/", "/backups/", "/.snapshots/",
    "/.cache/", "/.bun/", "/.npm/", "/.cargo/", "/.rustup/", "/.conda/", "/.mamba/", "/.expo/",
    "/.storybook/", "/.local/share/uv/", "/.local/share/godot/", "/.config/google-chrome-for-testing/",
    "/.config/OpenBot/Cache/", "/.config/OpenBot/Code Cache/", "/.config/OpenBot/GPUCache/",
    "/.config/OpenBot/DawnGraphiteCache/", "/.config/OpenBot/DawnWebGPUCache/",
    "/.config/OpenBot/GPUPersistentCache/", "/.config/OpenBot/Crashpad/", "/.config/OpenBot/blob_storage/",
    "/.config/OpenBot/Shared Dictionary/", "/.config/OpenBot/provider-runtimes/",
    "/.codex/cache/", "/.codex/tmp/", "/.claude/cache/", "/.claude/telemetry/", "/.claude/shell-snapshots/",
    "Singleton*",
]
BROWSER_PROFILES = "/.config/OpenBot/Partitions/"
TRANSCRIPTS = ["/.claude/projects/", "/.codex/sessions/", "/.codex/archived_sessions/"]
TREE_EXCLUDES = ["node_modules/", "target/", ".godot/", "__pycache__/", ".venv/", ".next/", ".turbo/",
                 ".gradle/", ".cache/", "tools/mamba/", "tools/rustup/", "tools/emsdk/", "tools/cargo/"]
HOST_FILES = ["compose.yaml", ".env.runtime", "seccomp.json", "openbot-runtime-compose.yaml", "build.env",
              "apps/config.json", "remote/compose.yaml", "remote/private-remote-compose.yaml",
              "remote/nginx-remote.conf", "remote/turnserver.conf", "remote/private-turnserver.conf"]
# In a staging copy these would let the copy act as the live host: its account session (a refresh
# could sign the live host out), its server identity, messaging and provider sign-ins.
STAGING_REMOVE = [
    ".config/OpenBot/openbot-central-auth-v1.bin", ".config/OpenBot/openbot-team-server-v2.json",
    ".config/OpenBot/openbot-remote-servers-v1.json", ".config/OpenBot/openbot-messaging-credentials-v1.json",
    ".config/OpenBot/openbot-discord-channels-v1.json", ".config/OpenBot/openbot-channel-bridge-v1.json",
    ".config/OpenBot/openbot-ingress-queue-key-v1.json", ".config/OpenBot/openbot-github-connector-v1.json",
    ".config/OpenBot/openbot-mcp-oauth-v1.json", ".config/OpenBot/openbot-restart-resumes-v1.json",
    ".config/OpenBot/provider-state", ".claude/.credentials.json", ".codex/auth.json",
]

DEFAULT_CONFIG = {
    "data_dir": "/opt/openbot/data",
    "host_dir": "/opt/openbot",
    "compose_file": "/opt/openbot/compose.yaml",
    "service": "openbot",
    "container": "openbot",
    "data_uid": 1000,
    "motion": {"enabled": True, "dir": "/opt/motion", "compose_file": "/opt/motion/compose.yaml",
               "service": "server", "container": "motion-server", "uid": 10001},
    "keep_daily": 1,
    "keep_weekly": 0,
    "keep_pre_restore": 1,
    "keep_manual": 1,
    "spaces": "all",
    "max_file_mb": 50,
    "min_free_gb": 20,
    "include_browser_profiles": False,
    "nightly": "03:30",
    "zstd_level": 6,
    "peer_policy": "openbot-main",
    "offsite": {"env_file": "/opt/openbot/secrets/backup-offsite.env", "include_transcripts": False},
    "staging": {"root": "/opt/openbot/staging", "project": "atelier-staging", "view_port": 20120,
                "memory": "6g", "with_spaces": False},
}


class Refused(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def say(message):
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def merge(base, extra):
    out = dict(base)
    for key, value in (extra or {}).items():
        out[key] = merge(base[key], value) if isinstance(value, dict) and isinstance(base.get(key), dict) else value
    return out


def load_config():
    path = ROOT / "config.json"
    extra = json.loads(path.read_text()) if path.exists() else {}
    return merge(DEFAULT_CONFIG, extra)


CFG = None


def cfg():
    global CFG
    if CFG is None:
        CFG = load_config()
    return CFG


def snapshots_dir():
    return ROOT / "snapshots"


def state_dir():
    return ROOT / "state"


def write_json(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def free_bytes(path):
    stat = os.statvfs(path)
    return stat.f_bavail * stat.f_frsize, stat.f_blocks * stat.f_frsize


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(4 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def run(cmd, check=True, timeout=None, user=None, capture=True, ok_codes=(0,), stdin=None):
    """Runs a command; `user` (a uid) drops root first, so SQLite and agent files are never root's."""
    kwargs = {}
    if user is not None and os.geteuid() == 0 and user != 0:
        kwargs.update(user=user, group=user, extra_groups=[])
    result = subprocess.run(cmd, text=True, timeout=timeout, capture_output=capture, input=stdin, **kwargs)
    if check and result.returncode not in ok_codes:
        detail = (result.stderr or result.stdout or "").strip()[-800:] if capture else ""
        raise Refused(f"{cmd[0]} failed ({result.returncode}): {detail}", 500)
    return result


def docker(*args, check=True, timeout=300):
    prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
    return run([*prefix, "docker", *args], check=check, timeout=timeout)


class Lock:
    """One backup, restore or staging change at a time, across the service, the timer and the CLI."""

    def __init__(self, wait=False):
        self.wait = wait

    def __enter__(self):
        state_dir().mkdir(parents=True, exist_ok=True)
        self.handle = open(state_dir() / "lock", "w")
        try:
            fcntl.flock(self.handle, fcntl.LOCK_EX | (0 if self.wait else fcntl.LOCK_NB))
        except BlockingIOError:
            self.handle.close()
            current = read_json(state_dir() / "current.json", {})
            raise Refused(f"Another {current.get('kind', 'backup')} is running.", 409) from None
        return self

    def __exit__(self, *exc):
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()


def set_current(kind, ident, phase):
    previous = read_json(state_dir() / "current.json", {}) or {}
    started = previous.get("startedAt") if previous.get("id") == ident and previous.get("kind") == kind else now_iso()
    write_json(state_dir() / "current.json", {"kind": kind, "id": ident, "phase": phase, "pid": os.getpid(),
                                              "startedAt": started, "updatedAt": now_iso()})


def clear_current():
    try:
        (state_dir() / "current.json").unlink()
    except FileNotFoundError:
        pass


def running_job():
    current = read_json(state_dir() / "current.json")
    if not current:
        return None
    try:
        os.kill(int(current.get("pid", 0)), 0)
    except (OSError, ValueError):
        return None
    return current


# ---- SQLite (runs as the owner of the data, never as root) ------------------------------------

def sqlite_helper(args, uid, timeout=1800):
    """Runs `backupd.py _sqlite <op> ...` as `uid` and returns its JSON line. The script goes in on
    stdin, because `uid` (Motion's user) may not be able to reach this folder."""
    try:
        result = run([sys.executable, "-I", "-", "_sqlite", *args, str(timeout)],
                     user=uid, timeout=timeout + 60, stdin=Path(__file__).resolve().read_text())
    except subprocess.TimeoutExpired:
        raise Refused(f"SQLite {args[0]} of {args[1]} timed out.", 504) from None
    return json.loads(result.stdout.strip().splitlines()[-1])


def sqlite_info(path, prefix, full=True):
    import sqlite3
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=60)
    try:
        names = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        integrity = connection.execute("PRAGMA integrity_check" if full else "PRAGMA quick_check").fetchone()[0]
        schema = None
        if "schema_migrations" in names:
            schema = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        counted = [name for name in names if name.startswith(prefix)] if prefix else \
            [name for name in names if not name.startswith("sqlite_")]
        counts = {name: connection.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in sorted(counted)}
        return {"integrity": integrity, "schema": schema, "counts": counts}
    finally:
        connection.close()


def sqlite_main(args):
    import sqlite3
    op, deadline = args[0], time.monotonic() + int(args[-1])
    args = args[:-1]

    def progress(_status, _remaining, _total):
        # The backup API retries a locked source forever; a holder that never lets go (Chromium keeps
        # its own databases locked) must not stall the backup.
        if time.monotonic() > deadline:
            raise TimeoutError("the source database stayed locked")

    if op == "copy":  # copy <src> <dst> <prefix>: online backup API, then checks on the copy
        src, dst, prefix = args[1], args[2], args[3] if len(args) > 3 else ""
        source = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=min(60, int(deadline - time.monotonic())))
        target = sqlite3.connect(dst)
        try:
            source.backup(target, progress=progress)
        finally:
            target.close()
            source.close()
        info = sqlite_info(dst, prefix)
        print(json.dumps(info))
    elif op == "info":  # info <path> <prefix> [quick]
        print(json.dumps(sqlite_info(args[1], args[2] if len(args) > 2 else "", full=len(args) < 4)))
    else:
        sys.exit("unknown sqlite op")


# ---- rsync --------------------------------------------------------------------------------------

def rsync(src, dst, link_dest=None, excludes=(), max_size=None, delete=True, dry_run=False):
    cmd = ["rsync", "-a", "--numeric-ids", "--stats", "--no-specials", "--no-devices"]
    if delete:
        cmd.append("--delete")
    if dry_run:
        cmd.append("--dry-run")
    if link_dest and Path(link_dest).is_dir():
        cmd.append(f"--link-dest={link_dest}")
    if max_size:
        cmd.append(f"--max-size={max_size}")
    cmd += [f"--exclude={pattern}" for pattern in excludes]
    Path(dst).mkdir(parents=True, exist_ok=True)
    # 24: some files vanished while copying (agents work during the backup); the rest is complete.
    result = run([*cmd, f"{str(src).rstrip('/')}/", f"{str(dst).rstrip('/')}/"], ok_codes=(0, 24))
    stats = {}
    for key, label in (("files", r"Number of files: ([\d,]+)"), ("bytes", r"Total file size: ([\d,]+)"),
                       ("newBytes", r"Total transferred file size: ([\d,]+)")):
        match = re.search(label, result.stdout)
        stats[key] = int(match.group(1).replace(",", "")) if match else 0
    return stats


# ---- backup -------------------------------------------------------------------------------------

def list_snapshots(include_failed=True):
    base = snapshots_dir()
    if not base.is_dir():
        return []
    found = []
    for entry in base.iterdir():
        if entry.name.startswith(".") or not ID_RE.match(entry.name):
            continue
        manifest = read_json(entry / "manifest.json")
        if manifest and (include_failed or manifest.get("status") != "failed"):
            found.append(manifest)
    return sorted(found, key=lambda item: item.get("createdAt", ""), reverse=True)


def new_id():
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d-%H%M")
    ident, n = stamp, 1
    while (snapshots_dir() / ident).exists() or (snapshots_dir() / f".partial-{ident}").exists():
        n += 1
        ident = f"{stamp}-{n}"
    return ident


def compose_image():
    try:
        match = re.search(r"image:\s*(openbot-private:[A-Za-z0-9._-]+)", Path(cfg()["compose_file"]).read_text())
        return match.group(1) if match else None
    except OSError:
        return None


def space_names():
    spaces = Path(cfg()["data_dir"]) / "OpenBot" / "Spaces"
    if not spaces.is_dir():
        return []
    names = sorted(entry.name for entry in spaces.iterdir() if entry.is_dir() and not entry.is_symlink())
    wanted = cfg()["spaces"]
    if wanted == "all":
        return names
    if wanted in (None, "none", False):
        return []
    return [name for name in names if name in wanted]


def db_copy(src, work, name, uid, prefix, snapshot):
    """Online SQLite copy as `uid`, checked, compressed into the snapshot. Returns its manifest entry."""
    raw = work / f"{name}.db"
    info = sqlite_helper(["copy", str(src), str(raw), prefix], uid)
    if info["integrity"] != "ok":
        raise Refused(f"The copy of {name}.db failed its integrity check: {info['integrity'][:200]}", 500)
    raw_bytes = raw.stat().st_size
    target = snapshot / f"{name}.db.zst"
    run(["zstd", "-q", "-T0", f"-{cfg()['zstd_level']}", "--rm", "-f", "-o", str(target), str(raw)], timeout=3600)
    os.chmod(target, 0o600)
    return {"file": target.name, "bytes": target.stat().st_size, "rawBytes": raw_bytes, "sha256": sha256(target),
            "integrity": info["integrity"], "schema": info["schema"], "counts": info["counts"]}


def consistent_sqlite_files(files_root, source_root, work, uid):
    """Replaces live-copied SQLite files of the core tree with backup-API copies (renamed in, so the
    previous snapshot that shares the inode keeps its own)."""
    replaced = 0
    for path in files_root.rglob("*"):
        if path.suffix not in (".sqlite", ".sqlite3", ".db") or not path.is_file() or path.is_symlink():
            continue
        if path.stat().st_size > 512 << 20:
            continue
        with open(path, "rb") as handle:
            if handle.read(16) != b"SQLite format 3\x00":
                continue
        rel = path.relative_to(files_root)
        source = source_root / rel
        tmp = work / f"sqlite-{replaced}.tmp"
        try:
            sqlite_helper(["copy", str(source), str(tmp), "__none__"], uid, timeout=30)
        except Refused:
            tmp.unlink(missing_ok=True)
            continue  # locked by its owner: the rsync copy stays
        os.chmod(tmp, path.stat().st_mode & 0o777)
        if os.geteuid() == 0:
            os.chown(tmp, path.stat().st_uid, path.stat().st_gid)
        os.replace(tmp, path)
        for suffix in ("-wal", "-shm", "-journal"):
            Path(f"{path}{suffix}").unlink(missing_ok=True)
        replaced += 1
    return replaced


def backup(reason="manual", spaces=True):
    c = cfg()
    with Lock():
        snapshots_dir().mkdir(parents=True, exist_ok=True)
        os.chmod(snapshots_dir(), 0o700)
        ident = new_id()
        partial = snapshots_dir() / f".partial-{ident}"
        partial.mkdir(mode=0o700)
        started = time.monotonic()
        set_current("backup", ident, "database")
        data = Path(c["data_dir"])
        previous = next((snap for snap in list_snapshots(include_failed=False)
                         if (snapshots_dir() / snap["id"] / "files").is_dir()), None)
        prev_files = snapshots_dir() / previous["id"] / "files" if previous else None
        prev_components = {item["name"]: item for item in (previous or {}).get("components", [])}
        manifest = {"format": "atelier-backup", "formatVersion": 1, "id": ident, "createdAt": now_iso(),
                    "reason": reason, "status": "running", "image": compose_image(), "host": socket.gethostname(),
                    "components": [], "maxFileMb": c["max_file_mb"]}
        min_free = c["min_free_gb"] << 30
        db_path = data / ".config/OpenBot/openbot.db"
        free, _ = free_bytes(snapshots_dir())
        if free < min_free + (db_path.stat().st_size if db_path.exists() else 0):
            shutil.rmtree(partial, ignore_errors=True)
            clear_current()
            raise Refused(f"Only {free >> 30} GB free on the backup disk; a backup needs at least "
                          f"{c['min_free_gb']} GB plus the database. Free space or lower min_free_gb.", 507)
        work = ROOT / "work" / ident
        uid = c["data_uid"]
        try:
            # Each owner writes only its own folder. The Motion user can't reach ROOT (its parents are
            # private), so its folder is a private one under /var/tmp, removed after the copy.
            motion_work = Path(tempfile.mkdtemp(prefix=f"atelier-backup-{ident}-", dir="/var/tmp"))
            for path, owner, mode in ((work, uid, 0o711), (motion_work, c["motion"]["uid"], 0o700)):
                path.mkdir(parents=True, exist_ok=True)
                os.chmod(path, mode)
                if os.geteuid() == 0:
                    os.chown(path, owner, owner)
            os.chmod(ROOT, 0o711)
            (ROOT / "work").chmod(0o711)
            manifest["database"] = db_copy(db_path, work, "openbot", uid, "projection_", partial)
            manifest["schema"] = manifest["database"]["schema"]
            say(f"openbot.db: {manifest['database']['rawBytes'] >> 20} MB -> {manifest['database']['bytes'] >> 20} MB")
            motion = c["motion"]
            motion_db = Path(motion["dir"]) / "data" / "motion.db"
            if motion.get("enabled") and motion_db.exists():
                set_current("backup", ident, "motion")
                try:
                    manifest["motion"] = db_copy(motion_db, motion_work, "motion", motion["uid"], "", partial)
                except Refused as error:
                    manifest["motion"] = {"error": str(error)}
            shutil.rmtree(motion_work, ignore_errors=True)
            files = partial / "files"

            def component(name, src, dst, excludes, max_size=None, guard=False, delete=True):
                set_current("backup", ident, name)
                entry = {"name": name, "status": "ok"}
                link = prev_files / dst if prev_files else None
                try:
                    if not Path(src).exists():
                        entry.update(status="skipped", reason="missing")
                        return manifest["components"].append(entry)
                    if guard:
                        known = prev_components.get(name, {}).get("status") == "ok"
                        need = rsync(src, files / dst, link, excludes, max_size, dry_run=True)["newBytes"] \
                            if not known else 0
                        free_now, _ = free_bytes(snapshots_dir())
                        if free_now - need < min_free:
                            entry.update(status="skipped", reason=f"needs {need >> 30} GB, "
                                         f"{free_now >> 30} GB free (min {c['min_free_gb']} GB kept)")
                            return manifest["components"].append(entry)
                    entry.update(rsync(src, files / dst, link, excludes, max_size, delete=delete))
                except Refused as error:
                    entry.update(status="failed", reason=str(error)[:300])
                manifest["components"].append(entry)

            core_excludes = list(CORE_EXCLUDES)
            if not c["include_browser_profiles"]:
                core_excludes.append(BROWSER_PROFILES)
            component("core", data, "data", core_excludes)
            if (files / "data").is_dir():
                consistent_sqlite_files(files / "data", data, work, uid)
            limit = f"{c['max_file_mb']}m"
            for sub in ("Agents", "Shared", "Downloads"):
                component(f"workspace:{sub}", data / "OpenBot" / sub, f"data/OpenBot/{sub}", TREE_EXCLUDES, limit,
                          guard=True)
            index = data / "OpenBot" / "Spaces" / "index.json"
            if index.exists():
                (files / "data/OpenBot/Spaces").mkdir(parents=True, exist_ok=True)
                shutil.copy2(index, files / "data/OpenBot/Spaces/index.json")
            # The folders made here and the copied index belong to the data owner, as on the host: a
            # staging copy runs as that user and must create the spaces this backup leaves out.
            for rel in ("data/OpenBot", "data/OpenBot/Spaces", "data/OpenBot/Spaces/index.json"):
                if (files / rel).exists():
                    os.chown(files / rel, uid, uid)
            for name in space_names() if spaces else []:
                component(f"space:{name}", data / "OpenBot" / "Spaces" / name, f"data/OpenBot/Spaces/{name}",
                          TREE_EXCLUDES, limit, guard=True)
            if motion.get("enabled") and Path(motion["dir"]).is_dir():
                component("motion-files", motion["dir"], "motion",
                          ["/data/motion.db", "/data/motion.db-wal", "/data/motion.db-shm", "*.v1"])
            set_current("backup", ident, "host")
            host = Path(c["host_dir"])
            host_entry = {"name": "host-config", "status": "ok", "files": 0}
            for rel in HOST_FILES:
                if (host / rel).is_file():
                    (files / "host" / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(host / rel, files / "host" / rel)
                    host_entry["files"] += 1
            manifest["components"].append(host_entry)
            statuses = {item["status"] for item in manifest["components"]}
            manifest["status"] = "ok" if statuses <= {"ok"} and "error" not in manifest.get("motion", {}) else "partial"
        except Exception as error:  # noqa: BLE001 - a failed backup is reported, never raised to the timer silently
            manifest["status"] = "failed"
            manifest["error"] = str(error)[:500]
            traceback.print_exc()
        finally:
            shutil.rmtree(work, ignore_errors=True)
        manifest["finishedAt"] = now_iso()
        manifest["seconds"] = round(time.monotonic() - started, 1)
        manifest["bytes"] = sum(item.get("bytes", 0) for item in manifest["components"]) + \
            manifest.get("database", {}).get("bytes", 0) + manifest.get("motion", {}).get("bytes", 0)
        manifest["newBytes"] = sum(item.get("newBytes", 0) for item in manifest["components"]) + \
            manifest.get("database", {}).get("bytes", 0) + manifest.get("motion", {}).get("bytes", 0)
        write_json(partial / "manifest.json", manifest)
        os.rename(partial, snapshots_dir() / ident)
        write_json(state_dir() / "last-backup.json", {k: manifest.get(k) for k in
                   ("id", "status", "reason", "createdAt", "finishedAt", "error")})
        say(f"backup {ident}: {manifest['status']} in {manifest['seconds']} s")
        set_current("backup", ident, "prune")
        prune()
        clear_current()
    if manifest["status"] != "failed" and offsite_settings():
        try:
            offsite(ident)
        except Exception as error:  # noqa: BLE001
            manifest["offsite"] = {"status": "failed", "error": str(error)[:300]}
            write_json(snapshots_dir() / ident / "manifest.json", manifest)
    return manifest


def prune():
    """Keeps the newest nightly backup of each of the last `keep_daily` days and `keep_weekly` weeks, the
    newest `keep_manual` manual ones and `keep_pre_restore` safety copies, a pinned (staging) one, and
    always the newest good one. A failed one goes after two days."""
    c = cfg()
    snaps = list_snapshots()
    good = [snap for snap in snaps if snap.get("status") in ("ok", "partial")]
    keep = set()
    if good:
        keep.add(good[0]["id"])
    regular = [snap for snap in good if snap.get("reason") not in ("pre-restore", "manual")]
    days, weeks = [], []
    for snap in regular:
        day = snap["createdAt"][:10]
        week = dt.date.fromisoformat(day).isocalendar()[:2]
        if day not in days and len(days) < c["keep_daily"]:
            days.append(day)
            keep.add(snap["id"])
        if week not in weeks and len(weeks) < c["keep_weekly"]:
            weeks.append(week)
            keep.add(snap["id"])
    keep.update(snap["id"] for snap in [s for s in good if s.get("reason") == "pre-restore"][:c["keep_pre_restore"]])
    keep.update(snap["id"] for snap in [s for s in good if s.get("reason") == "manual"][:c["keep_manual"]])
    pinned = read_json(state_dir() / "pins.json", {}) or {}
    keep.update(value for value in pinned.values() if value)
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    removed = []
    for snap in snaps:
        if snap["id"] in keep or (snap.get("status") == "failed" and snap.get("createdAt", "") > cutoff):
            continue
        shutil.rmtree(snapshots_dir() / snap["id"], ignore_errors=True)
        removed.append(snap["id"])
    if running_job() is None or running_job().get("pid") == os.getpid():
        for entry in snapshots_dir().glob(".partial-*"):
            current = read_json(state_dir() / "current.json", {}) or {}
            if entry.name != f".partial-{current.get('id')}":
                shutil.rmtree(entry, ignore_errors=True)
    if removed:
        say(f"pruned {', '.join(removed)}")
    return removed


# ---- restore ------------------------------------------------------------------------------------

def snapshot_path(ident):
    if not isinstance(ident, str) or not ID_RE.match(ident):
        raise Refused("Unknown backup.", 404)
    path = snapshots_dir() / ident
    if not (path / "manifest.json").is_file():
        raise Refused("Unknown backup.", 404)
    return path


def restore_plan(manifest, spaces):
    plan = ["database"]
    if manifest.get("motion", {}).get("file"):
        plan.append("motion")
    for item in manifest.get("components", []):
        if item.get("status") != "ok" or item["name"] == "host-config":
            continue
        if item["name"].startswith("space:") and not spaces:
            continue
        plan.append(item["name"])
    return plan


def check(ident, spaces=False):
    """The restore dry run. Nothing changes; a problem blocks the restore, a warning does not."""
    c = cfg()
    path = snapshot_path(ident)
    manifest = read_json(path / "manifest.json")
    problems, warnings = [], []
    if manifest.get("status") == "failed":
        problems.append("This backup did not finish.")
    db = manifest.get("database") or {}
    for entry, label in ((db, "openbot.db"), (manifest.get("motion") or {}, "motion.db")):
        if not entry.get("file"):
            if label == "openbot.db":
                problems.append("The backup has no database.")
            continue
        file = path / entry["file"]
        if not file.is_file():
            problems.append(f"{label} is missing from the backup.")
        elif sha256(file) != entry.get("sha256"):
            problems.append(f"{label} does not match its checksum: the backup is damaged.")
        elif run(["zstd", "-q", "-t", str(file)], check=False).returncode:
            problems.append(f"{label} does not decompress.")
    current = None
    live = Path(c["data_dir"]) / ".config/OpenBot/openbot.db"
    if live.exists():
        try:
            current = sqlite_helper(["info", str(live), "projection_", "quick"], c["data_uid"], timeout=900)
        except Refused as error:
            warnings.append(f"The current database could not be read: {error}")
    if current and db.get("schema") and current.get("schema") and db["schema"] > current["schema"]:
        problems.append(f"The backup has schema {db['schema']}, newer than the running build "
                        f"({current['schema']}). Deploy that build first.")
    elif current and db.get("schema") and current.get("schema") and db["schema"] < current["schema"]:
        warnings.append(f"The backup has schema {db['schema']}; OpenBot migrates it to {current['schema']} "
                        "when it starts.")
    skipped = [item["name"] for item in manifest.get("components", []) if item.get("status") != "ok"]
    if skipped:
        warnings.append("Not in this backup, so left as they are now: " + ", ".join(skipped) + ".")
    if not spaces and any(item["name"].startswith("space:") for item in manifest.get("components", [])):
        warnings.append("Space folders stay as they are now (restore them with the Spaces option).")
    free, _ = free_bytes(snapshots_dir())
    need = db.get("rawBytes", 0) * 2 + (c["min_free_gb"] << 30) // 4
    if free < need:
        problems.append(f"Restoring needs about {need >> 30} GB free; {free >> 30} GB are free.")
    running = running_job()
    if running:
        problems.append(f"A {running.get('kind')} is running.")
    diff = []
    if current:
        before, after = current.get("counts", {}), db.get("counts", {})
        for name in ("projection_agents", "projection_threads", "projection_thread_messages",
                     "projection_channel_messages", "projection_agent_routines", "projection_agent_memories"):
            if name in before or name in after:
                diff.append({"table": name, "now": before.get(name, 0), "backup": after.get(name, 0)})
    return {"ok": not problems, "problems": problems, "warnings": warnings,
            "backup": {"id": ident, "createdAt": manifest.get("createdAt"), "schema": db.get("schema"),
                       "image": manifest.get("image")},
            "current": {"schema": (current or {}).get("schema"), "image": compose_image()},
            "restore": restore_plan(manifest, spaces), "counts": diff,
            "confirm": ident}


def wait_ready(container, seconds=240):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        state = docker("inspect", container, "--format", "{{.State.Running}}", check=False)
        if state.returncode == 0 and state.stdout.strip() == "true":
            probe = docker("exec", container, "curl", "--fail", "--silent", "--max-time", "3", "--unix-socket",
                           "/run/openbot/control.sock", "http://openbot/v1/status", check=False, timeout=20)
            if probe.returncode == 0:
                return probe.stdout
        time.sleep(3)
    raise Refused(f"{container} did not become ready in {seconds} s.", 500)


def restore_db(file, target, uid):
    tmp = target.with_name(f".{target.name}.restore")
    run(["zstd", "-q", "-d", "-f", "-o", str(tmp), str(file)], timeout=3600)
    if os.geteuid() == 0:
        os.chown(tmp, uid, uid)
    os.chmod(tmp, 0o600)
    for suffix in ("-wal", "-shm", "-journal"):
        Path(f"{target}{suffix}").unlink(missing_ok=True)
    os.replace(tmp, target)


def restore(ident, confirm, spaces=False):
    c = cfg()
    if confirm != ident:
        raise Refused("Type the backup name exactly to confirm the restore.", 400)
    result = check(ident, spaces)
    if not result["ok"]:
        raise Refused("The restore check failed: " + " ".join(result["problems"]), 409)
    path = snapshot_path(ident)
    manifest = read_json(path / "manifest.json")
    status = {"id": ident, "startedAt": now_iso(), "status": "running", "steps": []}

    def step(text):
        status["steps"].append({"at": now_iso(), "text": text})
        write_json(state_dir() / "restore-last.json", status)
        say(text)

    step("Taking a safety backup of the current state.")
    safety = backup(reason="pre-restore", spaces=spaces)
    if safety["status"] == "failed":
        status["status"] = "failed"
        step(f"The safety backup failed ({safety.get('error')}); nothing was restored.")
        raise Refused("The safety backup failed; nothing was restored.", 500)
    status["safetyBackup"] = safety["id"]
    with Lock():
        set_current("restore", ident, "stopping")
        data = Path(c["data_dir"])
        motion = c["motion"]
        restore_motion = "motion" in result["restore"]
        try:
            step("Stopping OpenBot.")
            docker("compose", "-f", c["compose_file"], "stop", "-t", "60", c["service"], timeout=180)
            if restore_motion:
                step("Stopping Motion.")
                docker("compose", "-f", motion["compose_file"], "stop", "-t", "30", motion["service"], timeout=120)
            set_current("restore", ident, "files")
            files = path / "files"
            core_excludes = list(CORE_EXCLUDES) + ([] if c["include_browser_profiles"] else [BROWSER_PROFILES])
            step("Restoring the database.")
            restore_db(path / manifest["database"]["file"], data / ".config/OpenBot/openbot.db", c["data_uid"])
            for name in result["restore"]:
                if name == "core":
                    step("Restoring settings, keys, vault and provider accounts.")
                    rsync(files / "data", data, excludes=core_excludes)
                elif name.startswith("workspace:") or name.startswith("space:"):
                    rel = "OpenBot/" + name.split(":", 1)[1] if name.startswith("workspace:") \
                        else "OpenBot/Spaces/" + name.split(":", 1)[1]
                    step(f"Restoring {rel} (files newer than the backup stay).")
                    rsync(files / "data" / rel, data / rel, excludes=TREE_EXCLUDES, delete=False)
                elif name == "motion":
                    step("Restoring the Motion board.")
                    restore_db(path / manifest["motion"]["file"], Path(motion["dir"]) / "data/motion.db", motion["uid"])
                elif name == "motion-files":
                    rsync(files / "motion" / "data", Path(motion["dir"]) / "data", delete=False,
                          excludes=["/motion.db", "/motion.db-wal", "/motion.db-shm"])
            status["status"] = "restored"
        except Exception as error:  # noqa: BLE001
            status["status"] = "failed"
            status["error"] = str(error)[:500]
            step(f"The restore stopped: {error}. The safety backup is {safety['id']}.")
        finally:
            set_current("restore", ident, "starting")
            if restore_motion:
                docker("compose", "-f", motion["compose_file"], "start", motion["service"], check=False, timeout=120)
            step("Starting OpenBot.")
            docker("compose", "-f", c["compose_file"], "start", c["service"], check=False, timeout=180)
            try:
                wait_ready(c["container"])
                after = sqlite_helper(["info", str(data / ".config/OpenBot/openbot.db"), "projection_", "quick"],
                                      c["data_uid"], timeout=900)
                status["after"] = {"schema": after["schema"], "integrity": after["integrity"]}
                if status["status"] == "restored":
                    status["status"] = "ok" if after["integrity"] == "ok" else "failed"
                step(f"OpenBot is back: schema {after['schema']}, integrity {after['integrity']}.")
            except Refused as error:
                status["status"] = "failed"
                step(str(error))
            status["finishedAt"] = now_iso()
            write_json(state_dir() / "restore-last.json", status)
            clear_current()
    return status


# ---- off-site (S3-compatible: Cloudflare R2, AWS S3, Backblaze B2, MinIO) -----------------------

def offsite_settings():
    path = Path(cfg()["offsite"]["env_file"])
    if not path.is_file():
        return None
    values = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    needed = ("BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY",
              "BACKUP_ENCRYPTION_PASSPHRASE")
    return values if all(values.get(key) for key in needed) else None


def s3_request(settings, method, key="", query=None, body_path=None, body=b""):
    """One SigV4-signed request (path-style URL). The payload is hashed, so any S3 provider accepts it."""
    endpoint = urllib.parse.urlsplit(settings["BACKUP_S3_ENDPOINT"])
    region = settings.get("BACKUP_S3_REGION") or "auto"
    path = "/" + settings["BACKUP_S3_BUCKET"] + ("/" + urllib.parse.quote(key, safe="/~") if key else "")
    query = sorted((query or {}).items())
    canonical_query = "&".join(f"{urllib.parse.quote(k, safe='~')}={urllib.parse.quote(str(v), safe='~')}"
                               for k, v in query)
    payload_hash = sha256(body_path) if body_path else hashlib.sha256(body).hexdigest()
    stamp = dt.datetime.now(dt.timezone.utc)
    amz_date, date = stamp.strftime("%Y%m%dT%H%M%SZ"), stamp.strftime("%Y%m%d")
    headers = {"host": endpoint.netloc, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
    signed = ";".join(sorted(headers))
    canonical = "\n".join([method, path, canonical_query, "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)),
                           signed, payload_hash])
    scope = f"{date}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key_bytes = ("AWS4" + settings["BACKUP_S3_SECRET_ACCESS_KEY"]).encode()
    for part in (date, region, "s3", "aws4_request"):
        key_bytes = hmac.new(key_bytes, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key_bytes, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = (f"AWS4-HMAC-SHA256 Credential={settings['BACKUP_S3_ACCESS_KEY_ID']}/{scope}, "
                                f"SignedHeaders={signed}, Signature={signature}")
    connection_type = http.client.HTTPSConnection if endpoint.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(endpoint.netloc, timeout=600)
    url = path + (f"?{canonical_query}" if canonical_query else "")
    if body_path:
        headers["content-length"] = str(os.path.getsize(body_path))
        with open(body_path, "rb") as handle:
            connection.request(method, url, body=handle, headers=headers)
    else:
        connection.request(method, url, body=body or None, headers=headers)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    if response.status >= 300:
        raise Refused(f"S3 {method} answered {response.status}: {data[:300].decode(errors='replace')}", 502)
    return data


def offsite(ident):
    """Uploads the database, Motion and the core settings of one backup, encrypted with gpg (AES256)."""
    settings = offsite_settings()
    if not settings:
        raise Refused("No off-site target: see README (backup-offsite.env).", 400)
    path = snapshot_path(ident)
    manifest = read_json(path / "manifest.json")
    tmp_dir = ROOT / "work" / f"offsite-{ident}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(tmp_dir, 0o700)
    archive = tmp_dir / f"atelier-{ident}.tar.gpg"
    members = ["manifest.json", manifest["database"]["file"]]
    if manifest.get("motion", {}).get("file"):
        members.append(manifest["motion"]["file"])
    excludes = ["--exclude=files/data/OpenBot"]
    if not cfg()["offsite"]["include_transcripts"]:
        excludes += [f"--exclude=files/data{p.rstrip('/')}" for p in TRANSCRIPTS]
    for sub in ("files/data", "files/motion", "files/host"):
        if (path / sub).exists():
            members.append(sub)
    set_current("offsite", ident, "upload")
    try:
        read_fd, write_fd = os.pipe()
        os.write(write_fd, settings["BACKUP_ENCRYPTION_PASSPHRASE"].encode() + b"\n")
        os.close(write_fd)
        tar = subprocess.Popen(["tar", "-C", str(path), *excludes, "-cf", "-", *members], stdout=subprocess.PIPE)
        # gpg starts an agent whose socket lives in the home folder: keep its path short.
        import tempfile
        home = Path(tempfile.mkdtemp(prefix="atelier-gpg-", dir="/tmp"))
        gpg = subprocess.run(["gpg", "--homedir", str(home), "--batch", "--yes", "--quiet", "--pinentry-mode",
                              "loopback", "--symmetric", "--cipher-algo", "AES256", "--compress-algo", "none",
                              "--passphrase-fd", str(read_fd), "-o", str(archive)],
                             stdin=tar.stdout, pass_fds=(read_fd,), capture_output=True)
        tar.stdout.close()
        os.close(read_fd)
        tar_code = tar.wait()
        subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "gpg-agent"], capture_output=True)
        shutil.rmtree(home, ignore_errors=True)
        if tar_code not in (0, 1) or gpg.returncode:
            raise Refused(f"Could not build the encrypted archive (tar {tar_code}, gpg {gpg.returncode}: "
                          f"{gpg.stderr.decode(errors='replace')[-300:]}).", 500)
        prefix = settings.get("BACKUP_S3_PREFIX", "atelier/").strip("/") + "/"
        s3_request(settings, "PUT", prefix + archive.name, body_path=archive)
        entry = {"status": "ok", "key": prefix + archive.name, "bytes": archive.stat().st_size, "at": now_iso()}
        keep = int(settings.get("BACKUP_OFFSITE_KEEP", "14"))
        listing = s3_request(settings, "GET", query={"list-type": "2", "prefix": prefix}).decode()
        keys = sorted(re.findall(r"<Key>([^<]+\.tar\.gpg)</Key>", listing), reverse=True)
        for old in keys[keep:]:
            s3_request(settings, "DELETE", old)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if (read_json(state_dir() / "current.json", {}) or {}).get("kind") == "offsite":
            clear_current()
    manifest["offsite"] = entry
    write_json(path / "manifest.json", manifest)
    return entry


# ---- staging --------------------------------------------------------------------------------------

STAGING_VIEW_IMAGE = "atelier-staging-view:1"


def staging_paths():
    root = Path(cfg()["staging"]["root"])
    return root, root / "upper", root / "work", root / "merged"


def staging_compose(image, env_file, merged, view):
    s = cfg()["staging"]
    host = Path(cfg()["host_dir"])
    project = s["project"]
    view_service = f"""
  view:
    image: {STAGING_VIEW_IMAGE}
    container_name: {project}-view
    restart: "no"
    user: "1001:1001"
    depends_on: [display]
    volumes:
      - x11:/tmp/.X11-unix
    ports:
      - "127.0.0.1:{s['view_port']}:6080"
    security_opt: ["no-new-privileges:true"]
    mem_limit: 256m
""" if view else ""
    return f"""# Generated by backupd.py staging up. A copy of Atelier from a backup: its own internal network
# (no internet, so no provider, messaging or Signal traffic), every provider switched off, and its
# account session and server identity removed. View it at http://127.0.0.1:{s['view_port']}/vnc.html
name: {project}

services:
  display:
    image: openbot-display:1
    container_name: {project}-display
    restart: "no"
    user: "1001:1001"
    network_mode: none
    ipc: shareable
    shm_size: 1g
    security_opt: ["no-new-privileges:true"]
    cap_drop: [ALL]
    mem_limit: 1g
    tmpfs: ["/tmp:mode=1777"]
    volumes:
      - x11:/tmp/.X11-unix
    entrypoint: ["sh", "-c", "rm -f /tmp/.X0-lock /tmp/.X11-unix/X0; exec Xvfb :0 -screen 0 1440x900x24 -nolisten tcp"]
    healthcheck:
      test: ["CMD", "xdpyinfo", "-display", ":0"]
      interval: 10s
      timeout: 5s
      retries: 6

  openbot:
    image: {image}
    container_name: {project}
    restart: "no"
    security_opt:
      - seccomp={host / 'seccomp.json'}
      - no-new-privileges:true
    ipc: "service:display"
    depends_on:
      display:
        condition: service_healthy
    environment:
      OPENBOT_EXTERNAL_DISPLAY: ":0"
      OPENBOT_STAGING: "1"
    env_file: [{env_file}]
    mem_limit: {s['memory']}
    pids_limit: 2048
    stop_grace_period: 30s
    volumes:
      - {merged}:/data
      - {host / 'providers'}:/opt/openbot-providers:ro
      - x11:/tmp/.X11-unix
    networks: [isolated]
{view_service}
volumes:
  x11:
    driver: local
    driver_opts: {{type: tmpfs, device: tmpfs, o: "mode=1777,size=16m"}}

networks:
  isolated:
    internal: true
"""


def staging_status():
    root, upper, _, merged = staging_paths()
    state = read_json(state_dir() / "staging.json")
    if not state:
        return {"up": False}
    running = docker("inspect", cfg()["staging"]["project"], "--format", "{{.State.Running}}", check=False)
    state["running"] = running.returncode == 0 and running.stdout.strip() == "true"
    state["mounted"] = os.path.ismount(merged)
    try:
        state["upperBytes"] = int(run(["du", "-sb", str(upper)], check=False).stdout.split()[0])
    except (IndexError, ValueError):
        pass
    return state


def staging_down(quiet=False):
    s = cfg()["staging"]
    root, upper, work, merged = staging_paths()
    compose = root / "compose.yaml"
    if compose.exists():
        docker("compose", "-f", str(compose), "down", "-v", "-t", "20", check=False, timeout=180)
    if os.path.ismount(merged):
        run(["umount", str(merged)], check=False)
    for path in (upper, work, merged):
        shutil.rmtree(path, ignore_errors=True)
    pins = read_json(state_dir() / "pins.json", {}) or {}
    pins.pop("staging", None)
    write_json(state_dir() / "pins.json", pins)
    (state_dir() / "staging.json").unlink(missing_ok=True)
    (root / "staging.env").unlink(missing_ok=True)
    if not quiet:
        say(f"staging {s['project']} removed")
    return {"up": False}


def staging_up(from_id=None, image=None, fresh_db=False, view=True, wait=True):
    c = cfg()
    s = c["staging"]
    if os.geteuid() != 0:
        raise Refused("staging up needs root (it mounts an overlay).", 403)
    with Lock():
        staging_down(quiet=True)
        snaps = [snap for snap in list_snapshots(include_failed=False)]
        snap = next((x for x in snaps if x["id"] == from_id), None) if from_id else (snaps[0] if snaps else None)
        if not snap:
            raise Refused("No backup to start a staging copy from; run a backup first.", 404)
        snap_dir = snapshot_path(snap["id"])
        if not (snap_dir / "files/data").is_dir():
            raise Refused("That backup has no files.", 409)
        image = image or compose_image()
        if not image:
            raise Refused("No image given and none found in the compose file.", 400)
        set_current("staging", snap["id"], "mount")
        pins = read_json(state_dir() / "pins.json", {}) or {}
        pins["staging"] = snap["id"]
        write_json(state_dir() / "pins.json", pins)
        root, upper, work, merged = staging_paths()
        for path in (root, upper, work, merged):
            path.mkdir(parents=True, exist_ok=True)
        os.chmod(root, 0o711)
        run(["mount", "-t", "overlay", "overlay", "-o",
             f"lowerdir={snap_dir / 'files/data'},upperdir={upper},workdir={work}", str(merged)])
        os.chown(merged, c["data_uid"], c["data_uid"])
        # Backups before the ownership fix made these as root, and OpenBot (the data owner) then could
        # not create a space the backup left out: the copy stopped at start with EACCES.
        for rel in ("OpenBot", "OpenBot/Spaces", "OpenBot/Spaces/index.json"):
            target = merged / rel
            if target.exists() and not target.is_symlink() and target.stat().st_uid == 0:
                os.chown(target, c["data_uid"], c["data_uid"])
        db = merged / ".config/OpenBot/openbot.db"
        try:
            if fresh_db:
                set_current("staging", snap["id"], "fresh database")
                sqlite_helper(["copy", str(Path(c["data_dir"]) / ".config/OpenBot/openbot.db"),
                               str(merged / ".config/OpenBot/.staging-fresh.db"), "projection_"], c["data_uid"])
                os.replace(merged / ".config/OpenBot/.staging-fresh.db", db)
            else:
                restore_db(snap_dir / snap["database"]["file"], db, c["data_uid"])
            for rel in STAGING_REMOVE:
                target = merged / rel
                if target.is_dir() and not target.is_symlink():
                    shutil.rmtree(target, ignore_errors=True)
                elif target.exists() or target.is_symlink():
                    target.unlink()
            provider_use = merged / ".config/OpenBot/openbot-provider-use-v1.json"
            provider_use.write_text(json.dumps({"version": 1, "off": PROVIDERS}))
            os.chown(provider_use, c["data_uid"], c["data_uid"])
            env = root / "staging.env"
            lines = []
            runtime = Path(c["host_dir"]) / ".env.runtime"
            if runtime.exists():
                for line in runtime.read_text().splitlines():
                    if line.startswith(("OPENBOT_REMOTE_SIGNAL_URL=", "OPENBOT_AUTH_API_URL=",
                                        "OPENBOT_MCP_REMOTE_CALLBACK_URL=")):
                        continue
                    lines.append(line)
            # Valid shapes that lead nowhere (.invalid never resolves; the network has no way out anyway).
            lines += ["OPENBOT_REMOTE_SIGNAL_URL=wss://signal.staging.invalid/", "OPENBOT_AUTH_API_URL=https://auth.staging.invalid"]
            env.write_text("\n".join(lines) + "\n")
            os.chmod(env, 0o600)
            if view and docker("image", "inspect", STAGING_VIEW_IMAGE, check=False).returncode:
                set_current("staging", snap["id"], "building the view image")
                docker("build", "-t", STAGING_VIEW_IMAGE, "-f",
                       str(Path(__file__).resolve().parent / "staging-view.Dockerfile"),
                       str(Path(__file__).resolve().parent), timeout=900)
            (root / "compose.yaml").write_text(staging_compose(image, env, merged, view))
            set_current("staging", snap["id"], "starting")
            docker("compose", "-f", str(root / "compose.yaml"), "up", "-d", timeout=300)
            state = {"up": True, "from": snap["id"], "image": image, "freshDb": fresh_db, "startedAt": now_iso(),
                     "view": f"http://127.0.0.1:{s['view_port']}/vnc.html" if view else None}
            write_json(state_dir() / "staging.json", state)
            if wait:
                state["status"] = wait_ready(s["project"], seconds=300).strip()
                info = sqlite_helper(["info", str(db), "projection_", "quick"], c["data_uid"], timeout=900)
                state["database"] = {"schema": info["schema"], "integrity": info["integrity"], "counts": info["counts"]}
                write_json(state_dir() / "staging.json", state)
            return state
        except Exception:
            clear_current()
            staging_down(quiet=True)
            raise
        finally:
            clear_current()


# ---- socket API -----------------------------------------------------------------------------------

def overview():
    c = cfg()
    snaps = list_snapshots()
    free, total = free_bytes(snapshots_dir() if snapshots_dir().exists() else ROOT)
    return {
        "backups": [{key: snap.get(key) for key in ("id", "createdAt", "finishedAt", "reason", "status", "bytes",
                                                     "newBytes", "schema", "image", "seconds", "error")}
                    | {"components": [{"name": item["name"], "status": item["status"],
                                       **({"reason": item["reason"]} if item.get("reason") else {})}
                                      for item in snap.get("components", [])],
                       "offsite": (snap.get("offsite") or {}).get("status")}
                    for snap in snaps[:40]],
        "running": running_job(),
        "lastRestore": read_json(state_dir() / "restore-last.json"),
        "nightly": c["nightly"],
        "retention": {"daily": c["keep_daily"], "weekly": c["keep_weekly"]},
        "disk": {"freeBytes": free, "totalBytes": total},
        "offsite": bool(offsite_settings()),
        "staging": read_json(state_dir() / "staging.json"),
    }


def spawn(args, unit):
    """Starts a job outside the service, so a restore survives the service and OpenBot stopping."""
    script = str(Path(__file__).resolve())
    if os.geteuid() == 0 and shutil.which("systemd-run"):
        run(["systemd-run", f"--unit={unit}-{int(time.time())}", "--collect", "--quiet",
             "--property=Nice=10", "--property=IOSchedulingClass=idle",
             f"--setenv=ATELIER_BACKUP_ROOT={ROOT}", sys.executable, "-I", script, *args])
    else:
        log = open(state_dir() / f"{unit}.log", "ab")
        subprocess.Popen([sys.executable, "-I", script, *args], stdout=log, stderr=log, start_new_session=True,
                         env={**os.environ, "ATELIER_BACKUP_ROOT": str(ROOT)})


def openbot_main_pids():
    """The host pids of OpenBot's Electron main process: a direct child of the container's init."""
    result = docker("inspect", cfg()["container"], "--format", "{{.State.Pid}}", check=False, timeout=20)
    try:
        init = int(result.stdout.strip())
    except ValueError:
        return set()
    pids = set()
    try:
        children = Path(f"/proc/{init}/task/{init}/children").read_text().split()
    except OSError:
        return pids
    for child in children:
        try:
            # Chromium rewrites its command line into one space-separated string.
            argv = Path(f"/proc/{child}/cmdline").read_bytes().replace(b"\0", b" ").split()
        except OSError:
            continue
        if argv and argv[0] == b"/opt/OpenBot/app/openbot" and not any(a.startswith(b"--type=") for a in argv):
            pids.add(int(child))
    return pids


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def address_string(self):
        return "unix"

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        if cfg()["peer_policy"] == "any":
            return True
        creds = self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid, _, _ = struct.unpack("3i", creds)
        return pid in openbot_main_pids()

    def handle_any(self):
        try:
            if not self.allowed():
                raise Refused("Only OpenBot's main process may use this socket.", 403)
            length = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            if not isinstance(body, dict):
                raise Refused("The body must be a JSON object.")
            self.reply(200, route(self.command, urllib.parse.urlsplit(self.path).path.strip("/").split("/"), body))
        except Refused as error:
            self.reply(error.status, {"error": str(error)})
        except Exception as error:  # noqa: BLE001
            traceback.print_exc()
            self.reply(500, {"error": f"internal error: {error}"})

    do_GET = do_POST = handle_any


def route(method, segs, body):
    if segs == ["v1", "overview"] and method == "GET":
        return overview()
    if segs == ["v1", "backups"] and method == "POST":
        if running_job():
            raise Refused("A backup or restore is already running.", 409)
        spawn(["run", "--reason", "manual"], "atelier-backup-manual")
        return {"started": True}
    if len(segs) == 4 and segs[:2] == ["v1", "backups"] and method == "POST":
        ident, action = segs[2], segs[3]
        spaces = body.get("spaces") is True
        if action == "check":
            return check(ident, spaces)
        if action == "restore":
            confirm = body.get("confirm")
            if confirm != ident:
                raise Refused("Type the backup name exactly to confirm the restore.")
            result = check(ident, spaces)
            if not result["ok"]:
                raise Refused("The restore check failed: " + " ".join(result["problems"]), 409)
            write_json(state_dir() / "restore-last.json", {"id": ident, "status": "starting", "startedAt": now_iso(),
                                                            "steps": []})
            spawn(["restore", ident, "--confirm", confirm, *(["--spaces"] if spaces else [])], "atelier-restore")
            return {"started": True}
    raise Refused("Not found.", 404)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve():
    client = ROOT / "client"
    client.mkdir(parents=True, exist_ok=True)
    os.chmod(client, 0o755)
    sock = client / "backupd.sock"
    sock.unlink(missing_ok=True)
    # Bound by a relative name: a long backup root would pass the 108-byte AF_UNIX limit.
    os.chdir(client)
    server = Server("backupd.sock", Handler)
    if os.geteuid() == 0:
        os.chown(sock, cfg()["data_uid"], cfg()["data_uid"])
    os.chmod(sock, 0o600)
    say(f"atelier backup broker listening on {sock}")
    server.serve_forever()


# ---- install --------------------------------------------------------------------------------------

SERVICE_UNIT = """[Unit]
Description=Atelier backup broker (socket API for Server settings > Backups)
After=docker.service
Requires=docker.service

[Service]
Environment=ATELIER_BACKUP_ROOT={root}
ExecStart=/usr/bin/python3 -I {script} serve
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""
RUN_UNIT = """[Unit]
Description=Atelier nightly backup
After=docker.service

[Service]
Type=oneshot
Environment=ATELIER_BACKUP_ROOT={root}
ExecStart=/usr/bin/python3 -I {script} run --reason nightly
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=6h
"""
TIMER_UNIT = """[Unit]
Description=Atelier nightly backup

[Timer]
OnCalendar=*-*-* {time}:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
"""


def install():
    if os.geteuid() != 0:
        sys.exit("install must run as root")
    here = Path(__file__).resolve().parent
    ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(ROOT, 0o711)
    for name in ("backupd.py", "staging-view.Dockerfile"):
        shutil.copy2(here / name, ROOT / name)
    # 0755: the SQLite helper runs as the owner of each database (uid 1000, Motion 10001).
    os.chmod(ROOT / "backupd.py", 0o755)
    if not (ROOT / "config.json").exists():
        write_json(ROOT / "config.json", {"keep_daily": 1, "keep_weekly": 0, "keep_manual": 1, "spaces": "all", "max_file_mb": 50,
                                          "min_free_gb": 20}, 0o600)
    script = ROOT / "backupd.py"
    units = Path("/etc/systemd/system")
    (units / "atelier-backup.service").write_text(SERVICE_UNIT.format(root=ROOT, script=script))
    (units / "atelier-backup-run.service").write_text(RUN_UNIT.format(root=ROOT, script=script))
    (units / "atelier-backup-run.timer").write_text(TIMER_UNIT.format(time=cfg()["nightly"]))
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", "atelier-backup.service", "atelier-backup-run.timer"], check=True)
    subprocess.run(["systemctl", "restart", "atelier-backup.service"], check=True)
    say(f"installed in {ROOT}. Add to the openbot service volumes in compose.yaml, then deploy:\n"
        f"      - {ROOT / 'client'}:/opt/backupctl:ro")


def main():
    global ROOT
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    if args[0] == "_sqlite":
        return sqlite_main(args[1:])

    def flag(name):
        if name in args:
            args.remove(name)
            return True
        return False

    def option(name, default=None):
        if name in args:
            index = args.index(name)
            value = args[index + 1]
            del args[index:index + 2]
            return value
        return default

    as_json = flag("--json")
    try:
        command = args[0]
        if command == "serve":
            serve()
        elif command == "install":
            install()
        elif command == "run":
            result = backup(reason=option("--reason", "manual"), spaces=not flag("--no-spaces"))
            print(json.dumps({k: result.get(k) for k in ("id", "status", "seconds", "bytes", "newBytes", "error")}))
            sys.exit(0 if result["status"] != "failed" else 1)
        elif command == "list":
            print(json.dumps(overview(), indent=2))
        elif command == "check":
            print(json.dumps(check(args[1], flag("--spaces")), indent=2))
        elif command == "restore":
            spaces = flag("--spaces")
            result = restore(args[1], option("--confirm"), spaces)
            print(json.dumps(result, indent=2))
            sys.exit(0 if result["status"] == "ok" else 1)
        elif command == "prune":
            with Lock():
                print(json.dumps(prune()))
        elif command == "offsite":
            print(json.dumps(offsite(args[1])))
        elif command == "staging":
            sub = args[1] if len(args) > 1 else "status"
            if sub == "up":
                result = staging_up(option("--from"), option("--image"), fresh_db=flag("--fresh-db"),
                                    view=not flag("--no-view"), wait=not flag("--no-wait"))
            elif sub == "down":
                with Lock():
                    result = staging_down()
            else:
                result = staging_status()
            print(json.dumps(result, indent=None if as_json else 2))
        else:
            sys.exit(__doc__)
    except Refused as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
