"""Loopback-only local control panel over GrokctlService."""

from __future__ import annotations

import hmac
import io
import json
import re
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import parse_qs, unquote, urlparse

from grokctl.models import (
    ConflictError,
    GrokctlError,
    NotFoundError,
    NotWiredError,
    ValidationError,
)
from grokctl.service import GrokctlService


WEB_ROOT = Path(__file__).resolve().parent / "web"
STATIC_FILES = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/styles.css": "styles.css",
}
CONTENT_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
}

BIND_HOST = "127.0.0.1"
MAX_BODY_BYTES = 256 * 1024
MAX_JSON_DEPTH = 8
MAX_JSON_KEYS = 64
MAX_JSON_LIST = 64
CSRF_HEADER = "X-CSRF-Token"
CSRF_PLACEHOLDER = "%%CSRF_TOKEN%%"
PROFILE_PATH_RE = re.compile(r"^/api/providers/([a-z0-9-]+)(/[a-z0-9-]+(?:/[a-z0-9-]+)?)?$")


class UiForbidden(GrokctlError):
    code = "forbidden"
    exit_code = 2


class UiTooLarge(GrokctlError):
    code = "too-large"
    exit_code = 2


def validate_bind_host(host: object) -> str:
    if not isinstance(host, str) or host != BIND_HOST:
        raise ValidationError("本地面板只能绑定 127.0.0.1")
    return host


def validate_port(port: object) -> int:
    if isinstance(port, bool) or not isinstance(port, int) or port < 0 or port > 65535:
        raise ValidationError("端口无效")
    return port


def _reject_json_constant(_name: str) -> None:
    raise ValidationError("请求不是有效的 JSON")


def check_json_shape(value: object, *, depth: int = 1) -> None:
    if depth > MAX_JSON_DEPTH:
        raise ValidationError("请求内容过深")
    if isinstance(value, dict):
        if len(value) > MAX_JSON_KEYS:
            raise ValidationError("请求字段过多")
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValidationError("请求不是有效的 JSON")
            check_json_shape(item, depth=depth + 1)
        return
    if isinstance(value, list):
        if len(value) > MAX_JSON_LIST:
            raise ValidationError("请求字段过多")
        for item in value:
            check_json_shape(item, depth=depth + 1)


def parse_json_body(raw: bytes) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError("请求不是有效的 JSON") from exc
    try:
        payload = json.loads(text, parse_constant=_reject_json_constant)
    except json.JSONDecodeError as exc:
        raise ValidationError("请求不是有效的 JSON") from exc
    if not isinstance(payload, dict):
        raise ValidationError("请求必须是 JSON 对象")
    check_json_shape(payload)
    return payload


def http_status_for(exc: GrokctlError) -> int:
    if isinstance(exc, UiTooLarge):
        return 413
    if isinstance(exc, UiForbidden):
        return 403
    if isinstance(exc, NotFoundError):
        return 404
    if isinstance(exc, ConflictError):
        return 409
    if isinstance(exc, NotWiredError):
        return 503
    return 400


def origin_tuple_allowed(scheme: str, hostname: str | None, port: int | None, listen_port: int) -> bool:
    if scheme != "http":
        return False
    host = (hostname or "").lower().rstrip(".")
    if host not in {"127.0.0.1", "localhost"}:
        return False
    actual = 80 if port is None else port
    return actual == listen_port


def referer_allowed(referer: str, listen_port: int) -> bool:
    try:
        parts = urlparse(referer)
    except ValueError:
        return False
    return origin_tuple_allowed(parts.scheme, parts.hostname, parts.port, listen_port)


def origin_allowed(origin: str, listen_port: int) -> bool:
    if origin == "null":
        return False
    try:
        parts = urlparse(origin)
    except ValueError:
        return False
    return origin_tuple_allowed(parts.scheme, parts.hostname, parts.port, listen_port)


def dumps_public(payload: object) -> bytes:
    return json.dumps(
        payload, ensure_ascii=True, separators=(",", ":"), allow_nan=False
    ).encode("ascii")


class PanelHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    block_on_close = False

    def __init__(self, server_address: tuple[str, int], handler: type[BaseHTTPRequestHandler], panel: ProviderPanel) -> None:
        self.panel = panel
        super().__init__(server_address, handler)


class ProviderPanel:
    """Loopback HTTP surface. GrokctlService remains the only state owner."""

    def __init__(
        self,
        service: GrokctlService,
        *,
        host: str = BIND_HOST,
        port: int = 0,
        web_root: Path | None = None,
    ) -> None:
        self.service = service
        self.host = validate_bind_host(host)
        self._requested_port = validate_port(port)
        self.port = self._requested_port
        self.web_root = (web_root or WEB_ROOT).resolve()
        self.csrf_token = secrets.token_urlsafe(32)
        self._httpd: PanelHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._dry_run: tuple[str, str] | None = None

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    def bind(self) -> None:
        if self._httpd is not None:
            return
        self._httpd = PanelHTTPServer((self.host, self._requested_port), PanelHandler, self)
        bound_host, bound_port = self._httpd.server_address
        if bound_host != BIND_HOST:
            self._httpd.server_close()
            self._httpd = None
            raise ValidationError("本地面板只能绑定 127.0.0.1")
        self.port = int(bound_port)

    def start(self) -> None:
        self.bind()
        assert self._httpd is not None
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="grokctl-ui", daemon=True)
        self._thread.start()

    def serve_forever(self) -> None:
        self.bind()
        assert self._httpd is not None
        self._httpd.serve_forever()

    def wait(self) -> None:
        """Block the CLI while the server thread is alive, interruptibly."""
        while self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=0.5)

    def stop(self) -> None:
        httpd = self._httpd
        thread = self._thread
        self._thread = None
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
            self._httpd = None
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2)

    def __enter__(self) -> ProviderPanel:
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.stop()

    def mark_dry_run(self, action: str, target: str) -> None:
        with self._lock:
            self._dry_run = (action, target)

    def require_dry_run(self, action: str, target: str) -> None:
        with self._lock:
            pending = self._dry_run
        if pending != (action, target):
            raise ValidationError("请先查看计划再执行")

    def clear_dry_run(self) -> None:
        with self._lock:
            self._dry_run = None


class PanelHandler(BaseHTTPRequestHandler):
    close_connection = True
    protocol_version = "HTTP/1.1"
    timeout = 15

    @property
    def panel(self) -> ProviderPanel:
        return self.server.panel  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: object) -> None:
        return

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (ConnectionError, TimeoutError, BrokenPipeError):
            self.close_connection = True

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_HEAD(self) -> None:
        self._dispatch("HEAD")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PUT(self) -> None:
        self._send_error_json(UiForbidden("不支持的方法"), status=405)

    def do_PATCH(self) -> None:
        self._send_error_json(UiForbidden("不支持的方法"), status=405)

    def do_DELETE(self) -> None:
        self._send_error_json(UiForbidden("不支持的方法"), status=405)

    def _dispatch(self, method: str) -> None:
        try:
            self._enforce_local()
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if "\\" in path or ".." in path.split("/") or path.startswith("//"):
                raise NotFoundError("未找到")
            if method in {"GET", "HEAD"} and path in STATIC_FILES:
                self._serve_static(STATIC_FILES[path], head_only=(method == "HEAD"))
                return
            if not path.startswith("/api/"):
                raise NotFoundError("未找到")
            if method == "HEAD":
                raise UiForbidden("不支持的方法")
            query = parse_qs(parsed.query, keep_blank_values=False, strict_parsing=False)
            if method == "GET":
                payload = self._handle_get(path, query)
                self._send_json(200, payload)
                return
            body = self._read_body()
            self._enforce_mutation_guards()
            payload = self._handle_post(path, body)
            self._send_json(200, payload)
        except GrokctlError as exc:
            self._send_error_json(exc)
        except Exception:
            self._send_error_json(GrokctlError("内部错误", code="internal"), status=500)

    def _enforce_local(self) -> None:
        client = self.client_address[0]
        if client not in {"127.0.0.1", "::1"}:
            raise UiForbidden("只接受本机请求")
        host_header = (self.headers.get("Host") or "").split("%", 1)[0].strip().lower()
        port = self.panel.port
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if host_header not in allowed_hosts:
            raise UiForbidden("请求被拒绝")
        encoding = (self.headers.get("Transfer-Encoding") or "").strip()
        if encoding and encoding.lower() != "identity":
            raise UiForbidden("请求被拒绝")

    def _enforce_mutation_guards(self) -> None:
        origin = (self.headers.get("Origin") or "").strip()
        referer = (self.headers.get("Referer") or "").strip()
        port = self.panel.port
        if origin:
            if not origin_allowed(origin, port):
                raise UiForbidden("请求被拒绝")
        elif referer:
            if not referer_allowed(referer, port):
                raise UiForbidden("请求被拒绝")
        token = (self.headers.get(CSRF_HEADER) or "").strip()
        if not token or not hmac.compare_digest(token, self.panel.csrf_token):
            raise UiForbidden("缺少会话令牌")

    def _read_body(self) -> dict[str, Any]:
        length_raw = self.headers.get("Content-Length")
        if length_raw is None:
            raw = b""
        else:
            try:
                length = int(length_raw)
            except ValueError as exc:
                raise ValidationError("请求过大") from exc
            if length < 0:
                raise ValidationError("请求过大")
            if length > MAX_BODY_BYTES:
                leftover = length
                while leftover > 0:
                    chunk = self.rfile.read(min(65536, leftover))
                    if not chunk:
                        break
                    leftover -= len(chunk)
                raise UiTooLarge("请求过大")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValidationError("请求不完整")
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if raw and content_type not in {"", "application/json"}:
            raise ValidationError("请求必须是 JSON")
        return parse_json_body(raw)

    def _handle_get(self, path: str, query: Mapping[str, list[str]]) -> object:
        if path == "/api/status":
            return self.panel.service.status()
        if path == "/api/providers":
            return self.panel.service.list_providers()
        if path == "/api/activity":
            limit = 50
            raw_limit = query.get("limit", [""])[0]
            if raw_limit:
                try:
                    limit = int(raw_limit)
                except ValueError as exc:
                    raise ValidationError("limit 必须是 1 到 1000 的整数") from exc
            return self.panel.service.activity(limit=limit)
        if path == "/api/csrf":
            return {"csrfToken": self.panel.csrf_token}
        match = PROFILE_PATH_RE.fullmatch(path)
        if match and match.group(2) is None:
            return self.panel.service.show_provider(match.group(1))
        raise NotFoundError("未找到")

    def _handle_post(self, path: str, body: dict[str, Any]) -> object:
        if path == "/api/providers":
            return self.panel.service.add_provider(body)
        if path == "/api/plan":
            target = _require_text(body.get("target"), "target")
            plan = self.panel.service.plan(target)
            self.panel.mark_dry_run("use", str(plan.get("target") or target))
            return plan
        if path == "/api/use":
            return self._use(body)
        if path == "/api/rollback":
            return self._rollback(body)
        if path == "/api/test":
            return self._test(body)
        match = PROFILE_PATH_RE.fullmatch(path)
        if not match:
            raise NotFoundError("未找到")
        profile_id = match.group(1)
        rest = match.group(2) or ""
        if rest == "/remove":
            return self._remove_provider(profile_id, body)
        if rest == "/secret":
            return self._set_secret(profile_id, body)
        if rest == "/secret/remove":
            return self._remove_secret(profile_id, body)
        raise NotFoundError("未找到")

    def _use(self, body: dict[str, Any]) -> object:
        target = _require_text(body.get("target"), "target")
        apply = _optional_bool(body.get("apply"), "apply", default=False)
        if not apply:
            plan = self.panel.service.use(target, apply=False)
            self.panel.mark_dry_run("use", str(plan.get("target") or target))
            return plan
        self.panel.require_dry_run("use", target)
        try:
            return self.panel.service.use(target, apply=True)
        finally:
            self.panel.clear_dry_run()

    def _rollback(self, body: dict[str, Any]) -> object:
        apply = _optional_bool(body.get("apply"), "apply", default=False)
        if not apply:
            plan = self.panel.service.rollback(apply=False)
            self.panel.mark_dry_run("rollback", str(plan.get("target") or "official"))
            return plan
        target = str(body.get("target") or "official")
        self.panel.require_dry_run("rollback", target)
        try:
            return self.panel.service.rollback(apply=True)
        finally:
            self.panel.clear_dry_run()

    def _test(self, body: dict[str, Any]) -> object:
        target = _require_text(body.get("target"), "target")
        live = _optional_bool(body.get("live"), "live", default=False)
        return self.panel.service.test_profile(target, live=live)

    def _remove_provider(self, profile_id: str, body: dict[str, Any]) -> object:
        confirm = _optional_bool(body.get("confirm"), "confirm", default=False)
        if not confirm:
            preview = dict(self.panel.service.show_provider(profile_id))
            preview["dryRun"] = True
            preview["apply"] = False
            preview["action"] = "remove"
            self.panel.mark_dry_run("remove", profile_id)
            return preview
        self.panel.require_dry_run("remove", profile_id)
        try:
            return self.panel.service.remove_provider(profile_id)
        finally:
            self.panel.clear_dry_run()

    def _set_secret(self, profile_id: str, body: dict[str, Any]) -> object:
        secret = body.get("secret")
        if not isinstance(secret, str):
            raise ValidationError("密钥必须是文本")
        stream = io.BytesIO(secret.encode("utf-8"))
        try:
            return self.panel.service.set_secret(profile_id, stream)
        finally:
            body["secret"] = ""
            secret = ""
            stream.seek(0)
            stream.write(b"\x00" * stream.getbuffer().nbytes)
            stream.seek(0)

    def _remove_secret(self, profile_id: str, body: dict[str, Any]) -> object:
        confirm = _optional_bool(body.get("confirm"), "confirm", default=False)
        if not confirm:
            preview = dict(self.panel.service.show_provider(profile_id))
            preview["dryRun"] = True
            preview["apply"] = False
            preview["action"] = "secret-remove"
            self.panel.mark_dry_run("secret-remove", profile_id)
            return preview
        self.panel.require_dry_run("secret-remove", profile_id)
        try:
            return self.panel.service.remove_secret(profile_id)
        finally:
            self.panel.clear_dry_run()

    def _serve_static(self, name: str, *, head_only: bool) -> None:
        path = (self.panel.web_root / name).resolve()
        if self.panel.web_root not in path.parents and path != self.panel.web_root:
            raise NotFoundError("未找到")
        if not path.is_file():
            raise NotFoundError("未找到")
        data = path.read_bytes()
        if name == "index.html":
            data = data.replace(CSRF_PLACEHOLDER.encode("ascii"), self.panel.csrf_token.encode("ascii"))
        self._send_bytes(200, CONTENT_TYPES[name], data, head_only=head_only)

    def _security_headers(self) -> list[tuple[str, str]]:
        return [
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "no-referrer"),
            ("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'"),
            ("X-Robots-Tag", "noindex"),
        ]

    def _send_bytes(self, status: int, content_type: str, data: bytes, *, head_only: bool = False) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            for key, value in self._security_headers():
                self.send_header(key, value)
            self.end_headers()
            if not head_only:
                self.wfile.write(data)
        except (ConnectionError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def _send_json(self, status: int, payload: object) -> None:
        self._send_bytes(status, "application/json; charset=utf-8", dumps_public(payload))

    def _send_error_json(self, exc: GrokctlError, status: int | None = None) -> None:
        code = http_status_for(exc) if status is None else status
        payload = exc.to_public_dict()
        try:
            self._send_json(code, payload)
        except Exception:
            self.close_connection = True


def _require_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{label}必须是文本")
    return value


def _optional_bool(value: object, label: str, *, default: bool) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ValidationError(f"{label}必须是布尔值")
    return value


def start_panel(
    service: GrokctlService,
    *,
    host: str = BIND_HOST,
    port: int = 0,
) -> ProviderPanel:
    panel = ProviderPanel(service, host=host, port=port)
    panel.start()
    return panel


def main(argv: Sequence[str] | None = None, *, env: Mapping[str, str] | None = None) -> int:
    from grokctl.cli import main as cli_main

    return cli_main(["ui", *list(sys.argv[1:] if argv is None else argv)], env=env)


if __name__ == "__main__":
    raise SystemExit(main())
