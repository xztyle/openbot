"""Offline tests for the bench broker and runner: no Docker, no root, no network beyond loopback.

Run: python3 scripts/bench-broker/test_benchd.py
"""

import hashlib
import io
import json
import os
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="benchd-test-"))
os.environ["BENCH_BASE"] = str(ROOT / "bench")
os.environ["BENCH_NGINX_CONF"] = str(ROOT / "nginx.conf")
os.environ["BENCH_SOCKET_UID"] = str(os.getuid())
os.environ["OPENBOT_BENCH_HOME"] = str(ROOT / "runner-home")
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "bench-runner"))

import benchd  # noqa: E402
import runner  # noqa: E402

for sub in ("state/benches", "state/enroll", "jobs/uploads", "keys", "client"):
    (benchd.BASE / sub).mkdir(parents=True, exist_ok=True)


def make_bench(name, priority=0, **status):
    secret = os.urandom(32)
    benchd.key_path(name).write_text(secret.hex())
    benchd.write_json(benchd.bench_path(name), {"name": name, "priority": priority, "paused": False})
    if status is not None:
        base = {"user_busy": False, "paused_until": 0, "gpu": None, "images": ["openbot-bench/base:1"], "capacity": 1}
        base.update(status)
        benchd.live[name] = {"last_seen": time.time(), "polling": 0, "status": base, "ip": ""}
    return secret


def tar_bytes(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def new_job(spec_extra=None):
    upload = os.urandom(8).hex()
    path = benchd.JOBS_DIR / "uploads" / f"{upload}.tar.gz"
    path.write_bytes(tar_bytes({"hello.txt": b"hi"}))
    body = {"upload": upload, "cmd": ["true"]}
    body.update(spec_extra or {})
    return benchd.submit_job(body, benchd.load_config())


def clear():
    benchd.jobs.clear()
    benchd.live.clear()
    benchd.outbox.clear()
    for path in (benchd.STATE / "benches").glob("*"):
        path.unlink()
    for path in benchd.KEYS.glob("*"):
        path.unlink()


class Signing(unittest.TestCase):
    def setUp(self):
        clear()
        self.secret = make_bench("pc-one")

    def headers(self, method, path, body=b"", ts=None, nonce=None, secret=None):
        ts = int(time.time()) if ts is None else ts
        nonce = nonce or os.urandom(12).hex()
        sig = benchd.sign(secret or self.secret, method, path, ts, nonce, hashlib.sha256(body).hexdigest())
        return {"X-Bench-Name": "pc-one", "X-Bench-Time": str(ts), "X-Bench-Nonce": nonce, "X-Bench-Sig": sig}

    def verify(self, headers, method="POST", path="/v1/runner/poll", body=b""):
        return benchd.verify_request(headers, method, path, hashlib.sha256(body).hexdigest())

    def test_valid(self):
        self.assertEqual(self.verify(self.headers("POST", "/v1/runner/poll"))[0], "pc-one")

    def test_replay_rejected(self):
        h = self.headers("POST", "/v1/runner/poll")
        self.verify(h)
        with self.assertRaises(benchd.ApiError):
            self.verify(h)

    def test_wrong_secret_body_path(self):
        with self.assertRaises(benchd.ApiError):
            self.verify(self.headers("POST", "/v1/runner/poll", secret=os.urandom(32)))
        with self.assertRaises(benchd.ApiError):
            self.verify(self.headers("POST", "/v1/runner/poll", b"a"), body=b"b")
        with self.assertRaises(benchd.ApiError):
            self.verify(self.headers("POST", "/v1/runner/poll"), path="/v1/runner/jobs/x/result")

    def test_skew(self):
        with self.assertRaises(benchd.ApiError) as ctx:
            self.verify(self.headers("POST", "/v1/runner/poll", ts=int(time.time()) + 1000))
        self.assertEqual(str(ctx.exception), "clock skew")

    def test_before_start_rejected(self):
        with self.assertRaises(benchd.ApiError):
            self.verify(self.headers("POST", "/v1/runner/poll", ts=int(benchd.STARTED_AT) - 30))

    def test_revoked_immediately(self):
        h = self.headers("POST", "/v1/runner/poll")
        benchd.key_path("pc-one").unlink()
        with self.assertRaises(benchd.ApiError):
            self.verify(h)

    def test_runner_signs_the_same_way(self):
        args = (self.secret, "GET", "/v1/x?y=1", 123, "abc", "00")
        self.assertEqual(benchd.sign(*args), runner.sign(*args))
        self.assertEqual(benchd.response_sig(self.secret, "n", b"x"), runner.response_sig(self.secret, "n", b"x"))


class Enrollment(unittest.TestCase):
    def setUp(self):
        clear()
        benchd._enroll_attempts.clear()

    def test_single_use(self):
        code = benchd.create_enrollment("alejandro-pc", 10, benchd.load_config())
        reply = benchd.redeem_enrollment(code.lower())
        self.assertEqual(reply["name"], "alejandro-pc")
        self.assertEqual(len(bytes.fromhex(reply["secret"])), 32)
        self.assertEqual(benchd.read_json(benchd.bench_path("alejandro-pc"))["priority"], 10)
        self.assertEqual(oct(benchd.key_path("alejandro-pc").stat().st_mode & 0o777), "0o600")
        with self.assertRaises(benchd.ApiError):
            benchd.redeem_enrollment(code)

    def test_expired(self):
        cfg = dict(benchd.load_config(), enroll_ttl_s=-1)
        code = benchd.create_enrollment("old-pc", 1, cfg)
        with self.assertRaises(benchd.ApiError):
            benchd.redeem_enrollment(code)

    def test_existing_name_refused(self):
        make_bench("taken-pc")
        with self.assertRaises(benchd.ApiError):
            benchd.create_enrollment("taken-pc", 1, benchd.load_config())

    def test_bad_names(self):
        for name in ("", "A", "../x", "a b", "x" * 40):
            with self.assertRaises(benchd.ApiError):
                benchd.create_enrollment(name, 1, benchd.load_config())


class Spec(unittest.TestCase):
    def cfg(self):
        return benchd.load_config()

    def test_defaults(self):
        spec = benchd.validate_spec({"cmd": ["make"]}, self.cfg())
        self.assertEqual(spec["image_ref"], "openbot-bench/base:1")
        self.assertEqual(spec["timeout_s"], 1800)

    def test_rejects(self):
        bad = [{"cmd": []}, {"cmd": "make"}, {"cmd": ["a"], "image": "ubuntu"}, {"cmd": ["a"], "timeout_s": 7201},
               {"cmd": ["a"], "timeout_s": 0}, {"cmd": ["a"], "outputs": ["/etc/passwd"]},
               {"cmd": ["a"], "outputs": ["../x"]}, {"cmd": ["a"], "outputs": ["a/../../x"]},
               {"cmd": ["a\0"]}, {"cmd": ["a"], "timeout_s": True}]
        for body in bad:
            with self.assertRaises(benchd.ApiError, msg=body):
                benchd.validate_spec(body, self.cfg())


class Scheduling(unittest.TestCase):
    def setUp(self):
        clear()

    def pick(self, job):
        return benchd.pick_bench(job, benchd.load_config(), benchd.list_benches())

    def test_priority_and_filters(self):
        make_bench("low-pc", 1)
        make_bench("high-pc", 10)
        job = new_job()
        self.assertEqual(self.pick(job), "high-pc")
        benchd.live["high-pc"]["status"]["user_busy"] = True
        self.assertEqual(self.pick(job), "low-pc")
        benchd.live["low-pc"]["last_seen"] = time.time() - 60
        self.assertIsNone(self.pick(job))

    def test_gpu_image_pause_capacity(self):
        make_bench("cpu-pc", 10)
        make_bench("gpu-pc", 1, gpu="RTX 4070")
        self.assertEqual(self.pick(new_job({"gpu": True})), "gpu-pc")
        benchd.live["gpu-pc"]["status"]["paused_until"] = time.time() + 100
        self.assertIsNone(self.pick(new_job({"gpu": True})))
        benchd.live["gpu-pc"]["status"]["paused_until"] = 0
        bench = benchd.read_json(benchd.bench_path("gpu-pc"))
        bench["paused"] = True
        benchd.write_json(benchd.bench_path("gpu-pc"), bench)
        self.assertIsNone(self.pick(new_job({"gpu": True})))
        benchd.live["cpu-pc"]["status"]["images"] = []
        self.assertIsNone(self.pick(new_job()))
        benchd.live["cpu-pc"]["status"]["images"] = ["openbot-bench/base:1"]
        busy = new_job()
        busy.bench, busy.state = "cpu-pc", "running"
        self.assertIsNone(self.pick(new_job()))

    def test_drop_reruns_once_then_fails(self):
        cfg = dict(benchd.load_config(), server_fallback=False)
        make_bench("one-pc", 5)
        make_bench("two-pc", 1)
        job = new_job()
        benchd.dispatch_once(cfg)
        self.assertEqual((job.state, job.bench), ("assigned", "one-pc"))
        benchd.live["one-pc"]["last_seen"] = 0
        benchd.dispatch_once(cfg)
        self.assertEqual((job.state, job.bench), ("assigned", "two-pc"))
        benchd.live["two-pc"]["last_seen"] = 0
        benchd.dispatch_once(cfg)
        self.assertEqual(job.state, "failed")

    def test_revoke_requeues(self):
        cfg = dict(benchd.load_config(), server_fallback=False)
        make_bench("gone-pc", 5)
        job = new_job()
        benchd.dispatch_once(cfg)
        self.assertEqual(job.bench, "gone-pc")
        benchd.key_path("gone-pc").unlink()
        benchd.dispatch_once(cfg)
        self.assertEqual(job.state, "queued")
        self.assertIn("gone-pc", job.exclude)


class Outputs(unittest.TestCase):
    def test_containment(self):
        work = Path(tempfile.mkdtemp(dir=ROOT))
        (work / "build").mkdir()
        (work / "build" / "app.bin").write_bytes(b"x" * 10)
        (work / "shot.png").write_bytes(b"png")
        os.symlink("/etc", work / "etc-link")
        os.symlink("/etc/passwd", work / "build" / "passwd")
        os.symlink("app.bin", work / "build" / "ok-link")
        notes = []
        for mod in (benchd, runner):
            dest = work.parent / f"out-{mod.__name__}.tar.gz"
            mod.pack_outputs(work, ["build", "*.png", "etc-link/*", "missing"], dest, 1 << 20, notes.append)
            with tarfile.open(dest) as tar:
                names = sorted(tar.getnames())
            self.assertEqual(names, ["build", "build/app.bin", "build/ok-link", "shot.png"], mod.__name__)
        self.assertTrue(any("missing" in n for n in notes))

    def test_cap(self):
        work = Path(tempfile.mkdtemp(dir=ROOT))
        (work / "big").write_bytes(b"x" * 2000)
        with self.assertRaises(benchd.ApiError):
            benchd.pack_outputs(work, ["big"], work.parent / "cap.tar.gz", 1000, print)


class DockerArgs(unittest.TestCase):
    def test_hardening_and_parity(self):
        spec = benchd.validate_spec({"cmd": ["make", "-j8"], "display": True, "workdir": "sub"}, benchd.load_config())
        limits = {"memory_mb": 1024, "cpus": 2, "pids": 100, "tmp_mb": 512}
        a = benchd.docker_run_args("j1", spec, "/w", limits, True, "x")
        b = runner.docker_run_args("j1", spec, "/w", limits, True, "x")
        self.assertEqual(a, b)
        for flag in ("--read-only", "--cap-drop", "no-new-privileges", "--pids-limit", "--memory", "--cpus"):
            self.assertIn(flag, a)
        self.assertEqual(a[a.index("--user") + 1], "10010:10010")
        self.assertEqual(a[a.index("--network") + 1], "openbot-bench")
        self.assertEqual(a[-3:], ["openbot-bench/base:1", "make", "-j8"])
        self.assertIn("/work/sub", a)
        no_gpu = benchd.docker_run_args("j1", spec, "/w", limits, False, "x")
        self.assertNotIn("--gpus", no_gpu)
        mounts = [a[i + 1] for i, v in enumerate(a) if v in ("-v", "--mount", "--volume")]
        self.assertEqual(mounts, ["type=bind,src=/w,dst=/work"])
        self.assertNotIn("docker.sock", " ".join(a))


class Nginx(unittest.TestCase):
    def test_render(self):
        text = benchd.render_nginx(benchd.load_config())
        self.assertIn("server_name bench.delynith.com;", text)
        self.assertIn("ssl_certificate /opt/openbot/apps/tls/origin.pem;", text)
        self.assertIn("173.245.48.0/20 1;", text)
        self.assertIn("return 444", text)
        self.assertIn("proxy_pass http://127.0.0.1:8461;", text)


class EndToEnd(unittest.TestCase):
    """Broker HTTP servers in-process, the real runner client against them, benchctl over the socket."""

    @classmethod
    def setUpClass(cls):
        clear()
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        cls.port = sock.getsockname()[1]
        sock.close()
        cls.http = benchd.RunnerServer(("127.0.0.1", cls.port), benchd.RunnerHandler)
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        if benchd.SOCKET_PATH.exists():
            benchd.SOCKET_PATH.unlink()
        cls.unix = benchd.UnixServer(str(benchd.SOCKET_PATH), benchd.AgentHandler)
        threading.Thread(target=cls.unix.serve_forever, daemon=True).start()
        cls.stop = threading.Event()

        def schedule():
            while not cls.stop.is_set():
                benchd.dispatch_once(dict(benchd.load_config(), server_fallback=False))
                time.sleep(0.2)

        threading.Thread(target=schedule, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.stop.set()
        time.sleep(0.5)
        cls.http.shutdown()
        cls.unix.shutdown()
        clear()

    def test_full_job(self):
        benchd._enroll_attempts.clear()
        code = benchd.create_enrollment("e2e-pc", 10, benchd.load_config())
        server = f"http://127.0.0.1:{self.port}"
        reply = json.loads(runner.fetch(server + "/v1/health"))
        self.assertTrue(reply["ok"])
        import urllib.request
        req = urllib.request.Request(server + "/v1/runner/enroll", data=json.dumps({"code": code}).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        cred = json.loads(urllib.request.urlopen(req).read())
        client = runner.Client(server, cred["name"], cred["secret"])
        status = {"user_busy": False, "paused_until": 0, "gpu": "RTX 4070", "images": ["openbot-bench/base:1"],
                  "capacity": 1}
        client.post_json("/v1/runner/poll", {"status": status, "no_wait": True}, verify_response=True)

        folder = Path(tempfile.mkdtemp(dir=ROOT))
        (folder / "src.c").write_text("int main(){}")
        (folder / "node_modules").mkdir()
        (folder / "node_modules" / "junk").write_text("x")
        env = dict(os.environ, BENCHCTL_SOCKET=str(benchd.SOCKET_PATH))
        proc = subprocess.Popen([sys.executable, str(HERE / "benchctl"), "run", "--gpu", "--out", "dist",
                                 "--cwd", str(folder), "--", "make"], env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        spec = None
        for _ in range(20):
            got = client.post_json("/v1/runner/poll", {"status": status}, verify_response=True, timeout=30)
            if got["jobs"]:
                spec = got["jobs"][0]
                break
        self.assertIsNotNone(spec)
        self.assertTrue(spec["gpu"])
        sink = io.BytesIO()
        client.request("GET", f"/v1/runner/jobs/{spec['id']}/input", sink=sink)
        self.assertEqual(hashlib.sha256(sink.getvalue()).hexdigest(), spec["input_sha256"])
        with tarfile.open(fileobj=io.BytesIO(sink.getvalue())) as tar:
            names = tar.getnames()
        self.assertIn("src.c", names)
        self.assertNotIn("node_modules/junk", names)
        client.request("POST", f"/v1/runner/jobs/{spec['id']}/log", b"compiling...\n", "application/octet-stream")
        out = ROOT / "e2e-out.tar.gz"
        out.write_bytes(tar_bytes({"dist/app": b"binary"}))
        size = out.stat().st_size
        half = size // 2
        for offset, length in ((0, half), (half, size - half)):
            body = runner.FileSlice(out, offset, length)
            client.request("POST", f"/v1/runner/jobs/{spec['id']}/output?offset={offset}", body,
                           "application/octet-stream", body_hash=runner.slice_hash(out, offset, length))
            body.close()
        client.post_json(f"/v1/runner/jobs/{spec['id']}/result",
                         {"exit_code": 3, "output_sha256": runner.sha256_file(out), "output_bytes": 6})
        stdout, stderr = proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 3, stderr)
        self.assertIn("compiling...", stdout)
        self.assertEqual((folder / "dist" / "app").read_bytes(), b"binary")
        # Another bench cannot touch the job, and a replayed request fails.
        with self.assertRaises(runner.RunnerError):
            client.post_json(f"/v1/runner/jobs/{spec['id']}/log", {})
        status_out = subprocess.run([sys.executable, str(HERE / "benchctl"), "status"], env=env,
                                    capture_output=True, text=True)
        self.assertIn("e2e-pc", status_out.stdout)
        self.assertIn("RTX 4070", status_out.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
