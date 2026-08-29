"""Strict domain contracts for grokctl provider profiles."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit


SCHEMA_VERSION = 1
OFFICIAL_ID = "official"
SECRET_REF_PREFIX = "profile/"
FINGERPRINT_PREFIX_LEN = 12
MAX_DISPLAY_NAME_LEN = 80
MAX_MODEL_LEN = 200
MAX_HEADER_COUNT = 32
MAX_HEADER_VALUE_LEN = 256
MAX_PROFILE_BYTES = 256 * 1024

PROTOCOL_VALUES = ("openai-chat", "openai-responses", "anthropic-messages")
AUTH_VALUES = ("none", "bearer", "x-api-key", "oauth-adapter")
FALLBACK_NEVER = "never"
MODE_OFFICIAL = "official"
MODE_EXTERNAL = "external"

DEFAULT_ENDPOINT_PATHS = {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages",
}

PROFILE_ID_RE = re.compile(r"^(?:[a-z]|[a-z][a-z0-9-]{0,61}[a-z0-9])$")
ADAPTER_ID_RE = PROFILE_ID_RE
DNS_HOST_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")
HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})

FORBIDDEN_FIELDS = frozenset(
    {
        "apikey",
        "authorization",
        "bearer",
        "clientsecret",
        "cookie",
        "credential",
        "credentials",
        "key",
        "keyfile",
        "oauth",
        "password",
        "privatekey",
        "refreshtoken",
        "secret",
        "sessionid",
        "token",
        "accesstoken",
        "xapikey",
    }
)
ALLOWED_PROFILE_FIELDS = frozenset(
    {
        "schemaversion",
        "id",
        "displayname",
        "mode",
        "protocol",
        "baseurl",
        "endpointpath",
        "model",
        "auth",
        "headers",
        "parameters",
        "fallbackpolicy",
        "enabled",
        "builtin",
    }
)
ALLOWED_AUTH_FIELDS = frozenset({"type", "secretref", "adapter"})
ALLOWED_PARAMETER_FIELDS = frozenset({"reasoningeffort", "maxtokens"})

HEADER_DENYLIST = frozenset(
    {
        "accept-encoding",
        "authorization",
        "connection",
        "content-length",
        "content-type",
        "cookie",
        "forwarded",
        "host",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "set-cookie",
        "set-cookie2",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "via",
        "www-authenticate",
        "x-api-key",
        "api-key",
        "x-auth-token",
        "x-access-token",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-port",
        "x-forwarded-proto",
        "x-forwarded-server",
        "x-real-ip",
    }
)
HEADER_NAME_FORBIDDEN_PARTS = (
    "authorization",
    "token",
    "secret",
    "cookie",
    "credential",
    "password",
    "api-key",
    "apikey",
)
QUERY_FORBIDDEN_KEYS = frozenset(
    {
        "access_token",
        "accesstoken",
        "api_key",
        "apikey",
        "authorization",
        "key",
        "password",
        "secret",
        "token",
    }
)

EXTERNAL_REQUIRED = ("id", "protocol", "baseUrl", "model", "auth")


class GrokctlError(Exception):
    """User-facing control-plane error that never includes secret material."""

    exit_code = 2
    code = "error"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        self.message = message

    def to_public_dict(self) -> dict[str, object]:
        return {"ok": False, "error": {"code": self.code, "message": self.message}}


class ValidationError(GrokctlError):
    code = "validation"
    exit_code = 2


class NotFoundError(GrokctlError):
    code = "not-found"
    exit_code = 2


class ConflictError(GrokctlError):
    code = "conflict"
    exit_code = 2


class SecretError(GrokctlError):
    code = "secret"
    exit_code = 2


class NotWiredError(GrokctlError):
    code = "not-wired"
    exit_code = 3


class Protocol(str, Enum):
    OPENAI_CHAT = "openai-chat"
    OPENAI_RESPONSES = "openai-responses"
    ANTHROPIC_MESSAGES = "anthropic-messages"


class AuthType(str, Enum):
    NONE = "none"
    BEARER = "bearer"
    X_API_KEY = "x-api-key"
    OAUTH_ADAPTER = "oauth-adapter"


class FallbackPolicy(str, Enum):
    NEVER = "never"


def canonical_dumps(obj: object) -> str:
    return json.dumps(
        obj, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def pretty_dumps(obj: object) -> str:
    return json.dumps(
        obj, ensure_ascii=True, sort_keys=True, indent=2, allow_nan=False
    ) + "\n"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fingerprint_prefix(data: bytes) -> str:
    return sha256_hex(data)[:FINGERPRINT_PREFIX_LEN]


def _norm_field(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _has_ctl(text: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in text)


def _as_mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{label}必须是对象")
    out: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            raise ValidationError(f"{label}的字段名必须是文本")
        if _has_ctl(key):
            raise ValidationError(f"{label}的字段名不能包含控制字符")
        out[key] = item
    return out


def _reject_forbidden_fields(raw: Mapping[str, Any], *, allowed: frozenset[str], label: str) -> None:
    for key in raw:
        normalized = _norm_field(key)
        if normalized in FORBIDDEN_FIELDS:
            raise ValidationError("配置里不能包含密钥，请用 grokctl secret set 单独安装")
        if normalized not in allowed:
            raise ValidationError(f"{label}含有不支持的字段")


def value_looks_like_secret(value: str) -> bool:
    if _has_ctl(value):
        return False
    stripped = value.strip()
    if re.search(r"(?i)bearer\s+\S+", stripped):
        return True
    if re.match(r"sk-[A-Za-z0-9_-]{16,}$", stripped):
        return True
    if re.match(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$", stripped):
        return True
    if "BEGIN " in stripped and "PRIVATE KEY" in stripped:
        return True
    if re.match(r"(?i)(api[_-]?key|secret|token|password)\s*[:=]", stripped):
        return True
    return False


def _reject_secret_values(value: object, *, label: str) -> None:
    if isinstance(value, str):
        if value_looks_like_secret(value):
            raise ValidationError("配置里不能包含密钥，请用 grokctl secret set 单独安装")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValidationError(f"{label}的字段名必须是文本")
            if _norm_field(key) in FORBIDDEN_FIELDS:
                raise ValidationError("配置里不能包含密钥，请用 grokctl secret set 单独安装")
            _reject_secret_values(item, label=label)
        return
    if isinstance(value, list):
        for item in value:
            _reject_secret_values(item, label=label)


def validate_profile_id(profile_id: object, *, allow_official: bool = False) -> str:
    if not isinstance(profile_id, str) or not profile_id:
        raise ValidationError("提供方编号不能为空")
    if _has_ctl(profile_id) or profile_id != profile_id.strip():
        raise ValidationError("提供方编号不能包含空白或控制字符")
    if not PROFILE_ID_RE.fullmatch(profile_id):
        raise ValidationError("提供方编号只能用小写字母、数字和连字符")
    if profile_id == OFFICIAL_ID and not allow_official:
        raise ValidationError("官方通道不能通过配置文件创建或覆盖")
    return profile_id


def _require_str(value: object, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{label}必须是文本")
    if _has_ctl(value):
        raise ValidationError(f"{label}不能包含控制字符")
    if not allow_empty and not value.strip():
        raise ValidationError(f"{label}不能为空")
    if value != value.strip():
        raise ValidationError(f"{label}不能包含首尾空白")
    if value_looks_like_secret(value):
        raise ValidationError("配置里不能包含密钥，请用 grokctl secret set 单独安装")
    return value


def _optional_bool(raw: Mapping[str, Any], key: str, default: bool) -> bool:
    if key not in raw:
        return default
    value = raw[key]
    if not isinstance(value, bool):
        raise ValidationError(f"{key}必须是布尔值")
    return value


def default_endpoint_path(protocol: Protocol) -> str:
    return DEFAULT_ENDPOINT_PATHS[protocol.value]


def validate_absolute_path(path: str, *, label: str) -> str:
    if not path.startswith("/") or path.startswith("//"):
        raise ValidationError(f"{label}必须是绝对路径")
    if any(ch in path for ch in "?#\\"):
        raise ValidationError(f"{label}不能包含查询、片段或反斜杠")
    if "%" in path:
        raise ValidationError(f"{label}不能包含百分号编码")
    if _has_ctl(path) or " " in path:
        raise ValidationError(f"{label}不能包含空白或控制字符")
    segments = path.split("/")
    if segments[0] != "":
        raise ValidationError(f"{label}必须是绝对路径")
    for segment in segments[1:]:
        if segment in ("", ".", ".."):
            raise ValidationError(f"{label}不能包含空段或相对段")
    return path


def _is_loopback_host(host: str) -> bool:
    lowered = host.lower().rstrip(".")
    if lowered in {"localhost"}:
        return True
    try:
        return ipaddress.ip_address(lowered).is_loopback
    except ValueError:
        return False


def _canonical_host(host: str) -> str:
    lowered = host.lower().rstrip(".")
    try:
        ip = ipaddress.ip_address(lowered)
    except ValueError:
        if not DNS_HOST_RE.fullmatch(lowered):
            raise ValidationError("地址主机名无效")
        return lowered
    if ip.version == 6:
        return f"[{ip.compressed}]"
    return ip.compressed


def _validate_query(query: str) -> str:
    if not query:
        return ""
    if _has_ctl(query) or "#" in query:
        raise ValidationError("地址查询不能包含控制字符")
    parts: list[str] = []
    for chunk in query.split("&"):
        if not chunk:
            raise ValidationError("地址查询无效")
        if "=" in chunk:
            key, value = chunk.split("=", 1)
        else:
            key, value = chunk, ""
        if not key:
            raise ValidationError("地址查询无效")
        if _norm_field(key) in QUERY_FORBIDDEN_KEYS or _norm_field(key) in FORBIDDEN_FIELDS:
            raise ValidationError("配置里不能包含密钥，请用 grokctl secret set 单独安装")
        if value_looks_like_secret(value) or value_looks_like_secret(key):
            raise ValidationError("配置里不能包含密钥，请用 grokctl secret set 单独安装")
        parts.append(chunk)
    return "&".join(parts)


def canonicalize_base_url(url: object) -> str:
    text = _require_str(url, "baseUrl")
    if "\\" in text or any(ch.isspace() for ch in text):
        raise ValidationError("地址不能包含空白或反斜杠")
    parts = urlsplit(text)
    if parts.scheme not in {"http", "https"}:
        raise ValidationError("地址只支持 http 或 https")
    if parts.username is not None or parts.password is not None or "@" in (parts.netloc or ""):
        raise ValidationError("地址不能包含用户名或密码")
    if parts.fragment:
        raise ValidationError("地址不能包含片段")
    if not parts.hostname:
        raise ValidationError("地址缺少主机名")
    host = _canonical_host(parts.hostname)
    loopback = _is_loopback_host(parts.hostname)
    if parts.scheme == "http" and not loopback:
        raise ValidationError("非本机地址必须使用 https")
    try:
        port = parts.port
    except ValueError as exc:
        raise ValidationError("地址端口无效") from exc
    if port is not None and not (1 <= port <= 65535):
        raise ValidationError("地址端口无效")
    netloc = host
    if port is not None:
        default = 80 if parts.scheme == "http" else 443
        if port != default:
            netloc = f"{host}:{port}"
    path = parts.path or ""
    if path in {"", "/"}:
        path = ""
    else:
        path = validate_absolute_path(path.rstrip("/"), label="baseUrl 路径")
    query = _validate_query(parts.query)
    return urlunsplit((parts.scheme, netloc, path, query, ""))


def join_endpoint(base_url: str, endpoint_path: str) -> str:
    parts = urlsplit(base_url)
    base_path = parts.path.rstrip("/")
    return urlunsplit(
        (parts.scheme, parts.netloc, base_path + endpoint_path, parts.query, "")
    )


def _parse_headers(raw: object) -> tuple[tuple[str, str], ...]:
    if raw is None:
        return ()
    mapping = _as_mapping(raw, "headers")
    if len(mapping) > MAX_HEADER_COUNT:
        raise ValidationError("请求头数量过多")
    seen: set[str] = set()
    items: list[tuple[str, str]] = []
    for name, value in mapping.items():
        if _has_ctl(name) or not HEADER_NAME_RE.fullmatch(name):
            raise ValidationError("请求头名称无效")
        lowered = name.lower()
        if lowered in seen:
            raise ValidationError("请求头不能重复")
        seen.add(lowered)
        if lowered in HEADER_DENYLIST or any(part in lowered for part in HEADER_NAME_FORBIDDEN_PARTS):
            raise ValidationError("请求头不允许使用敏感、凭据或逐跳字段")
        text = _require_str(value, "请求头值")
        if len(text) > MAX_HEADER_VALUE_LEN:
            raise ValidationError("请求头值过长")
        items.append((lowered, text))
    items.sort(key=lambda item: item[0])
    return tuple(items)


def _parse_parameters(raw: object) -> dict[str, object]:
    if raw is None:
        return {}
    mapping = _as_mapping(raw, "parameters")
    _reject_forbidden_fields(mapping, allowed=ALLOWED_PARAMETER_FIELDS, label="parameters")
    _reject_secret_values(mapping, label="parameters")
    out: dict[str, object] = {}
    if "reasoningEffort" in mapping:
        effort = _require_str(mapping["reasoningEffort"], "reasoningEffort")
        if effort not in REASONING_EFFORTS:
            raise ValidationError(
                "reasoningEffort 只支持 none、minimal、low、medium、high、xhigh、max"
            )
        out["reasoningEffort"] = effort
    if "maxTokens" in mapping:
        tokens = mapping["maxTokens"]
        if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 1 or tokens > 1_000_000:
            raise ValidationError("maxTokens 必须是 1 到 1000000 的整数")
        out["maxTokens"] = tokens
    leftover = set(mapping) - {"reasoningEffort", "maxTokens"}
    if leftover:
        raise ValidationError("parameters 含有不支持的字段")
    return out


def _parse_auth(raw: object, *, profile_id: str, mode: str) -> AuthConfig:
    mapping = _as_mapping(raw, "auth")
    _reject_forbidden_fields(mapping, allowed=ALLOWED_AUTH_FIELDS, label="auth")
    _reject_secret_values(mapping, label="auth")
    auth_type_raw = mapping.get("type")
    if auth_type_raw not in AUTH_VALUES:
        raise ValidationError("auth.type 必须是 none、bearer、x-api-key 或 oauth-adapter")
    auth_type = AuthType(auth_type_raw)
    secret_ref_raw = mapping.get("secretRef")
    adapter_raw = mapping.get("adapter")
    expected_ref = SECRET_REF_PREFIX + profile_id

    if mode == MODE_OFFICIAL and auth_type is not AuthType.NONE:
        raise ValidationError("官方通道不能配置认证")

    adapter: str | None = None
    secret_ref: str | None = None

    if auth_type is AuthType.NONE:
        if secret_ref_raw is not None or adapter_raw is not None:
            raise ValidationError("none 认证不能包含密钥引用或适配器")
    elif auth_type in {AuthType.BEARER, AuthType.X_API_KEY}:
        if adapter_raw is not None:
            raise ValidationError("当前认证类型不支持适配器")
        if secret_ref_raw is None:
            secret_ref = expected_ref
        else:
            secret_ref = _require_str(secret_ref_raw, "secretRef")
            if secret_ref != expected_ref:
                raise ValidationError("secretRef 必须是 profile/<编号>")
    else:
        adapter = _require_str(adapter_raw, "adapter")
        if not ADAPTER_ID_RE.fullmatch(adapter):
            raise ValidationError("适配器编号只能用小写字母、数字和连字符")
        if secret_ref_raw is None:
            secret_ref = expected_ref
        else:
            secret_ref = _require_str(secret_ref_raw, "secretRef")
            if secret_ref != expected_ref:
                raise ValidationError("secretRef 必须是 profile/<编号>")
    return AuthConfig(type=auth_type, secret_ref=secret_ref, adapter=adapter)


@dataclass(frozen=True)
class AuthConfig:
    type: AuthType
    secret_ref: str | None = None
    adapter: str | None = None

    def to_canonical_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {"type": self.type.value}
        if self.secret_ref is not None:
            payload["secretRef"] = self.secret_ref
        if self.adapter is not None:
            payload["adapter"] = self.adapter
        return payload

    def requires_secret(self) -> bool:
        return self.type in {AuthType.BEARER, AuthType.X_API_KEY}


@dataclass(frozen=True)
class ProviderProfile:
    schema_version: int
    id: str
    display_name: str
    mode: str
    protocol: Protocol | None
    base_url: str | None
    endpoint_path: str | None
    model: str | None
    auth: AuthConfig
    headers: tuple[tuple[str, str], ...] = field(default_factory=tuple)
    parameters: Mapping[str, object] = field(default_factory=dict)
    fallback_policy: FallbackPolicy = FallbackPolicy.NEVER
    enabled: bool = True
    built_in: bool = False

    def requires_secret(self) -> bool:
        return self.auth.requires_secret()

    def resolved_method(self) -> str | None:
        if self.mode == MODE_OFFICIAL:
            return None
        return "POST"

    def resolved_endpoint(self) -> str | None:
        if self.mode == MODE_OFFICIAL:
            return None
        assert self.base_url is not None
        assert self.endpoint_path is not None
        return join_endpoint(self.base_url, self.endpoint_path)

    def to_canonical_dict(self) -> dict[str, object]:
        headers = {name: value for name, value in self.headers}
        payload: dict[str, object] = {
            "schemaVersion": self.schema_version,
            "id": self.id,
            "displayName": self.display_name,
            "mode": self.mode,
            "protocol": None if self.protocol is None else self.protocol.value,
            "baseUrl": self.base_url,
            "endpointPath": self.endpoint_path,
            "model": self.model,
            "auth": self.auth.to_canonical_dict(),
            "headers": headers,
            "parameters": dict(self.parameters),
            "fallbackPolicy": self.fallback_policy.value,
            "enabled": self.enabled,
            "builtIn": self.built_in,
        }
        return payload

    def digest(self) -> str:
        return sha256_hex(canonical_dumps(self.to_canonical_dict()).encode("ascii"))


def official_profile() -> ProviderProfile:
    return ProviderProfile(
        schema_version=SCHEMA_VERSION,
        id=OFFICIAL_ID,
        display_name="官方 Grok",
        mode=MODE_OFFICIAL,
        protocol=None,
        base_url=None,
        endpoint_path=None,
        model=None,
        auth=AuthConfig(type=AuthType.NONE),
        headers=(),
        parameters={},
        fallback_policy=FallbackPolicy.NEVER,
        enabled=True,
        built_in=True,
    )


def parse_profile(raw: object, *, allow_official: bool = False) -> ProviderProfile:
    if isinstance(raw, (bytes, bytearray)):
        if len(raw) > MAX_PROFILE_BYTES:
            raise ValidationError("配置文件过大")
        try:
            raw = json.loads(bytes(raw).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValidationError("配置不是有效的 JSON") from exc
    mapping = _as_mapping(raw, "profile")
    _reject_forbidden_fields(mapping, allowed=ALLOWED_PROFILE_FIELDS, label="profile")
    _reject_secret_values(mapping, label="profile")

    schema = mapping.get("schemaVersion", SCHEMA_VERSION)
    if schema != SCHEMA_VERSION:
        raise ValidationError("schemaVersion 必须是 1")

    profile_id_raw = mapping.get("id")
    if profile_id_raw == OFFICIAL_ID:
        if not allow_official:
            raise ValidationError("官方通道不能通过配置文件创建或覆盖")
        return _parse_official(mapping)

    profile_id = validate_profile_id(profile_id_raw, allow_official=False)
    mode_raw = mapping.get("mode")
    if mode_raw is None:
        mode = MODE_EXTERNAL
    else:
        mode = _require_str(mode_raw, "mode")
        if mode not in {MODE_OFFICIAL, MODE_EXTERNAL}:
            raise ValidationError("mode 必须是 official 或 external")
    if mode == MODE_OFFICIAL:
        raise ValidationError("只有官方通道可以使用 official 模式")
    if _optional_bool(mapping, "builtIn", default=False):
        raise ValidationError("自定义提供方不能标记为内置")
    return _parse_external(mapping, profile_id=profile_id)


def _parse_official(mapping: Mapping[str, Any]) -> ProviderProfile:
    built_in = _optional_bool(mapping, "builtIn", default=True)
    if not built_in:
        raise ValidationError("官方通道不能修改")
    if mapping.get("mode") not in {None, MODE_OFFICIAL}:
        raise ValidationError("官方通道不能修改")
    if mapping.get("schemaVersion") not in {None, SCHEMA_VERSION}:
        raise ValidationError("官方通道不能修改")
    for key in ("protocol", "baseUrl", "endpointPath", "model"):
        if mapping.get(key) not in {None}:
            raise ValidationError("官方通道不能修改")
    if "auth" in mapping:
        auth_raw = _as_mapping(mapping.get("auth"), "auth")
        if auth_raw and auth_raw != {"type": "none"}:
            raise ValidationError("官方通道不能修改")
    if mapping.get("headers") not in {None, {}}:
        raise ValidationError("官方通道不能修改")
    if mapping.get("parameters") not in {None, {}}:
        raise ValidationError("官方通道不能修改")
    if mapping.get("fallbackPolicy") not in {None, FALLBACK_NEVER}:
        raise ValidationError("官方通道不能修改")
    if mapping.get("enabled") not in {None, True}:
        raise ValidationError("官方通道不能修改")
    display = mapping.get("displayName", "官方 Grok")
    if display != "官方 Grok":
        raise ValidationError("官方通道不能修改")
    return official_profile()


def _parse_external(mapping: Mapping[str, Any], *, profile_id: str) -> ProviderProfile:
    for key in EXTERNAL_REQUIRED:
        if key not in mapping:
            raise ValidationError(f"缺少字段 {key}")
    display_name = _require_str(mapping.get("displayName", profile_id), "displayName")
    if len(display_name) > MAX_DISPLAY_NAME_LEN:
        raise ValidationError("显示名称过长")
    protocol_raw = mapping.get("protocol")
    if protocol_raw not in PROTOCOL_VALUES:
        raise ValidationError("protocol 必须是 openai-chat、openai-responses 或 anthropic-messages")
    protocol = Protocol(protocol_raw)
    base_url = canonicalize_base_url(mapping.get("baseUrl"))
    if "endpointPath" not in mapping or mapping.get("endpointPath") in {None, ""}:
        endpoint_path = default_endpoint_path(protocol)
    else:
        endpoint_path = validate_absolute_path(
            _require_str(mapping.get("endpointPath"), "endpointPath"), label="endpointPath"
        )
    model = _require_str(mapping.get("model"), "model")
    if not MODEL_RE.fullmatch(model) or len(model) > MAX_MODEL_LEN:
        raise ValidationError("model 格式无效")
    auth = _parse_auth(mapping.get("auth"), profile_id=profile_id, mode=MODE_EXTERNAL)
    headers = _parse_headers(mapping.get("headers"))
    parameters = _parse_parameters(mapping.get("parameters"))
    fallback_raw = mapping.get("fallbackPolicy", FALLBACK_NEVER)
    if fallback_raw != FALLBACK_NEVER:
        raise ValidationError("fallbackPolicy 必须是 never")
    enabled = _optional_bool(mapping, "enabled", default=True)
    return ProviderProfile(
        schema_version=SCHEMA_VERSION,
        id=profile_id,
        display_name=display_name,
        mode=MODE_EXTERNAL,
        protocol=protocol,
        base_url=base_url,
        endpoint_path=endpoint_path,
        model=model,
        auth=auth,
        headers=headers,
        parameters=parameters,
        fallback_policy=FallbackPolicy.NEVER,
        enabled=enabled,
        built_in=False,
    )


def parse_profile_json(text: str | bytes) -> ProviderProfile:
    return parse_profile(text if isinstance(text, (bytes, bytearray)) else text.encode("utf-8"))
