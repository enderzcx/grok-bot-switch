#!/usr/bin/env python3
"""Loopback-only BeefAPI hop for Grok Bot cloud hosts.

The upstream credential is read from a private regular file and never accepted
from a request, command-line argument, model binding, or process environment.
"""

from __future__ import annotations

import json
import logging
import os
import stat
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST = os.environ.get("BEEFAPI_HOP_HOST", "127.0.0.1")
PORT = int(os.environ.get("BEEFAPI_HOP_PORT", "18779"))
UPSTREAM = os.environ.get("BEEFAPI_HOP_UPSTREAM", "https://beefapi.com").rstrip("/")
KEY_FILE = Path(os.environ.get("BEEFAPI_HOP_KEY_FILE", "/workspace/grok-home/secrets/beefapi-grok.token"))
RECEIPT_FILE = Path(os.environ.get("BEEFAPI_HOP_RECEIPT_FILE", "/workspace/grok-home/logs/beefapi-hop-receipts.jsonl"))
TIMEOUT = float(os.environ.get("BEEFAPI_HOP_TIMEOUT", "1800"))
MAX_BODY = 64 * 1024 * 1024
LOG = logging.getLogger("beefapi-hop")


def load_key() -> str:
    info = KEY_FILE.lstat()
    if not stat.S_ISREG(info.st_mode) or KEY_FILE.is_symlink():
        raise RuntimeError("credential path must be a direct regular file")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError("credential file must not be accessible to group or others")
    key = KEY_FILE.read_text(encoding="utf-8").strip()
    if not key.startswith("sk-") or len(key) < 20 or any(char.isspace() for char in key):
        raise RuntimeError("credential file has an invalid token shape")
    return key


KEY = load_key()


def append_receipt(payload: dict[str, object]) -> None:
    RECEIPT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with RECEIPT_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "beefapi-grok-hop/1"

    def log_message(self, fmt: str, *args: object) -> None:
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def simple(self, code: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def relay(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.simple(413, {"error": {"type": "hop_error", "message": "body too large"}})
            return
        request_body = self.rfile.read(length) if length else None
        request = urllib.request.Request(UPSTREAM + self.path, data=request_body, method=self.command)
        for name, value in self.headers.items():
            if name.lower() in ("host", "authorization", "content-length", "connection", "accept-encoding"):
                continue
            request.add_header(name, value)
        request.add_header("Authorization", "Bearer " + KEY)
        request.add_header("Accept-Encoding", "identity")
        started = time.time()
        status = 502
        request_id = ""
        try:
            response = urllib.request.urlopen(request, timeout=TIMEOUT)
        except urllib.error.HTTPError as exc:
            response = exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            append_receipt({
                "at_ms": int(started * 1000),
                "duration_ms": int((time.time() - started) * 1000),
                "method": self.command,
                "path": self.path.split("?", 1)[0],
                "status": 502,
                "request_kind": self.headers.get("X-Grok-Request-Kind", "unknown"),
                "error": type(exc).__name__,
            })
            self.simple(502, {"error": {"type": "hop_error", "message": "BeefAPI upstream unreachable"}})
            return

        status = response.getcode()
        request_id = response.headers.get("X-Request-Id") or response.headers.get("X-Oneapi-Request-Id") or ""
        content_type = response.headers.get("Content-Type", "")
        is_stream = "text/event-stream" in content_type or "chunked" in (response.headers.get("Transfer-Encoding") or "").lower()
        self.send_response(status)
        if content_type:
            self.send_header("Content-Type", content_type)
        if request_id:
            self.send_header("X-Request-Id", request_id)
        if is_stream:
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                while True:
                    chunk = response.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionAbortedError):
                LOG.info("client disconnected from streamed response")
        else:
            payload = response.read()
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        response.close()
        append_receipt({
            "at_ms": int(started * 1000),
            "duration_ms": int((time.time() - started) * 1000),
            "method": self.command,
            "path": self.path.split("?", 1)[0],
            "status": status,
            "request_kind": self.headers.get("X-Grok-Request-Kind", "unknown"),
            "upstream_request_id": request_id,
        })

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.simple(200, {"ok": True, "service": "beefapi-grok-hop", "upstream": UPSTREAM, "credential_loaded": True})
            return
        self.relay()

    def do_POST(self) -> None:  # noqa: N802
        self.relay()

    def do_DELETE(self) -> None:  # noqa: N802
        self.relay()

    def do_PATCH(self) -> None:  # noqa: N802
        self.relay()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    LOG.info("listening on http://%s:%d -> %s (credential loaded from private file)", HOST, PORT, UPSTREAM)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

