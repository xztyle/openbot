"""Offline tests for the apps broker: no Docker, no root, no network.

Run: python3 scripts/apps-broker/test_appsd.py
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="appsd-test-"))
os.environ["APPS_BASE"] = str(ROOT / "apps")
os.environ["APPS_DATA_ROOT"] = str(ROOT / "data" / "OpenBot")
os.environ["APPS_BACKUPS"] = str(ROOT / "backups")
os.environ["APPS_NGINX_CONF"] = str(ROOT / "nginx.conf")
os.environ["APPS_CF_TOKEN_FILE"] = str(ROOT / "cloudflare-dns.env")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import appsd  # noqa: E402


def make_app(name, **extra):
    app = {"name": name, "port": 3000, "host_port": 20001, "memory_mb": 512, "cpus": 1.0, "dbs": [], "events": []}
    app.update(extra)
    appsd.write_json(appsd.app_path(name), app)
    return app


class Names(unittest.TestCase):
    def test_valid(self):
        for name in ("hello", "my-app", "a1b", "todo-list-2"):
            appsd.check_name(name)

    def test_invalid(self):
        for name in ("", "ab", "Hello", "-bad", "bad-", "has_underscore", "x" * 40, "../etc", "a.b", "1abc"):
            with self.assertRaises(appsd.ApiError, msg=name):
                appsd.check_name(name)

    def test_reserved(self):
        with self.assertRaises(appsd.ApiError):
            appsd.check_name("admin")


class Source(unittest.TestCase):
    def setUp(self):
        self.data = Path(os.environ["APPS_DATA_ROOT"])
        self.data.mkdir(parents=True, exist_ok=True)
        shared = self.data / "Shared" / "apps" / "hello"
        shared.mkdir(parents=True, exist_ok=True)
        (shared / "Dockerfile").write_text("FROM scratch\n")

    def test_default_location(self):
        real = appsd.resolve_source("hello", None)
        self.assertEqual(real.name, "hello")

    def test_explicit_container_path(self):
        real = appsd.resolve_source("hello", "/data/OpenBot/Shared/apps/hello")
        self.assertTrue((real / "Dockerfile").is_file())

    def test_outside_tree(self):
        with self.assertRaises(appsd.ApiError):
            appsd.resolve_source("hello", "/etc")
        with self.assertRaises(appsd.ApiError):
            appsd.resolve_source("hello", "/data/.config/OpenBot")

    def test_traversal(self):
        with self.assertRaises(appsd.ApiError):
            appsd.resolve_source("hello", "/data/OpenBot/../.config")

    def test_symlink_escape(self):
        link = self.data / "Shared" / "apps" / "evil"
        if not link.exists():
            link.symlink_to("/etc")
        with self.assertRaises(appsd.ApiError):
            appsd.resolve_source("evil", None)

    def test_missing_dockerfile(self):
        empty = self.data / "Shared" / "apps" / "empty"
        empty.mkdir(parents=True, exist_ok=True)
        with self.assertRaises(appsd.ApiError):
            appsd.resolve_source("empty", None)

    def test_snapshot_keeps_symlinks_unfollowed(self):
        src = self.data / "Shared" / "apps" / "snap"
        src.mkdir(parents=True, exist_ok=True)
        (src / "Dockerfile").write_text("FROM scratch\n")
        (src / "leak").symlink_to("/etc/passwd")
        (src / ".git").mkdir(exist_ok=True)
        target = appsd.snapshot_source(src.resolve(), "snap")
        self.assertTrue((target / "leak").is_symlink())
        self.assertFalse((target / ".git").exists())


class Env(unittest.TestCase):
    def setUp(self):
        make_app("envapp")

    def test_plain_value(self):
        result = appsd.env_set("envapp", {"LOG_LEVEL": "debug"})
        self.assertIn("LOG_LEVEL", result["names"])

    def test_secret_names_are_user_only(self):
        for key in ("API_KEY", "STRIPE_SECRET", "DB_PASSWORD", "GITHUB_TOKEN", "SESSION_COOKIE"):
            with self.assertRaises(appsd.ApiError, msg=key):
                appsd.env_set("envapp", {key: "x"})

    def test_admin_may_set_secret(self):
        appsd.env_set("envapp", {"API_KEY": "abc"}, admin=True)
        self.assertIn("API_KEY", appsd.env_list("envapp")["names"])
        with self.assertRaises(appsd.ApiError):
            appsd.env_unset("envapp", "API_KEY")

    def test_reserved_and_invalid(self):
        for key in ("PORT", "DATABASE_URL", "OPENBOT_X", "lower", "A-B"):
            with self.assertRaises(appsd.ApiError, msg=key):
                appsd.env_set("envapp", {key: "x"})

    def test_multiline_rejected(self):
        with self.assertRaises(appsd.ApiError):
            appsd.env_set("envapp", {"NOTE": "a\nb"})

    def test_values_never_listed(self):
        appsd.env_set("envapp", {"MODE": "secret-looking-value"})
        self.assertNotIn("secret-looking-value", json.dumps(appsd.env_list("envapp")))
        status_like = json.dumps({"names": appsd.env_list("envapp")["names"]})
        self.assertNotIn("secret-looking-value", status_like)


class Nginx(unittest.TestCase):
    def test_render(self):
        make_app("shop", host_port=20007)
        cfg = dict(appsd.DEFAULT_CONFIG, domain="apps.example.com")
        text = appsd.render_nginx(cfg)
        self.assertIn('"shop.apps.example.com" 20007;', text)
        self.assertIn("server_name *.apps.example.com;", text)
        self.assertIn("geo $realip_remote_addr $openbot_apps_allowed", text)
        self.assertIn("return 444", text)
        self.assertNotIn("ssl_certificate", text)

    def test_tls(self):
        cfg = dict(appsd.DEFAULT_CONFIG, tls_cert="/c.pem", tls_key="/k.pem")
        self.assertIn("listen 443 ssl;", appsd.render_nginx(cfg))


class Databases(unittest.TestCase):
    def test_urls(self):
        appsd.write_json(appsd.db_path("main-db"), {"name": "main-db", "engine": "postgres", "password": "pw1"})
        appsd.write_json(appsd.db_path("cache"), {"name": "cache", "engine": "redis", "password": "pw2"})
        app = make_app("dbapp", dbs=["main-db", "cache"])
        urls = appsd.db_urls(app)
        self.assertEqual(urls["DATABASE_URL"], "postgres://app:pw1@db-main-db:5432/app")
        self.assertEqual(urls["REDIS_URL"], "redis://:pw2@db-cache:6379")
        self.assertIn("DB_MAIN_DB_URL", urls)

    def test_runtime_env_file_is_private(self):
        app = make_app("runenv")
        path = appsd.write_runtime_env(app)
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        self.assertIn("PORT=3000", path.read_text())

    def test_engine_validation(self):
        with self.assertRaises(appsd.ApiError):
            appsd.create_db("mydb", "oracle")


class PublicPorts(unittest.TestCase):
    def write(self, public_ports):
        appsd.write_json(appsd.BASE / "config.json", {"public_ports": public_ports})

    def tearDown(self):
        (appsd.BASE / "config.json").unlink(missing_ok=True)

    def test_only_the_named_app_gets_its_mapping(self):
        self.write({"tts-gateway": [{"host_port": 8050, "container_port": 8443}]})
        self.assertEqual(appsd.public_mappings("tts-gateway"), [{"host_port": 8050, "container_port": 8443}])
        self.assertEqual(appsd.public_mappings("other-app"), [])

    def test_reserved_and_broker_ports_are_refused(self):
        for port in (22, 80, 443, 3478, 5349, 8081, 20001, 49160, 80000, 0, 1023):
            self.write({"tts-gateway": [{"host_port": port, "container_port": 8443}]})
            self.assertEqual(appsd.public_mappings("tts-gateway"), [], port)

    def test_a_port_belongs_to_one_app(self):
        self.write({
            "first-app": [{"host_port": 8050, "container_port": 1}],
            "second-app": [{"host_port": 8050, "container_port": 2}],
        })
        self.assertEqual(len(appsd.public_mappings("first-app")) + len(appsd.public_mappings("second-app")), 1)

    def test_malformed_entries_are_ignored(self):
        self.write({"tts-gateway": [{"host_port": "x"}, "nope", {"host_port": 8050}]})
        self.assertEqual(appsd.public_mappings("tts-gateway"), [])


class FakeCloudflare:
    def __init__(self, records):
        self.records = records
        self.calls = []

    def __call__(self, token, method, path, body=None, query=None):
        self.calls.append((method, path, body))
        if path == "/zones":
            return [{"id": "zone1"}]
        if method == "GET":
            return [r for r in self.records if r["name"] == query["name"]]
        if method == "POST":
            self.records.append({"id": f"r{len(self.records)}", **body})
            return {}
        if method == "DELETE":
            self.records = [r for r in self.records if r["id"] != path.rsplit("/", 1)[1]]
            return {}
        return {}


class PublicDns(unittest.TestCase):
    def setUp(self):
        self.real = appsd.cf_request
        appsd.CF_TOKEN_FILE.write_text("CLOUDFLARE_API_TOKEN=tok-very-secret\n")
        appsd.write_json(appsd.BASE / "config.json", {"domain": "example.com"})

    def tearDown(self):
        appsd.cf_request = self.real
        appsd.CF_TOKEN_FILE.unlink(missing_ok=True)
        (appsd.BASE / "config.json").unlink(missing_ok=True)

    def test_no_token_is_pending_and_sends_nothing(self):
        appsd.CF_TOKEN_FILE.unlink()
        appsd.cf_request = fake = FakeCloudflare([])
        self.assertEqual(appsd.sync_dns("web", make_app("web"))["state"], "pending")
        self.assertEqual(fake.calls, [])

    def test_publish_creates_a_marked_proxied_record(self):
        appsd.cf_request = fake = FakeCloudflare([])
        self.assertEqual(appsd.publish_state(make_app("web")["name"])["state"], "published")
        record = fake.records[0]
        self.assertEqual((record["name"], record["comment"], record["proxied"]), ("web.example.com", "openbot-apps:web", True))
        appsd.sync_dns("web", appsd.read_json(appsd.app_path("web")))
        self.assertEqual(len(fake.records), 1)
        self.assertNotIn("tok-very-secret", json.dumps(appsd.read_json(appsd.app_path("web"))))

    def test_foreign_records_are_never_changed(self):
        foreign = {"id": "x1", "name": "web.example.com", "type": "CNAME", "comment": None}
        appsd.cf_request = fake = FakeCloudflare([foreign])
        self.assertEqual(appsd.sync_dns("web", make_app("web"))["state"], "failed")
        self.assertEqual(appsd.sync_dns("web", None)["state"], "private")
        self.assertEqual(fake.records, [foreign])
        self.assertFalse([c for c in fake.calls if c[0] != "GET"])

    def test_private_and_deleted_apps_lose_only_their_record(self):
        ours = {"id": "o1", "name": "web.example.com", "type": "A", "comment": "openbot-apps:web"}
        appsd.cf_request = fake = FakeCloudflare([ours])
        appsd.sync_dns("web", make_app("web", private=True))
        self.assertEqual(fake.records, [])

    def test_legacy_private_apps_and_nginx(self):
        self.assertTrue(appsd.is_private({"name": "porttest"}))
        self.assertFalse(appsd.is_private({"name": "cakemaker-web"}))
        make_app("hidden-app", host_port=20009, private=True)
        self.assertNotIn("hidden-app", appsd.render_nginx(appsd.load_config()))


class Routes(unittest.TestCase):
    def test_unknown(self):
        with self.assertRaises(appsd.ApiError) as ctx:
            appsd.route("GET", ["nope"], {}, {})
        self.assertEqual(ctx.exception.status, 404)

    def test_missing_app(self):
        with self.assertRaises(appsd.ApiError) as ctx:
            appsd.route("GET", ["apps", "ghost-app"], {}, {})
        self.assertEqual(ctx.exception.status, 404)

    def test_delete_requires_exact_name(self):
        make_app("victim")
        with self.assertRaises(appsd.ApiError):
            appsd.route("DELETE", ["apps", "victim"], {}, {"confirm": "wrong"})
        self.assertTrue(appsd.app_path("victim").exists())

    def test_overview(self):
        self.assertIn("memory_budget_mb", appsd.route("GET", ["overview"], {}, {}))


if __name__ == "__main__":
    unittest.main(verbosity=1)
