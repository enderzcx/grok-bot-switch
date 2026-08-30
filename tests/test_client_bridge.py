"""Paired client status tests use only synthetic tokens and local HTTP servers."""

import json
import os
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from grokctl.client_bridge import MARKER, MAX_MANIFEST_BYTES, MAX_RESPONSE_BYTES, status, call, ClientBridgeError
from grokctl.profiles import atomic_replace, ensure_private_dir


class ClientBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = ensure_private_dir(Path(self.temp.name) / "paired")
        self.token = "ab" * 32
        self.native_token = "native-secret-never-export"
        self.instance = str(uuid.uuid4())
        self.executable = str(self.home / "Grok Bot.exe")
        self.requests = []
        self.posts = []
        self.http_status = 200
        self.location = None
        self.body = {
            "service": MARKER, "schemaVersion": 1, "instance": self.instance,
            "clientVersion": "0.56.1", "clientConnected": True, "hostReachable": True,
            "hostBusy": False, "hostVersion": "0.56.0", "providerSwitchReady": True,
            "executor": {"available": True, "reachable": True, "reason": None, "token": self.native_token},
            "token": self.token, "renderer": [{"auth": self.native_token}],
            "hostStatusFields": [self.native_token], "nativeToken": self.native_token,
        }
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                owner.posts.append(json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0")))))
                self.do_GET()

            def do_GET(self):
                owner.requests.append((self.path, dict(self.headers)))
                payload = owner.body if isinstance(owner.body, bytes) else json.dumps(owner.body).encode()
                self.send_response(owner.http_status)
                if owner.location:
                    self.send_header("Location", owner.location)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.manifest = {"schemaVersion": 1, "instance": self.instance, "pid": os.getpid(),
                         "port": self.server.server_port, "token": self.token,
                         "clientVersion": "0.56.1", "executable": self.executable}
        self.save_manifest()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def save_manifest(self):
        atomic_replace(self.home / "client-bridge.json", json.dumps(self.manifest).encode())

    def assert_sanitized(self, result):
        rendered = json.dumps(result)
        for sensitive in (self.token, self.native_token, self.executable):
            self.assertNotIn(sensitive, rendered)
        self.assertIs(result["providerSwitchReady"], False)

    def test_paired_status_only_returns_safe_fields_and_never_enables_switch(self):
        with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "http_proxy": "http://127.0.0.1:1", "no_proxy": "", "NO_PROXY": ""}):
            result = status(self.home, self.executable)
        self.assertTrue(result["connected"])
        self.assertTrue(result["hostReachable"])
        self.assertEqual(result["clientVersion"], "0.56.1")
        self.assertEqual(len(self.requests), 1)
        path, headers = self.requests[0]
        self.assertEqual(path, "/v1/status")
        self.assertEqual(headers["Authorization"], "Bearer " + self.token)
        self.assertEqual(headers["Host"], f"127.0.0.1:{self.server.server_port}")
        self.assert_sanitized(result)

    def test_missing_manifest_does_not_create_home(self):
        missing = self.home / "missing"
        self.assertEqual(status(missing)["reason"], "not-paired")
        self.assertFalse(missing.exists())

    def test_native_host_git_version_is_supported(self):
        self.body["hostVersion"] = "17184bb"
        result = status(self.home, self.executable)
        self.assertTrue(result["connected"])
        self.assertEqual(result["hostVersion"], "17184bb")

    def test_response_client_version_must_match_pairing(self):
        self.body["clientVersion"] = "0.28.0"
        self.assertEqual(status(self.home)["reason"], "invalid-response")

    def test_probe_mode_cannot_invoke_mutation_routes(self):
        with self.assertRaises(ClientBridgeError) as error:
            call(self.home, "bootstrap")
        self.assertEqual(error.exception.code, "probe-only")
        self.assertEqual(self.requests, [])

    def test_native_begin_uses_one_post_and_returns_no_key(self):
        self.manifest["mode"] = "native-switch"
        self.save_manifest()
        self.body = {"id":"gbs-"+str(uuid.uuid4()),"status":"pending","verified":False,"target":"custom"}
        key = "SENTINEL_SUPPLIER_KEY"
        result = call(self.home, "begin", profile={"id":"custom"}, secret=key)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0]["secret"], key)
        self.assertFalse(result["verified"])
        self.assertNotIn(key, json.dumps(result))

    def test_false_verified_or_key_echo_is_rejected_without_retry(self):
        self.manifest["mode"] = "native-switch"
        self.save_manifest()
        for body in ({"status":"verified","verified":False}, {"status":"pending","verified":False,"extra":"SENTINEL_SUPPLIER_KEY"}):
            before = len(self.posts)
            self.body = body
            with self.assertRaises(ClientBridgeError):
                call(self.home, "begin", profile={"id":"custom"}, secret="SENTINEL_SUPPLIER_KEY")
            self.assertEqual(len(self.posts), before + 1)

    def test_managed_runtime_requires_matching_mode_and_sanitizes_nested_state(self):
        self.manifest["mode"] = "native-switch"
        self.save_manifest()
        self.body["mode"] = "native-switch"
        self.body["runtime"] = {"ok":True,"runtimeKind":"native-host","providerSwitchReady":True,
                                "activeProfile":"custom","desiredProfile":"custom","profileDigest":"f"*64,
                                "previousProfile":"official","blocking":[],"secret":"SENTINEL"}
        result = status(self.home)
        self.assertTrue(result["providerSwitchReady"])
        self.assertEqual(result["runtime"]["activeProfile"], "custom")
        self.assertNotIn("SENTINEL", json.dumps(result))
        self.body["runtime"]["profileDigest"] = self.token
        self.assertEqual(status(self.home)["reason"], "invalid-response")

    def test_executable_mismatch_prevents_request(self):
        result = status(self.home, self.home / "Other.exe")
        self.assertEqual(result["reason"], "invalid-pairing")
        self.assertFalse(self.requests)
        self.assert_sanitized(result)

    def test_invalid_manifest_fields_never_make_request(self):
        original = dict(self.manifest)
        for key, invalid in (("schemaVersion", True), ("instance", "not-uuid"), ("pid", 0),
                             ("pid", True), ("port", True), ("port", 65536),
                             ("token", "A" * 64), ("executable", "relative.exe")):
            with self.subTest(key=key, invalid=invalid):
                self.manifest = {**original, key: invalid}
                self.save_manifest()
                result = status(self.home)
                self.assertEqual(result["reason"], "invalid-pairing")
                self.assert_sanitized(result)
        self.assertFalse(self.requests)

    def test_oversized_manifest_prevents_request(self):
        atomic_replace(self.home / "client-bridge.json", b" " * (MAX_MANIFEST_BYTES + 1))
        self.assertEqual(status(self.home)["reason"], "invalid-pairing")
        self.assertFalse(self.requests)

    @unittest.skipIf(os.name == "nt", "POSIX mode fixture; Windows DACL covered separately")
    def test_public_home_or_manifest_rejected_without_repair(self):
        for path in (self.home, self.home / "client-bridge.json"):
            previous = path.stat().st_mode & 0o777
            path.chmod(0o777)
            self.assertEqual(status(self.home)["reason"], "invalid-pairing")
            self.assertEqual(path.stat().st_mode & 0o777, 0o777)
            path.chmod(previous)
        self.assertFalse(self.requests)

    def test_symlink_manifest_is_rejected(self):
        source = self.home / "original.json"
        manifest = self.home / "client-bridge.json"
        manifest.rename(source)
        try:
            manifest.symlink_to(source)
        except OSError:
            self.skipTest("symlink creation unavailable")
        self.assertEqual(status(self.home)["reason"], "invalid-pairing")
        self.assertFalse(self.requests)

    def test_redirect_does_not_forward_pairing_token(self):
        self.http_status = 302
        self.location = f"http://127.0.0.1:{self.server.server_port}/stolen"
        result = status(self.home)
        self.assertEqual(result["reason"], "probe-rejected")
        self.assertEqual(len(self.requests), 1)
        self.assert_sanitized(result)

    def test_oversized_response_is_rejected(self):
        self.body = b" " * (MAX_RESPONSE_BYTES + 1)
        self.assertEqual(status(self.home)["reason"], "invalid-response")

    def test_stale_instance_and_invalid_response_contract(self):
        original = dict(self.body)
        for key, invalid in (("instance", str(uuid.uuid4())), ("service", "wrong-service"),
                             ("schemaVersion", True), ("clientConnected", 1),
                             ("hostReachable", "true"), ("hostBusy", 1),
                             ("clientVersion", self.token)):
            with self.subTest(key=key):
                self.body = {**original, key: invalid}
                result = status(self.home)
                self.assertEqual(result["reason"], "invalid-response")
                self.assert_sanitized(result)

    def test_error_body_and_unknown_executor_reasons_are_not_exported(self):
        self.body["executor"]["reason"] = self.native_token
        result = status(self.home)
        self.assertIsNone(result["executor"]["reason"])
        self.assert_sanitized(result)
        self.http_status = 409
        result = status(self.home)
        self.assertEqual(result["reason"], "probe-busy")
        self.assert_sanitized(result)

    def test_no_response_error_text_is_exported(self):
        with patch("urllib.request.OpenerDirector.open", side_effect=OSError(self.token)) as opened:
            result = status(self.home)
        self.assertEqual(result["reason"], "bridge-unreachable")
        self.assertEqual(opened.call_args.kwargs["timeout"], 15)
        self.assert_sanitized(result)

    def test_duplicate_manifest_keys_are_rejected(self):
        raw = json.dumps(self.manifest).replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')
        atomic_replace(self.home / "client-bridge.json", raw.encode())
        self.assertEqual(status(self.home)["reason"], "invalid-pairing")
        self.assertFalse(self.requests)


if __name__ == "__main__":
    unittest.main()
