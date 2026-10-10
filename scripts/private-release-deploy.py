#!/usr/bin/env python3
"""Deploy prebuilt host and Worker artifacts to the existing private VPS."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time

BASE = Path("/opt/openbot")
RELEASE = Path(sys.argv[1]).resolve()
LOGS = RELEASE / "logs"
LOGS.mkdir(mode=0o700, exist_ok=True)
TIMES = {}
ENV = os.environ.copy()
ENV.pop("CLOUDFLARE_API_TOKEN", None)
ENV.update(PATH=f"{BASE}/build-tools/node/bin:{BASE}/build-tools:/usr/bin:/bin",
           XDG_CONFIG_HOME=str(BASE / "cloudflare-config"), WRANGLER_SEND_METRICS="false")


def run(command, name, cwd=None):
    start = time.monotonic()
    with (LOGS / f"{name}.log").open("wb") as log:
        result = subprocess.run(command, cwd=cwd, env=ENV, stdout=log, stderr=subprocess.STDOUT)
    TIMES[name] = round(time.monotonic() - start, 3)
    if result.returncode:
        raise RuntimeError(f"{name} failed. Details stay in {LOGS / (name + '.log')}")
    return (LOGS / f"{name}.log").read_text(errors="replace")


def docker(*args, name="docker"):
    return run(["sudo", "docker", *args], name).strip()


def database_state(path):
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    counts = {name: connection.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
              for name in names if name.startswith("projection_")}
    active = connection.execute("SELECT COUNT(*) FROM projection_threads WHERE active_turn_id IS NOT NULL").fetchone()[0]
    pending = connection.execute("SELECT COUNT(*) FROM projection_deliveries WHERE status IN ('queued','running','pending')").fetchone()[0]
    schema = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
    integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
    foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
    connection.close()
    return dict(schema=schema, counts=counts, active=active, pending=pending,
                integrity=integrity, foreign_key_violations=len(foreign_keys))


def probe_ready(container, name, online=False):
    start = time.monotonic()
    for _ in range(30):
        state = docker("inspect", container, "--format", "{{.State.Running}}", name=f"{name}-running")
        if state != "true":
            raise RuntimeError(f"{container} exited during startup.")
        result = subprocess.run(["sudo", "docker", "exec", container, "curl", "--fail", "--silent",
                                 "--max-time", "2", "--unix-socket", "/run/openbot/control.sock",
                                 "http://openbot/v1/status"], env=ENV, capture_output=True)
        if result.returncode == 0:
            status = result.stdout.decode()
            if not online or ("account=signed_in" in status and "server=online" in status):
                TIMES[name] = round(time.monotonic() - start, 3)
                return status
        time.sleep(2)
    raise RuntimeError(f"{container} did not become ready.")


def smoke_test(image):
    data = RELEASE / "smoke-data"
    data.mkdir(mode=0o700, exist_ok=True)
    run(["sudo", "chown", "1000:1000", str(data)], "smoke-owner")
    container = "openbot-release-smoke-" + REVISION[:12]
    docker("run", "-d", "--name", container, "--network", "none", "--memory", "3g",
           "--security-opt", f"seccomp={BASE}/seccomp.json", "--security-opt", "no-new-privileges:true",
           "--shm-size", "1g", "-v", f"{data}:/data", image, name="smoke-start")
    try:
        probe_ready(container, "smoke-ready")
        state = database_state(data / ".config/OpenBot/openbot.db")
        if state["integrity"] != "ok" or state["foreign_key_violations"]:
            raise RuntimeError("The isolated database check failed.")
        return state["schema"]
    finally:
        docker("logs", container, name="smoke-output")
        docker("stop", "-t", "30", container, name="smoke-stop")
        docker("rm", container, name="smoke-remove")


def prepare_worker():
    path = RELEASE / "worker/dist/server/wrangler.json"
    config = json.loads(path.read_text())
    if config.get("name") != "delynith-openbot" or not config.get("no_bundle"):
        raise RuntimeError("Expected a prebuilt private Worker; refusing a public or source deployment.")
    config.pop("build", None)
    for binding in config.get("d1_databases", []):
        binding["migrations_dir"] = str(RELEASE / "worker/migrations")
    account = config.get("account_id")
    if account:
        ENV["CLOUDFLARE_ACCOUNT_ID"] = account
    target = path.with_name("wrangler.deploy.json")
    target.write_text(json.dumps(config))
    return target, config["d1_databases"][0]["database_name"]


def deploy_worker():
    config, database = prepare_worker()
    cli = BASE / "source/node_modules/.bin/wrangler"
    common = [str(cli), "--config", str(config)]
    run([*common, "d1", "migrations", "apply", database, "--remote"], "worker-migrations", RELEASE)
    output = run([*common, "deploy", "--no-bundle"], "worker-upload", RELEASE)
    match = re.search(r"Current Version ID: ([a-f0-9-]+)", output)
    if not match:
        raise RuntimeError("Worker upload did not report a deployed version.")
    return match.group(1)


def deploy_host(image):
    compose = BASE / "compose.yaml"
    previous = compose.read_text()
    updated, count = re.subn(r"openbot-private:[a-zA-Z0-9.-]+", image, previous)
    if count != 1:
        raise RuntimeError("Expected exactly one host image in the private compose file.")
    shutil.copy2(compose, RELEASE / "compose-before.yaml")
    compose.write_text(updated)
    docker("compose", "-f", str(compose), "up", "-d", "--no-deps", "--force-recreate", "openbot",
           name="host-replace")
    probe_ready("openbot", "host-ready", online=True)


def validate_after(before, expected_schema, environment_hash):
    after = database_state(BASE / "data/.config/OpenBot/openbot.db")
    if after["schema"] != expected_schema or after["integrity"] != "ok" or after["foreign_key_violations"]:
        raise RuntimeError("The saved database verification failed; do not downgrade its schema.")
    for name, count in before["counts"].items():
        if after["counts"].get(name, 0) < count:
            raise RuntimeError(f"Saved row count fell for {name}; investigate before further deployments.")
    if hashlib.sha256((BASE / ".env.runtime").read_bytes()).hexdigest() != environment_hash:
        raise RuntimeError("The runtime settings changed unexpectedly.")
    return after


def main():
    started = time.monotonic()
    if "--worker-only" in sys.argv[2:]:
        # Website and Worker only: the host is not touched, so no idle check and no restart.
        worker = deploy_worker()
        (RELEASE / "worker-deployment.json").write_text(
            json.dumps(dict(revision=REVISION, worker=worker, phases_seconds=TIMES), indent=2))
        print(json.dumps(dict(worker=worker, deploy_seconds=round(time.monotonic() - started, 3), host_touched=False)))
        return
    before = database_state(BASE / "data/.config/OpenBot/openbot.db")
    (RELEASE / "before.json").write_text(json.dumps(before, indent=2))
    if before["active"] or before["pending"]:
        raise RuntimeError("A bot has active or queued work. Deployment stops before interrupting it.")
    environment_hash = hashlib.sha256((BASE / ".env.runtime").read_bytes()).hexdigest()
    if "--existing-image" not in sys.argv[2:]:
        run(["sha256sum", "-c", "image.sha256"], "checksum", RELEASE)
        docker("load", "-i", str(RELEASE / "image.tar.gz"), name="image-load")
    arch = docker("image", "inspect", IMAGE, "--format", "{{.Architecture}}", name="architecture")
    revision = docker("image", "inspect", IMAGE, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}', name="revision")
    if arch != "amd64" or revision != REVISION:
        raise RuntimeError("Image architecture or revision does not match this release.")
    expected_schema = smoke_test(IMAGE)
    worker = deploy_worker()
    current = database_state(BASE / "data/.config/OpenBot/openbot.db")
    if current["active"] or current["pending"]:
        raise RuntimeError("A bot started working while artifacts uploaded. Host restart deferred.")
    deploy_host(IMAGE)
    after = validate_after(before, expected_schema, environment_hash)
    report = dict(revision=REVISION, image=IMAGE, worker=worker, before=before, after=after,
                  phases_seconds=TIMES, deploy_seconds=round(time.monotonic() - started, 3), compiled_during_deployment=False)
    (RELEASE / "deployment.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(dict(image=IMAGE, worker=worker, schema=after["schema"],
                          deploy_seconds=report["deploy_seconds"], saved_data_verified=True)))


REVISION = (RELEASE / "revision.txt").read_text().strip()
IMAGE = (RELEASE / "image.txt").read_text().strip()
if not re.fullmatch(r"[a-f0-9]{40}", REVISION) or not re.fullmatch(r"openbot-private:[a-zA-Z0-9.-]+", IMAGE):
    raise SystemExit("Invalid release metadata.")
try:
    main()
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
