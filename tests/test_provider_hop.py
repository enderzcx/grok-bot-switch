#!/usr/bin/env python3
"""Loopback fake-upstream tests for the generic grokctl provider hop."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
HOP_PATH = ROOT / "ops" / "provider_hop.py"
SECRET_VALUE = "sk-SUPER-SECRET-VALUE-NEVER-LOG"


def load_hop():
    spec = importlib.util.spec_from_file_location("grokctl_provider_hop", HOP_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load provider hop")
    module = importlib.util.module_from_spec(spec)
    sys.modules["grokctl_provider_hop"] = module
    spec.loader.exec_module(module)
    return module


HOP = load_hop()


class UpstreamHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _fmt: str, *_args: object) -> None:
        return

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _record(self, body: bytes) -> None:
        self.server.contact_count = int(getattr(self.server, "contact_count", 0)) + 1
        self.server.requests.append(
            {
                "path": self.path,
                "method": self.command,
                "headers": {name.lower(): value for name, value in self.headers.items()},
                "body": body,
            }
        )

    def do_GET(self) -> None:  # noqa: N802
        self._record(b"")
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", self.server.evil_url)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        body = self._read_body()
        self._record(body)
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", self.server.evil_url)
            self.end_headers()
            return
        if self.path.startswith("/large"):
            payload = b"X" * 100
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path.startswith("/stream"):
            chunks = [
                b'data: {"delta":"hello"}\n\n',
                b'data: {"delta":" world"}\n\n',
                b"data: [DONE]\n\n",
            ]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("X-Request-Id", "upstream-stream-1")
            self.end_headers()
            for chunk in chunks:
                self.wfile.write(("%x\r\n" % len(chunk)).encode("ascii") + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            return
        payload = json.dumps({"ok": True, "echo": body.decode("utf-8")}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Request-Id", "upstream-json-1")
        self.end_headers()
        self.wfile.write(payload)


class EvilHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _fmt: str, *_args: object) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        self.server.hits.append(self.path)
        self.send_response(200)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        self.server.hits.append(self.path)
        self.send_response(200)
        self.end_headers()


def start_http(handler, host: str = "127.0.0.1"):
    server = ThreadingHTTPServer((host, 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def opener():
    return build_opener(ProxyHandler({}))


class HopTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._previous_resolver = HOP.get_host_resolver()
        HOP.set_host_resolver(lambda host: ("8.8.8.8",))
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.secret_path = self.root / "secret"
        self.secret_path.write_text(SECRET_VALUE + "\n", encoding="utf-8")
        os.chmod(self.secret_path, 0o600)
        self.receipt_path = self.root / "receipts.jsonl"
        self.upstream, self.upstream_thread = start_http(UpstreamHandler)
        self.upstream.requests = []
        self.upstream.contact_count = 0
        self.evil, self.evil_thread = start_http(EvilHandler)
        self.evil.hits = []
        self.upstream.evil_url = "http://127.0.0.1:%d/stolen" % self.evil.server_address[1]
        self.hop_server = None

    def tearDown(self) -> None:
        if self.hop_server is not None:
            self.hop_server.shutdown()
            self.hop_server.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.evil.shutdown()
        self.evil.server_close()
        self.tmp.cleanup()
        HOP.set_host_resolver(self._previous_resolver)

    def _write_config(self, **overrides: object) -> Path:
        upstream_port = int(self.upstream.server_address[1])
        payload = {
            "schemaVersion": 1,
            "listenHost": "127.0.0.1",
            "listenPort": 0,
            "profileId": "custom-openai",
            "protocol": "openai-chat",
            "model": "model-name",
            "resolvedEndpoint": "http://127.0.0.1:%d/v1/chat/completions" % upstream_port,
            "endpointPath": "/v1/chat/completions",
            "authType": "bearer",
            "secretFile": str(self.secret_path),
            "headers": {},
            "timeoutSec": 5,
            "receiptFile": str(self.receipt_path),
        }
        payload.update(overrides)
        path = self.root / "hop.json"
        path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(path, 0o600)
        return path

    def _start_hop(self, **overrides: object):
        runtime = HOP.load_runtime(self._write_config(**overrides))
        server = HOP.bind_server(runtime)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.hop_server = server
        self.hop_runtime = runtime
        port = int(server.server_address[1])
        return "http://127.0.0.1:%d" % port

    def _wait_receipt(self) -> str:
        deadline = time.time() + 2.0
        while time.time() < deadline:
            if self.receipt_path.is_file() and self.receipt_path.stat().st_size:
                return self.receipt_path.read_text(encoding="utf-8")
            time.sleep(0.01)
        self.fail("hop receipt was not written")

    def _request(self, url: str, data: bytes = None, headers: Dict[str, str] = None, method: str = None):
        req = Request(url, data=data, method=method or ("GET" if data is None else "POST"))
        for name, value in (headers or {}).items():
            req.add_header(name, value)
        try:
            with opener().open(req, timeout=5) as response:
                return response.getcode(), response.read(), dict(response.headers)
        except HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    def test_health_endpoint_is_explicit_and_consistent(self) -> None:
        base = self._start_hop()
        status, body, _headers = self._request(base + "/healthz")
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["service"], "grokctl-provider-hop")
        self.assertEqual(payload["profileId"], "custom-openai")
        self.assertEqual(payload["protocol"], "openai-chat")
        self.assertEqual(payload["model"], "model-name")
        self.assertEqual(payload["authType"], "bearer")
        self.assertEqual(payload["credentialLoaded"], True)
        self.assertEqual(payload["listenHost"], "127.0.0.1")
        self.assertTrue(str(payload["resolvedEndpoint"]).startswith("http://127.0.0.1:"))
        self.assertNotIn(SECRET_VALUE, json.dumps(payload))
        self.assertNotIn("secretFile", payload)

    def test_receipts_redact_secrets_and_bodies(self) -> None:
        base = self._start_hop()
        status, body, _headers = self._request(
            base + "/v1/chat/completions",
            data=b'{"prompt":"do-not-log-this-body"}',
            headers={
                "Authorization": "Bearer stolen-from-bot",
                "Content-Type": "application/json",
                "X-Grok-Request-Kind": "main",
            },
        )
        self.assertEqual(status, 200)
        self.assertIn(b"do-not-log-this-body", body)
        raw = self._wait_receipt()
        self.assertNotIn(SECRET_VALUE, raw)
        self.assertNotIn("stolen-from-bot", raw)
        self.assertNotIn("do-not-log-this-body", raw)
        receipt = json.loads(raw.strip().splitlines()[-1])
        self.assertEqual(receipt["profileId"], "custom-openai")
        self.assertEqual(receipt["protocol"], "openai-chat")
        self.assertEqual(receipt["model"], "model-name")
        self.assertEqual(receipt["requestKind"], "main")
        self.assertEqual(receipt["method"], "POST")
        self.assertEqual(receipt["status"], 200)
        self.assertEqual(receipt["streaming"], False)
        self.assertEqual(receipt["upstreamRequestId"], "upstream-json-1")
        self.assertIn("endpointOrigin", receipt)
        recorded = self.upstream.requests[-1]
        self.assertEqual(recorded["headers"].get("authorization"), "Bearer " + SECRET_VALUE)
        self.assertNotEqual(recorded["headers"].get("authorization"), "Bearer stolen-from-bot")

    def test_bearer_and_x_api_key_overwrite_and_none_strips_credentials(self) -> None:
        base = self._start_hop()
        self._request(
            base + "/v1/chat/completions",
            data=b"{}",
            headers={"Authorization": "Bearer stolen", "x-api-key": "forged"},
        )
        bearer_headers = self.upstream.requests[-1]["headers"]
        self.assertEqual(bearer_headers.get("authorization"), "Bearer " + SECRET_VALUE)
        self.assertNotIn("x-api-key", bearer_headers)

        if self.hop_server is not None:
            self.hop_server.shutdown()
            self.hop_server.server_close()
            self.hop_server = None

        base = self._start_hop(authType="x-api-key")
        self._request(
            base + "/v1/chat/completions",
            data=b"{}",
            headers={"Authorization": "Bearer stolen", "x-api-key": "forged"},
        )
        key_headers = self.upstream.requests[-1]["headers"]
        self.assertEqual(key_headers.get("x-api-key"), SECRET_VALUE)
        self.assertNotIn("authorization", key_headers)

        if self.hop_server is not None:
            self.hop_server.shutdown()
            self.hop_server.server_close()
            self.hop_server = None

        none_config = {
            "authType": "none",
            "secretFile": None,
        }
        base = self._start_hop(**none_config)
        self._request(
            base + "/v1/chat/completions",
            data=b"{}",
            headers={"Authorization": "Bearer stolen", "x-api-key": "forged"},
        )
        none_headers = self.upstream.requests[-1]["headers"]
        self.assertNotIn("authorization", none_headers)
        self.assertNotIn("x-api-key", none_headers)
        status, body, _headers = self._request(base + "/healthz")
        health = json.loads(body.decode("utf-8"))
        self.assertEqual(status, 200)
        self.assertEqual(health["authType"], "none")
        self.assertEqual(health["credentialLoaded"], False)
        self.assertEqual(health["ok"], True)

    def test_streamed_response_is_byte_relayed(self) -> None:
        port = int(self.upstream.server_address[1])
        base = self._start_hop(
            resolvedEndpoint="http://127.0.0.1:%d/stream" % port,
            endpointPath="/stream",
        )
        status, body, headers = self._request(base + "/stream", data=b"{}", headers={"X-Grok-Request-Kind": "main"})
        self.assertEqual(status, 200)
        self.assertEqual(
            body,
            b'data: {"delta":"hello"}\n\ndata: {"delta":" world"}\n\ndata: [DONE]\n\n',
        )
        receipt = json.loads(self._wait_receipt().strip().splitlines()[-1])
        self.assertEqual(receipt["streaming"], True)
        self.assertEqual(receipt["upstreamRequestId"], "upstream-stream-1")

    def test_unsafe_redirect_is_refused(self) -> None:
        port = int(self.upstream.server_address[1])
        base = self._start_hop(
            resolvedEndpoint="http://127.0.0.1:%d/redirect" % port,
            endpointPath="/redirect",
        )
        status, body, _headers = self._request(base + "/redirect", data=b"{}", headers={"X-Grok-Request-Kind": "main"})
        self.assertEqual(status, 502)
        self.assertIn(b"unsafe redirect refused", body)
        self.assertEqual(self.evil.hits, [])
        receipt = json.loads(self._wait_receipt().strip().splitlines()[-1])
        self.assertEqual(receipt["error"], "redirect_refused")
        self.assertNotIn(SECRET_VALUE, self.receipt_path.read_text(encoding="utf-8"))

    def test_unsafe_headers_are_rejected(self) -> None:
        with self.assertRaises(HOP.HopError):
            HOP.load_config(
                self._write_config(headers={"Authorization": "Bearer leaked"})
            )
        with self.assertRaises(HOP.HopError):
            HOP.validate_header_value("ok\r\nX-Injected: 1")
        with self.assertRaises(HOP.HopError):
            HOP.validate_header_name("X-Forwarded-For")
        with self.assertRaises(HOP.HopError):
            HOP.validate_headers({"X-Ok": "one\nBad: two"})

        base = self._start_hop()
        status, _body, _headers = self._request(
            base + "/v1/chat/completions",
            data=b"{}",
            headers={"X-Forwarded-For": "1.2.3.4", "Cookie": "session=1"},
        )
        self.assertEqual(status, 200)
        recorded = self.upstream.requests[-1]["headers"]
        self.assertNotIn("x-forwarded-for", recorded)
        self.assertNotIn("cookie", recorded)

    def test_unsafe_urls_are_rejected(self) -> None:
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("http://example.com/v1/chat/completions")
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("https://user:pass@api.example.com/v1")
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("https://api.example.com/v1#frag")
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("ftp://127.0.0.1/v1")
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("https://10.0.0.1/v1")
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("https://169.254.1.1/v1")
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("https://224.0.0.1/v1")
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("https://0.0.0.0/v1")
        HOP.validate_endpoint("http://127.0.0.1:9/v1/chat/completions")
        HOP.validate_endpoint("https://8.8.8.8/v1/chat/completions")
        HOP.validate_endpoint("https://api.example.com/v1/chat/completions")
        with self.assertRaises(HOP.HopError):
            HOP.load_runtime(self._write_config(listenHost="0.0.0.0"))
        with self.assertRaises(HOP.HopError):
            HOP.load_runtime(
                self._write_config(resolvedEndpoint="http://example.com/v1/chat/completions", endpointPath="/v1/chat/completions")
            )

    def test_hostname_resolving_to_private_ip_is_rejected(self) -> None:
        HOP.set_host_resolver(lambda host: ("10.1.2.3",))
        with self.assertRaises(HOP.HopError):
            HOP.validate_endpoint("https://evil.example/v1/chat/completions")
        HOP.set_host_resolver(lambda host: ("8.8.8.8",))
        HOP.validate_endpoint("https://ok.example/v1/chat/completions")

    def test_alternate_paths_queries_and_methods_do_not_contact_upstream(self) -> None:
        base = self._start_hop()
        self.assertEqual(self.upstream.contact_count, 0)
        status, _body, _headers = self._request(base + "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(self.upstream.contact_count, 0)
        for method in ("GET", "DELETE", "PATCH", "PUT", "HEAD"):
            status, _body, _headers = self._request(base + "/v1/chat/completions", method=method)
            self.assertEqual(status, 405, method)
        self.assertEqual(self.upstream.contact_count, 0)
        status, _body, _headers = self._request(base + "/v1/models", data=b"{}", headers={"Content-Type": "application/json"})
        self.assertEqual(status, 404)
        status, _body, _headers = self._request(
            base + "/v1/chat/completions?redirect=http://evil",
            data=b"{}",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 404)
        self.assertEqual(self.upstream.contact_count, 0)
        status, _body, _headers = self._request(
            base + "/v1/chat/completions",
            data=b"{}",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(self.upstream.contact_count, 1)
        self.assertEqual(self.upstream.requests[-1]["path"], "/v1/chat/completions")

    def test_non_streaming_response_is_bounded(self) -> None:
        port = int(self.upstream.server_address[1])
        base = self._start_hop(
            resolvedEndpoint="http://127.0.0.1:%d/large" % port,
            endpointPath="/large",
            maxResponseBytes=16,
        )
        status, body, _headers = self._request(base + "/large", data=b"x")
        self.assertEqual(status, 502)
        self.assertIn(b"too large", body)
        self.assertEqual(self.upstream.contact_count, 1)

    def test_hop_config_and_receipt_are_owner_only(self) -> None:
        path = self._write_config()
        os.chmod(path, 0o644)
        with self.assertRaises(HOP.HopError):
            HOP.load_config(path)
        os.chmod(path, 0o600)
        self.receipt_path.write_text("", encoding="utf-8")
        os.chmod(self.receipt_path, 0o644)
        with self.assertRaises(HOP.HopError):
            HOP.load_config(path)
        os.chmod(self.receipt_path, 0o600)
        HOP.load_config(path)
        base = self._start_hop()
        self._request(base + "/v1/chat/completions", data=b"{}")
        self._wait_receipt()
        mode = self.receipt_path.stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_secret_must_be_private_regular_file(self) -> None:
        os.chmod(self.secret_path, 0o644)
        with self.assertRaises(HOP.HopError):
            HOP.load_runtime(self._write_config())
        os.chmod(self.secret_path, 0o600)
        link = self.root / "secret-link"
        link.symlink_to(self.secret_path)
        with self.assertRaises(HOP.HopError):
            HOP.load_secret(link)


if __name__ == "__main__":
    unittest.main()
