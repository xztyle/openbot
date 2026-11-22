# Allowlist CONNECT proxy for the staging copy. Only the Claude model API passes; every other host
# (Discord, Telegram, mail, Meta, GitHub, the OAuth token endpoints) is refused and logged.
import socket, threading, select, sys, time
ALLOW = {"api.anthropic.com"}
def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)
def pipe(a, b):
    try:
        while True:
            r, _, _ = select.select([a, b], [], [], 300)
            if not r: return
            for s in r:
                d = s.recv(65536)
                if not d: return
                (b if s is a else a).sendall(d)
    finally:
        a.close(); b.close()
def handle(c):
    try:
        head = b""
        while b"\r\n\r\n" not in head and len(head) < 16384:
            d = c.recv(4096)
            if not d: break
            head += d
        line = head.split(b"\r\n", 1)[0].decode("latin1")
        parts = line.split()
        if len(parts) < 2:
            c.close(); return
        method, target = parts[0], parts[1]
        host = target.split(":")[0] if method == "CONNECT" else target.split("/")[2].split(":")[0] if "://" in target else ""
        if method != "CONNECT" or host not in ALLOW:
            log(f"DENY {method} {target}")
            c.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); c.close(); return
        port = int(target.split(":")[1]) if ":" in target else 443
        if port != 443:
            log(f"DENY port {target}"); c.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n"); c.close(); return
        u = socket.create_connection((host, 443), timeout=30)
        log(f"ALLOW {target}")
        c.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
        pipe(c, u)
    except Exception as e:
        log(f"ERR {e}")
        try: c.close()
        except Exception: pass
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 3128)); s.listen(128)
log("listening")
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
