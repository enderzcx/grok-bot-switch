#!/usr/bin/env python3
"""Loopback-only generic provider hop for grokctl v0.1.

Configuration and credentials come from private files. Credential-bearing
headers are overwritten here and are never accepted from Grok Bot. Request and
response bodies are never logged.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import stat
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Mapping, Optional, Tuple
from urllib.parse import urlparse


MAX_BODY = 64 * 1024 * 1024
LOG = logging.getLogger("grokctl-provider-hop")
HEADER_TOKEN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"})
AUTH_TYPES = frozenset({"none", "bearer", "x-api-key"})
PROTOCOLS = frozenset({"openai-chat", "openai-responses", "anthropic-messages"})
PROTOCOL_DEFAULT_PATHS = {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages",
}
HEADER_DENYLIST = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
        "cookie",
        "cookie2",
        "set-cookie",
        "set-cookie2",
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "te",
        "trailer",
        "upgrade",
        "keep-alive",
        "expect",
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-forwarded-server",
        "x-forwarded-prefix",
        "x-real-ip",
        "accept-encoding",
    }
)
FORBIDDEN_CONFIG_KEYS = frozenset(
    {
        "apikey",
        "api_key",
        "authorization",
        "cookie",
        "credential",
        "credentials",
        "key",
        "oauth",
        "password",
        "secret",
        "token",
        "accesstoken",
        "refreshtoken",
    }
)
ALLOWED_CONFIG_KEY_EXCEPTIONS = frozenset({"secretfile", "secretref"})


class HopError(RuntimeError):
    """Fail-closed hop error. Messages must not contain credentials."""


class RedirectRefused(urllib.error.URLError):
    """Upstream returned a redirect. The hop never follows Location."""


class RefuseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise RedirectRefused("unsafe redirect refused")

    def http_error_301(self, req, fp, code, msg, headers):  # noqa: ANN001
        raise RedirectRefused("unsafe redirect refused")

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


@dataclass(frozen=True)
class HopConfig:
    schema_version: int
    listen_host: str
    listen_port: int
    profile_id: str
    protocol: str
    model: str
    resolved_endpoint: str
    upstream_origin: str
    endpoint_path: str
    auth_type: str
    secret_file: Optional[str]
    headers: Tuple[Tuple[str, str], ...]
    timeout_sec: float
    receipt_file: str
    anthropic_version: Optional[str]


@dataclass(frozen=True)
class HopRuntime:
    config: HopConfig
    secret: Optional[str]


def isoformat_z(ts: Optional[float] = None) -> str:
    value = datetime.fromtimestamp(time.time() if ts is None else ts, tz=timezone.utc)
    return value.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_loopback_host(host: str) -> bool:
    name = str(host or "").strip().strip("[]").lower()
    if name in LOOPBACK_HOSTS:
        return True
    if name.startswith("127."):
        parts = name.split(".")
        if len(parts) == 4 and all(part.isdigit() and 0 <= int(part) <= 255 for part in parts):
            return True
    return False


def validate_endpoint(url: str, *, allow_http_loopback: bool = True) -> Tuple[str, str, str]:
    if not isinstance(url, str) or not url or any(ch in url for ch in "\r\n\t "):
        raise HopError("unsafe url")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HopError("unsafe url")
    if parsed.username is not None or parsed.password is not None:
        raise HopError("unsafe url")
    if parsed.fragment:
        raise HopError("unsafe url")
    if not parsed.netloc or not parsed.hostname:
        raise HopError("unsafe url")
    if parsed.scheme == "http":
        if not allow_http_loopback or not is_loopback_host(parsed.hostname):
            raise HopError("unsafe url")
    origin = "%s://%s" % (parsed.scheme, parsed.netloc)
    path = parsed.path or "/"
    return origin, path, parsed.query


def resolve_endpoint(protocol: str, base_url: str, endpoint_path: Optional[str] = None) -> str:
    if protocol not in PROTOCOLS:
        raise HopError("unsupported protocol")
    if not isinstance(base_url, str) or not base_url:
        raise HopError("unsafe url")
    path = endpoint_path if endpoint_path not in (None, "") else PROTOCOL_DEFAULT_PATHS[protocol]
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
        raise HopError("unsafe url")
    if "://" in path or "\\" in path or any(ch in path for ch in "\r\n\t "):
        raise HopError("unsafe url")
    if any(part == ".." for part in path.split("/")):
        raise HopError("unsafe url")
    resolved = base_url.rstrip("/") + path
    validate_endpoint(resolved)
    return resolved


def validate_header_name(name: str) -> str:
    if not isinstance(name, str) or not HEADER_TOKEN.match(name):
        raise HopError("unsafe header name")
    lower = name.lower()
    if lower in HEADER_DENYLIST:
        raise HopError("unsafe header name")
    return lower


def validate_header_value(value: str) -> str:
    if not isinstance(value, str) or any(ch in value for ch in "\r\n\0"):
        raise HopError("unsafe header value")
    return value


def validate_headers(headers: Mapping[str, str]) -> Tuple[Tuple[str, str], ...]:
    if headers is None:
        return ()
    if not isinstance(headers, Mapping):
        raise HopError("unsafe header name")
    seen = set()
    out = []
    for name, value in headers.items():
        lower = validate_header_name(str(name))
        if lower in seen:
            raise HopError("unsafe header name")
        seen.add(lower)
        out.append((str(name), validate_header_value(str(value))))
    return tuple(out)


def _assert_no_secret_material(value: object) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            lowered = str(key).lower().replace("-", "")
            if lowered in FORBIDDEN_CONFIG_KEYS and lowered not in ALLOWED_CONFIG_KEY_EXCEPTIONS:
                raise HopError("config must not contain secret material")
            _assert_no_secret_material(child)
    elif isinstance(value, list):
        for child in value:
            _assert_no_secret_material(child)


def _require_regular_private_file(path: Path, label: str) -> None:
    info = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(info.st_mode):
        raise HopError("%s must be a direct regular file" % label)
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise HopError("%s must not be accessible to group or others" % label)


def load_secret(path: Path) -> str:
    _require_regular_private_file(path, "credential path")
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HopError("credential file has an invalid shape") from exc
    key = text.strip()
    if not key or any(char.isspace() for char in key) or any(ch in key for ch in "\r\n\0"):
        raise HopError("credential file has an invalid shape")
    if len(key) < 8:
        raise HopError("credential file has an invalid shape")
    return key


def inspect_secret_metadata(path: Path) -> Dict[str, object]:
    """Return metadata only. Never includes the secret value."""

    result = {
        "path": str(path),
        "present": False,
        "regularFile": False,
        "symlink": False,
        "mode": 0,
        "fingerprint": None,
        "rejected": False,
        "reason": None,
    }
    if not path.exists() and not path.is_symlink():
        result["reason"] = "missing"
        result["rejected"] = True
        return result
    result["present"] = True
    try:
        info = path.lstat()
    except OSError:
        result["rejected"] = True
        result["reason"] = "unreadable"
        return result
    result["symlink"] = path.is_symlink() or stat.S_ISLNK(info.st_mode)
    result["regularFile"] = stat.S_ISREG(info.st_mode) and not result["symlink"]
    result["mode"] = int(stat.S_IMODE(info.st_mode))
    try:
        secret = load_secret(path)
    except HopError as exc:
        result["rejected"] = True
        result["reason"] = str(exc)
        return result
    digest = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    result["fingerprint"] = digest[:12]
    return result


def load_config(path: Path) -> HopConfig:
    if path.is_symlink() or not path.is_file():
        raise HopError("hop config must be a direct regular file")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HopError("hop config is invalid") from exc
    if not isinstance(payload, dict):
        raise HopError("hop config is invalid")
    _assert_no_secret_material(payload)
    protocol = str(payload.get("protocol") or "")
    if protocol not in PROTOCOLS:
        raise HopError("unsupported protocol")
    auth_type = str(payload.get("authType") or "")
    if auth_type not in AUTH_TYPES:
        raise HopError("unsupported auth type")
    listen_host = str(payload.get("listenHost") or "")
    if not is_loopback_host(listen_host):
        raise HopError("hop must listen only on loopback")
    try:
        listen_port = int(payload.get("listenPort"))
    except (TypeError, ValueError) as exc:
        raise HopError("invalid listen port") from exc
    if listen_port < 0 or listen_port > 65535:
        raise HopError("invalid listen port")
    profile_id = str(payload.get("profileId") or "")
    model = str(payload.get("model") or "")
    if not profile_id or not model:
        raise HopError("profile and model are required")
    resolved = str(payload.get("resolvedEndpoint") or "")
    origin, path_part, _query = validate_endpoint(resolved)
    extra_headers = validate_headers(payload.get("headers") or {})
    secret_file = payload.get("secretFile")
    if auth_type == "none":
        if secret_file not in (None, ""):
            raise HopError("auth none must not set a secret file")
        secret_path = None
    else:
        if not isinstance(secret_file, str) or not secret_file:
            raise HopError("missing secret file")
        secret_path = secret_file
    timeout = float(payload.get("timeoutSec") if payload.get("timeoutSec") is not None else 1800)
    if timeout <= 0:
        raise HopError("invalid timeout")
    receipt_file = str(payload.get("receiptFile") or "")
    if not receipt_file:
        raise HopError("receipt file is required")
    anthropic = payload.get("anthropicVersion")
    if anthropic is not None:
        anthropic = validate_header_value(str(anthropic))
    schema_version = int(payload.get("schemaVersion") or 0)
    if schema_version != 1:
        raise HopError("unsupported hop schema")
    endpoint_path = str(payload.get("endpointPath") or PROTOCOL_DEFAULT_PATHS[protocol])
    if urlparse(resolved).path != endpoint_path:
        raise HopError("resolved endpoint is internally inconsistent")
    return HopConfig(
        schema_version=schema_version,
        listen_host=listen_host,
        listen_port=listen_port,
        profile_id=profile_id,
        protocol=protocol,
        model=model,
        resolved_endpoint=resolved,
        upstream_origin=origin,
        endpoint_path=endpoint_path,
        auth_type=auth_type,
        secret_file=secret_path,
        headers=extra_headers,
        timeout_sec=timeout,
        receipt_file=receipt_file,
        anthropic_version=str(anthropic) if anthropic else None,
    )


def load_runtime(config_path: Path) -> HopRuntime:
    config = load_config(config_path)
    secret = None
    if config.auth_type != "none":
        secret = load_secret(Path(config.secret_file))
    return HopRuntime(config=config, secret=secret)


def health_payload(runtime: HopRuntime, bound_port: Optional[int] = None) -> Dict[str, object]:
    credential_loaded = runtime.secret is not None
    consistent = True
    if runtime.config.auth_type == "none":
        consistent = runtime.secret is None
    else:
        consistent = credential_loaded
    origin, path, _query = validate_endpoint(runtime.config.resolved_endpoint)
    if origin != runtime.config.upstream_origin or path != runtime.config.endpoint_path:
        consistent = False
    if runtime.config.protocol not in PROTOCOLS:
        consistent = False
    payload = {
        "ok": bool(consistent),
        "service": "grokctl-provider-hop",
        "profileId": runtime.config.profile_id,
        "protocol": runtime.config.protocol,
        "model": runtime.config.model,
        "resolvedEndpoint": runtime.config.resolved_endpoint,
        "authType": runtime.config.auth_type,
        "credentialLoaded": credential_loaded,
        "listenHost": runtime.config.listen_host,
        "listenPort": int(bound_port if bound_port is not None else runtime.config.listen_port),
    }
    return payload


def append_receipt(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(dict(payload), sort_keys=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(serialized + "\n")


def _sanitize_request_path(raw_path: str) -> str:
    if any(ch in raw_path for ch in "\r\n\0"):
        raise HopError("unsafe request path")
    path = raw_path.split("?", 1)[0]
    if not path.startswith("/") or path.startswith("//") or "://" in path:
        raise HopError("unsafe request path")
    if any(part == ".." for part in path.split("/")):
        raise HopError("unsafe request path")
    return raw_path


def _upstream_url(config: HopConfig, raw_path: str) -> str:
    _sanitize_request_path(raw_path)
    path, query = (raw_path.split("?", 1) + [""])[:2]
    if any(ch in query for ch in "\r\n\0"):
        raise HopError("unsafe request path")
    url = config.upstream_origin + path
    if query:
        url += "?" + query
    validate_endpoint(url.split("?", 1)[0])
    return url


def _build_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(RefuseRedirect(), urllib.request.ProxyHandler({}))


def _receipt_payload(
    runtime: HopRuntime,
    *,
    started: float,
    method: str,
    request_kind: str,
    status: int,
    streaming: bool,
    request_id: str,
    error: Optional[str] = None,
) -> Dict[str, object]:
    payload = {
        "at": isoformat_z(started),
        "profileId": runtime.config.profile_id,
        "protocol": runtime.config.protocol,
        "model": runtime.config.model,
        "requestKind": request_kind,
        "method": method,
        "endpointOrigin": runtime.config.upstream_origin,
        "status": status,
        "durationMs": int((time.time() - started) * 1000),
        "streaming": bool(streaming),
        "upstreamRequestId": request_id,
    }
    if error:
        payload["error"] = error
    return payload


def make_handler(runtime: HopRuntime):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "grokctl-provider-hop/1"

        def log_message(self, fmt: str, *args: object) -> None:
            path = self.path.split("?", 1)[0] if getattr(self, "path", None) else ""
            LOG.info("%s %s", self.command, path)

        def simple(self, code: int, payload: Dict[str, object]) -> None:
            body = json.dumps(payload, sort_keys=True).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _record(
            self,
            started: float,
            request_kind: str,
            status: int,
            streaming: bool,
            request_id: str,
            error: Optional[str] = None,
        ) -> None:
            append_receipt(
                Path(runtime.config.receipt_file),
                _receipt_payload(
                    runtime,
                    started=started,
                    method=self.command,
                    request_kind=request_kind,
                    status=status,
                    streaming=streaming,
                    request_id=request_id,
                    error=error,
                ),
            )

        def _apply_credential_headers(self, request: urllib.request.Request) -> None:
            if runtime.config.auth_type == "bearer":
                request.add_header("Authorization", "Bearer " + runtime.secret)
            elif runtime.config.auth_type == "x-api-key":
                request.add_header("x-api-key", runtime.secret)
                if runtime.config.anthropic_version:
                    request.add_header("anthropic-version", runtime.config.anthropic_version)
            for name, value in runtime.config.headers:
                request.add_header(name, value)
            request.add_header("Accept-Encoding", "identity")

        def relay(self) -> None:
            started = time.time()
            request_kind = self.headers.get("X-Grok-Request-Kind", "unknown")
            try:
                url = _upstream_url(runtime.config, self.path)
            except HopError:
                self.simple(400, {"error": {"type": "hop_error", "message": "unsafe request path"}})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                self.simple(400, {"error": {"type": "hop_error", "message": "invalid content length"}})
                return
            if length > MAX_BODY:
                self.simple(413, {"error": {"type": "hop_error", "message": "body too large"}})
                return
            request_body = self.rfile.read(length) if length else None
            request = urllib.request.Request(url, data=request_body, method=self.command)
            try:
                for name, value in self.headers.items():
                    lower = name.lower()
                    if lower in HEADER_DENYLIST:
                        continue
                    validate_header_name(name)
                    validate_header_value(value)
                    request.add_header(name, value)
                self._apply_credential_headers(request)
            except HopError:
                self.simple(400, {"error": {"type": "hop_error", "message": "unsafe header"}})
                return

            status = 502
            request_id = ""
            streaming = False
            response = None
            error_code = None
            try:
                try:
                    response = _build_opener().open(request, timeout=runtime.config.timeout_sec)
                except RedirectRefused:
                    error_code = "redirect_refused"
                    self.simple(502, {"error": {"type": "hop_error", "message": "unsafe redirect refused"}})
                    return
                except urllib.error.HTTPError as exc:
                    if 300 <= int(exc.code) < 400:
                        error_code = "redirect_refused"
                        self.simple(502, {"error": {"type": "hop_error", "message": "unsafe redirect refused"}})
                        return
                    response = exc
                except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
                    error_code = "upstream_unreachable"
                    self.simple(502, {"error": {"type": "hop_error", "message": "upstream unreachable"}})
                    return

                status = int(response.getcode())
                if 300 <= status < 400:
                    error_code = "redirect_refused"
                    status = 502
                    self.simple(502, {"error": {"type": "hop_error", "message": "unsafe redirect refused"}})
                    return
                request_id = (
                    response.headers.get("X-Request-Id")
                    or response.headers.get("X-Oneapi-Request-Id")
                    or response.headers.get("request-id")
                    or ""
                )
                content_type = response.headers.get("Content-Type", "")
                transfer = (response.headers.get("Transfer-Encoding") or "").lower()
                streaming = "text/event-stream" in content_type or "chunked" in transfer
                self.send_response(status)
                if content_type:
                    self.send_header("Content-Type", content_type)
                if request_id:
                    self.send_header("X-Request-Id", request_id)
                try:
                    if streaming:
                        self.send_header("Cache-Control", "no-cache")
                        self.send_header("Transfer-Encoding", "chunked")
                        self.end_headers()
                        while True:
                            chunk = response.read(8192)
                            if not chunk:
                                break
                            self.wfile.write(("%x\r\n" % len(chunk)).encode("ascii") + chunk + b"\r\n")
                            self.wfile.flush()
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    else:
                        payload = response.read()
                        self.send_header("Content-Length", str(len(payload)))
                        self.end_headers()
                        self.wfile.write(payload)
                except (BrokenPipeError, ConnectionAbortedError):
                    LOG.info("client disconnected from streamed response")
            finally:
                try:
                    self._record(started, request_kind, status, streaming, request_id, error_code)
                except OSError:
                    LOG.info("unable to write hop receipt")
                try:
                    if response is not None:
                        response.close()
                except Exception:
                    pass

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] == "/healthz":
                bound = runtime.config.listen_port
                try:
                    bound = int(self.server.server_address[1])
                except Exception:
                    pass
                payload = health_payload(runtime, bound_port=bound)
                self.simple(200 if payload.get("ok") is True else 503, payload)
                return
            self.relay()

        def do_POST(self) -> None:  # noqa: N802
            self.relay()

        def do_DELETE(self) -> None:  # noqa: N802
            self.relay()

        def do_PATCH(self) -> None:  # noqa: N802
            self.relay()

        def do_PUT(self) -> None:  # noqa: N802
            self.relay()

    return Handler


def bind_server(runtime: HopRuntime) -> ThreadingHTTPServer:
    if not is_loopback_host(runtime.config.listen_host):
        raise HopError("hop must listen only on loopback")
    handler = make_handler(runtime)
    server = ThreadingHTTPServer((runtime.config.listen_host, runtime.config.listen_port), handler)
    server.hop_runtime = runtime  # type: ignore[attr-defined]
    return server


def serve_forever(runtime: HopRuntime) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    server = bind_server(runtime)
    host, port = server.server_address[:2]
    LOG.info(
        "listening on http://%s:%s protocol=%s profile=%s model=%s",
        host,
        port,
        runtime.config.protocol,
        runtime.config.profile_id,
        runtime.config.model,
    )
    server.serve_forever()


def config_path_from_env() -> Path:
    raw = os.environ.get("GROKCTL_HOP_CONFIG")
    if not raw:
        raise HopError("GROKCTL_HOP_CONFIG is required")
    return Path(raw)


def main() -> int:
    runtime = load_runtime(config_path_from_env())
    serve_forever(runtime)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
