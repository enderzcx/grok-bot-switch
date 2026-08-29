#!/usr/bin/env python3
"""Credential-gated, OpenAI-compatible fake upstream for the isolated lab."""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST = os.environ.get("FAKE_UPSTREAM_HOST", "127.0.0.1")
PORT = int(os.environ["FAKE_UPSTREAM_PORT"])
KEY = os.environ["FAKE_UPSTREAM_KEY"]
LOG_PATH = Path(os.environ["FAKE_UPSTREAM_LOG"])
MODEL = "external-test-model"


def append_receipt(receipt: dict[str, object]) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(receipt, sort_keys=True) + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "grok-home-fake-upstream/1"

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def authenticated(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {KEY}"

    def send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def reject(self) -> None:
        self.send_json(401, {"error": {"type": "authentication_error", "message": "missing or invalid bearer"}})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_json(200, {"ok": True, "service": "fake-external-upstream"})
            return
        if not self.authenticated():
            self.reject()
            return
        if self.path == "/v1/models":
            self.send_json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
            return
        self.send_json(404, {"error": {"type": "not_found"}})

    def do_POST(self) -> None:  # noqa: N802
        if not self.authenticated():
            self.reject()
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_json(400, {"error": {"type": "invalid_json"}})
            return
        if self.path not in ("/v1/chat/completions", "/v1/responses"):
            self.send_json(404, {"error": {"type": "not_found"}})
            return

        request_id = f"fake-{uuid.uuid4()}"
        lane = self.headers.get("X-Grok-Request-Kind", "main")
        model = str(request.get("model") or request.get("modelId") or MODEL)
        auth_fingerprint = hashlib.sha256(KEY.encode()).hexdigest()[:12]
        usage = {"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}
        append_receipt({
            "at_ms": int(time.time() * 1000),
            "request_kind": lane,
            "provider": "fake-external",
            "model": model,
            "upstream_request_id": request_id,
            "usage": usage,
            "authorization_present": True,
            "authorization_fingerprint": auth_fingerprint,
        })

        if request.get("stream") is True:
            events = [
                {"id": request_id, "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {"content": f"external:{lane}"}}]},
                {"id": request_id, "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage},
            ]
            chunks = [f"data: {json.dumps(event)}\n\n".encode() for event in events] + [b"data: [DONE]\n\n"]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for chunk in chunks:
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            return

        self.send_json(200, {
            "id": request_id,
            "object": "chat.completion",
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": f"external:{lane}"}, "finish_reason": "stop"}],
            "usage": usage,
        })


def main() -> None:
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

