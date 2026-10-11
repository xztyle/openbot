"""Offline tests for the download gateway: a real server on a loopback port, temporary files only.

Run: python3 scripts/download-gateway/test_downloadd.py
"""

import base64
import hashlib
import hmac
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(tempfile.mkdtemp(prefix="downloadd-test-"))
os.environ["DL_DATA_HOST"] = str(ROOT / "data")
os.environ["DL_KEY_PATH"] = str(ROOT / "data/.config/OpenBot/download-ticket.key")
sys.path.insert(0, str(Path(__file__).resolve().parent))

import downloadd  # noqa: E402

KEY = bytes(range(32))
# The exact token that `src/main/download-tickets.test.ts` in the product repo asserts for the same
# key, path, name and time. If the two sides drift, one of the two tests fails.
VECTOR = (
    "eyJ2IjoxLCJwIjoiL2RhdGEvT3BlbkJvdC9TaGFyZWQvVHJhbnNmZXJzL2ZpbmFsLm1vdiIsIm4iOiJmaW5hbC5tb3YiLCJlIjoxODAwMDAwOTAwMDAwfQ"
    ".3mFa2iVOmRpE_zwP1FJkJPoYMzQyrsuCL6vVIMP27lY"
)
BODY = bytes(range(256)) * 400  # 102,400 bytes


def token(path, name="file.bin", expires=None, key=KEY):
    claims = {"v": 1, "p": path, "n": name, "e": expires if expires is not None else int(time.time() * 1000) + 60_000}
    payload = base64.urlsafe_b64encode(json.dumps(claims, separators=(",", ":")).encode()).rstrip(b"=").decode()
    signature = base64.urlsafe_b64encode(hmac.new(key, payload.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"{payload}.{signature}"


class Gateway(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        data = ROOT / "data"
        (data / ".config/OpenBot").mkdir(parents=True)
        (data / ".config/OpenBot/download-ticket.key").write_bytes(KEY)
        (data / ".config/OpenBot/openbot.db").write_bytes(b"secret database")
        (data / "OpenBot/Shared").mkdir(parents=True)
        (data / "OpenBot/Shared/file.bin").write_bytes(BODY)
        (data / "OpenBot/Shared/héllo wörld.txt").write_bytes(b"hi")
        (data / "OpenBot/Shared/escape").symlink_to(data / ".config/OpenBot/openbot.db")
        cls.server = downloadd.Server(("127.0.0.1", 0), downloadd.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def get(self, path, headers=None, method="GET"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return response, body

    def test_serves_the_whole_file(self):
        response, body = self.get("/d/" + token("/data/OpenBot/Shared/file.bin"))
        self.assertEqual(response.status, 200)
        self.assertEqual(body, BODY)
        self.assertEqual(response.getheader("Content-Length"), str(len(BODY)))
        self.assertEqual(response.getheader("Accept-Ranges"), "bytes")
        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn("attachment", response.getheader("Content-Disposition"))
        self.assertEqual(response.getheader("Content-Type"), "application/octet-stream")

    def test_ranges_resume_a_download(self):
        path = "/d/" + token("/data/OpenBot/Shared/file.bin")
        response, body = self.get(path, {"Range": "bytes=1000-1999"})
        self.assertEqual((response.status, body), (206, BODY[1000:2000]))
        self.assertEqual(response.getheader("Content-Range"), f"bytes 1000-1999/{len(BODY)}")
        response, body = self.get(path, {"Range": "bytes=102000-"})
        self.assertEqual((response.status, body), (206, BODY[102000:]))
        response, body = self.get(path, {"Range": "bytes=-100"})
        self.assertEqual((response.status, body), (206, BODY[-100:]))
        response, _ = self.get(path, {"Range": f"bytes={len(BODY)}-"})
        self.assertEqual(response.status, 416)

    def test_head_has_headers_and_no_body(self):
        response, body = self.get("/d/" + token("/data/OpenBot/Shared/file.bin"), method="HEAD")
        self.assertEqual((response.status, body), (200, b""))
        self.assertEqual(response.getheader("Content-Length"), str(len(BODY)))

    def test_the_product_vector_verifies(self):
        payload, signature = VECTOR.split(".")
        path, name = downloadd.verify(payload, signature, KEY, at_ms=1_800_000_000_000)
        self.assertEqual((path, name), ("/data/OpenBot/Shared/Transfers/final.mov", "final.mov"))
        with self.assertRaises(downloadd.Refused):
            downloadd.verify(payload, signature, KEY, at_ms=1_800_000_900_000)

    def test_refuses_everything_else_with_the_same_404(self):
        good = token("/data/OpenBot/Shared/file.bin")
        payload, signature = good.split(".")
        cases = {
            "expired": token("/data/OpenBot/Shared/file.bin", expires=1),
            "wrong key": token("/data/OpenBot/Shared/file.bin", key=bytes(32)),
            "tampered": payload + "." + signature[:-2] + ("AA" if not signature.endswith("AA") else "BB"),
            "profile folder": token("/data/.config/OpenBot/openbot.db"),
            "traversal": token("/data/OpenBot/../.config/OpenBot/openbot.db"),
            "symlink escape": token("/data/OpenBot/Shared/escape"),
            "other root": token("/etc/passwd"),
            "missing": token("/data/OpenBot/Shared/none.bin"),
            "directory": token("/data/OpenBot/Shared"),
        }
        for label, value in cases.items():
            response, body = self.get("/d/" + value)
            self.assertEqual(response.status, 404, label)
            self.assertEqual(body, b"", label)
        for path in ("/", "/d/", "/d/abc", "/other", "/d/%2e%2e"):
            self.assertEqual(self.get(path)[0].status, 404, path)

    def test_names_with_unicode_are_encoded(self):
        value = token("/data/OpenBot/Shared/héllo wörld.txt", name="héllo wörld.txt")
        response, body = self.get("/d/" + value)
        self.assertEqual((response.status, body), (200, b"hi"))
        disposition = response.getheader("Content-Disposition")
        self.assertIn("filename*=UTF-8''h%C3%A9llo%20w%C3%B6rld.txt", disposition)
        self.assertTrue(disposition.encode("ascii"))

    def test_only_get_and_head(self):
        response, _ = self.get("/d/" + token("/data/OpenBot/Shared/file.bin"), method="POST")
        self.assertIn(response.status, (404, 405, 501))


if __name__ == "__main__":
    unittest.main(verbosity=1)
