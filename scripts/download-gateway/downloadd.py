#!/usr/bin/env python3
"""OpenBot download gateway.

Streams one file per signed ticket over HTTP, for files too large for the WebRTC connection.
OpenBot (the host app) authorizes a member, resolves the file and mints a ticket; this service
trusts only a ticket with a valid signature, so it can never serve a path that OpenBot did not name.

Token: base64url(payload) + "." + base64url(HMAC-SHA256(key, base64url(payload))).
Payload JSON: {"v": 1, "p": "<path as OpenBot sees it>", "n": "<file name>", "e": <expiry, epoch ms>}.
The key file is the one OpenBot made (`download-ticket.key` in its profile). Keep this in step with
`src/main/download-tickets.ts` in the product repo; the shared test vector guards the two.

Subcommands: serve | install
Python standard library only.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# The product writes `/data/...` paths; on this host the container's /data is DATA_HOST.
CONTAINER_PREFIX = os.environ.get("DL_CONTAINER_PREFIX", "/data")
DATA_HOST = Path(os.environ.get("DL_DATA_HOST", "/opt/openbot/data"))
# Only files below this folder, as OpenBot sees it, are served. Never the profile (`.config`).
ALLOWED = os.environ.get("DL_ALLOWED_PREFIX", "/data/OpenBot/")
KEY_PATH = Path(os.environ.get("DL_KEY_PATH", str(DATA_HOST / ".config/OpenBot/download-ticket.key")))
LISTEN_HOST = os.environ.get("DL_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("DL_PORT", "8451"))
MAX_CONNECTIONS = int(os.environ.get("DL_MAX_CONNECTIONS", "16"))
MAX_TOKEN_CHARS = 8192
IDLE_TIMEOUT_S = 120

TOKEN_RE = re.compile(r"^/d/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$")
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def b64url_decode(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def now_ms():
    return int(time.time() * 1000)


class Refused(Exception):
    """Any refusal. The caller sends the same 404 for all of them so a probe learns nothing."""


def read_key():
    key = KEY_PATH.read_bytes()
    if len(key) < 32:
        raise Refused("key too short")
    return key


def verify(payload_b64, signature_b64, key, at_ms=None):
    expected = hmac.new(key, payload_b64.encode(), hashlib.sha256).digest()
    try:
        given = b64url_decode(signature_b64)
    except Exception as err:  # noqa: BLE001
        raise Refused("bad signature encoding") from err
    if not hmac.compare_digest(expected, given):
        raise Refused("bad signature")
    try:
        claims = json.loads(b64url_decode(payload_b64))
    except Exception as err:  # noqa: BLE001
        raise Refused("bad payload") from err
    if not isinstance(claims, dict) or claims.get("v") != 1:
        raise Refused("bad version")
    path, name, expiry = claims.get("p"), claims.get("n"), claims.get("e")
    if not isinstance(path, str) or not isinstance(name, str) or not isinstance(expiry, int):
        raise Refused("bad claims")
    if (at_ms if at_ms is not None else now_ms()) >= expiry:
        raise Refused("expired")
    return path, name


def resolve(path):
    """Maps a path as OpenBot sees it to a regular file on this host, below the allowed folder."""
    if "\x00" in path or not path.startswith(ALLOWED):
        raise Refused("outside the allowed folder")
    host = DATA_HOST / path[len(CONTAINER_PREFIX) :].lstrip("/")
    allowed_root = (DATA_HOST / ALLOWED[len(CONTAINER_PREFIX) :].strip("/")).resolve()
    try:
        real = host.resolve(strict=True)
    except OSError as err:
        raise Refused("missing") from err
    if real != allowed_root and allowed_root not in real.parents:
        raise Refused("escapes the allowed folder")
    return real


def parse_range(header, size):
    """Returns (start, end) inclusive, None for no range, or raises ValueError when unsatisfiable."""
    if not header:
        return None
    match = RANGE_RE.match(header.strip())
    if not match:
        return None  # Not a single byte range: serve the whole file, as the standard allows.
    first, last = match.groups()
    if first == "" and last == "":
        return None
    if first == "":
        length = int(last)
        if length == 0:
            raise ValueError("empty suffix")
        return max(0, size - length), size - 1
    start = int(first)
    end = size - 1 if last == "" else min(int(last), size - 1)
    if start >= size or start > end:
        raise ValueError("unsatisfiable")
    return start, end


def content_disposition(name):
    ascii_name = re.sub(r'[^A-Za-z0-9._ -]', "_", name)[:200] or "download"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name, safe='')}"


slots = threading.BoundedSemaphore(MAX_CONNECTIONS)


class Handler(BaseHTTPRequestHandler):
    server_version = "openbot-downloads"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = IDLE_TIMEOUT_S

    def log_message(self, fmt, *args):  # never the request line: it holds the ticket
        pass

    def refuse(self, status=404):
        body = b""
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        self.log(status, 0, "-")

    def log(self, status, sent, name):
        who = self.headers.get("X-Real-IP") or self.client_address[0]
        print(f"{time.strftime('%H:%M:%S')} {who} {self.command} {status} {sent}B {name}", flush=True)

    def do_HEAD(self):
        self.serve(send_body=False)

    def do_GET(self):
        self.serve(send_body=True)

    def serve(self, send_body):
        match = TOKEN_RE.match(urllib.parse.urlsplit(self.path).path)
        if not match or len(self.path) > MAX_TOKEN_CHARS:
            return self.refuse()
        if not slots.acquire(blocking=False):
            return self.refuse(503)
        try:
            try:
                path, name = verify(match.group(1), match.group(2), read_key())
                real = resolve(path)
                fd = os.open(real, os.O_RDONLY | os.O_NOFOLLOW)
            except (Refused, OSError):
                return self.refuse()
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    return self.refuse()
                size = info.st_size
                etag = f'"{size:x}-{info.st_mtime_ns:x}"'
                span = None
                header = self.headers.get("Range")
                if_range = self.headers.get("If-Range")
                if header and (not if_range or if_range == etag):
                    try:
                        span = parse_range(header, size)
                    except ValueError:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        self.log(416, 0, real.name)
                        return None
                start, end = span if span else (0, size - 1)
                length = 0 if size == 0 else end - start + 1
                self.send_response(206 if span else 200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                if span:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("ETag", etag)
                self.send_header("Last-Modified", formatdate(info.st_mtime, usegmt=True))
                self.send_header("Content-Disposition", content_disposition(name))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                sent = 0
                if send_body and length:
                    with os.fdopen(os.dup(fd), "rb", buffering=0) as handle:
                        try:
                            sent = self.connection.sendfile(handle, start, length) or 0
                        except (BrokenPipeError, ConnectionResetError, socket.timeout, TimeoutError):
                            sent = -1
                self.log(206 if span else 200, max(sent, 0), real.name)
                if sent < 0:
                    self.close_connection = True
                return None
            finally:
                os.close(fd)
        finally:
            slots.release()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64


def serve():
    read_key()  # Fail at start, not at the first request, when the key file is missing.
    server = Server((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"openbot download gateway on {LISTEN_HOST}:{LISTEN_PORT}, serving {ALLOWED}", flush=True)
    server.serve_forever()


UNIT = """[Unit]
Description=OpenBot download gateway
After=network.target

[Service]
User=ubuntu
ExecStart=/usr/bin/python3 -I {script} serve
Restart=always
RestartSec=3
NoNewPrivileges=true
CapabilityBoundingSet=
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_UNIX
MemoryMax=512M
TasksMax=128
# The service sees only the OpenBot data folder and the key, read-only. Nothing else of the install.
TemporaryFileSystem=/opt/openbot:ro
BindReadOnlyPaths=/opt/openbot/data/OpenBot /opt/openbot/data/.config/OpenBot/download-ticket.key

[Install]
WantedBy=multi-user.target
"""


def ensure_key():
    """The same file OpenBot would make on first use, so the unit can bind it before OpenBot runs."""
    if KEY_PATH.exists() and KEY_PATH.stat().st_size >= 32:
        return
    KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(os.urandom(32))
    owner = KEY_PATH.parent.stat()
    os.chown(KEY_PATH, owner.st_uid, owner.st_gid)


def install():
    if os.geteuid() != 0:
        sys.exit("install must run as root")
    ensure_key()
    here = Path(__file__).resolve().parent
    # Outside /opt/openbot: the unit hides that folder from the service except what it binds.
    target = Path("/usr/local/lib/openbot-downloads")
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(here / "downloadd.py", target / "downloadd.py")
    os.chmod(target / "downloadd.py", 0o755)
    Path("/etc/systemd/system/openbot-downloads.service").write_text(UNIT.format(script=target / "downloadd.py"))
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "openbot-downloads.service"], check=True)
    subprocess.run(["systemctl", "restart", "openbot-downloads.service"], check=True)
    print("installed; gateway restarted")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "serve":
        serve()
    elif command == "install":
        install()
    else:
        sys.exit(__doc__)
