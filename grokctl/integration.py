"""Wire ProfileRegistry and SecretStore to the lab-local-root switch engine.

Production switch inputs come from ProviderProfile canonical output and the
single profile registry. ProfileCatalog is not used. Official remains built-in.
This module never reads HOME, never SSHes, and never installs a global DNS
resolver. Lab apply is a synthetic runtime and is not a real supervisor.
"""

from __future__ import annotations

import errno
import json
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

from grokctl.models import (
    FORBIDDEN_FIELDS,
    GrokctlError,
    OFFICIAL_ID,
    SCHEMA_VERSION,
    ValidationError,
    canonical_dumps,
    official_profile,
    sha256_hex,
)
from grokctl.profiles import ProfileRegistry, atomic_replace, ensure_private_dir
from grokctl.platform_security import IS_WINDOWS, lock_exclusive, unlock, open_nofollow, private_permissions, reject_links, set_private_permissions
from grokctl.remote import (
    Clock,
    HostError,
    HostRuntime,
    UuidSource,
    build_runtime,
    load_json,
    load_provider_hop,
)
from grokctl.secrets import SecretStore
from grokctl.switching import ArtifactSet, SwitchEngine, SwitchError


HOST_CONFIG_NAME = "host.json"
LOCK_NAME = "lock"
HOST_MODE_LAB_LOCAL_ROOT = "lab-local-root"
RUNTIME_KIND_LAB_SYNTHETIC = "lab-synthetic"
MAX_HOST_CONFIG_BYTES = 64 * 1024
DIGEST_LEN = 64
ALLOWED_HOST_FIELDS = frozenset(
    {
        "schemaversion",
        "mode",
        "hostroot",
        "stockbundle",
        "patchedbundle",
        "knownstockdigests",
        "knownpatcheddigests",
        "allowsyntheticapply",
    }
)


class BusyError(GrokctlError):
    code = "busy"
    exit_code = 2


def public_switch_code(code: str) -> str:
    return str(code or "error").replace("_", "-")


def switch_message(code: str) -> str:
    messages = {
        "unknown-hash": "主机程序校验和不在已知列表中",
        "pending-command": "主机还有未完成的重启命令",
        "busy-agent": "主机正忙",
        "missing-receipt": "没有可用的切换回执",
        "invalid-secret": "密钥无效或未安装",
        "missing-secret": "未安装密钥",
        "snapshot-mismatch": "主机状态已变化，请重新查看计划",
        "rollback-failed": "回滚失败",
        "hop-start-failed": "转发进程启动失败",
        "hop-health": "转发进程不健康",
        "protocol-mismatch": "协议或模型与主机不一致",
        "pid-ownership": "进程归属校验失败",
        "staged-mismatch": "暂存文件校验失败",
        "apply-required": "需要显式 --apply",
        "invalid-profile": "提供方配置无效",
        "unsafe-endpoint": "地址不安全",
        "unsafe-header": "请求头不安全",
        "busy": "控制面正在忙",
        "not-wired": "本机根目录尚未配置",
        "disabled": "提供方已停用",
        "needs-key": "未安装密钥",
        "secret-rejected": "密钥文件不安全",
        "drift": "目标通道与主机实际状态不一致",
        "lab-runtime": "实验室合成运行时不能应用到主机",
        "in-use": "该提供方正在使用，不能删除",
        "switch-back": "切回上一通道会新建一次切换，不是按快照原样恢复",
    }
    return messages.get(public_switch_code(code), "切换未能完成")


def raise_switch_error(exc: Exception) -> None:
    if isinstance(exc, GrokctlError):
        raise exc
    if isinstance(exc, SwitchError):
        raise GrokctlError(switch_message(exc.code), code=public_switch_code(exc.code)) from exc
    if isinstance(exc, HostError):
        raise GrokctlError(switch_message(exc.code), code=public_switch_code(exc.code)) from exc
    raise GrokctlError("切换未能完成", code="error") from exc


def _norm_field(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())


def _reject_json_constant(_name: str) -> None:
    raise ValidationError("主机配置不是有效的 JSON")


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


def _require_str(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValidationError(f"{label}必须是文本")
    if _has_ctl(value) or value != value.strip():
        raise ValidationError(f"{label}不能包含空白或控制字符")
    return value


def _optional_bool(raw: Mapping[str, Any], key: str, default: bool) -> bool:
    if key not in raw:
        return default
    value = raw[key]
    if not isinstance(value, bool):
        raise ValidationError(f"{key}必须是布尔值")
    return value


def _require_absolute_path(value: object, label: str) -> Path:
    text = _require_str(value, label)
    if text.startswith("~") or "$HOME" in text or "${HOME}" in text:
        raise ValidationError(f"{label}不能引用主目录")
    path = Path(text)
    if not path.is_absolute():
        raise ValidationError(f"{label}必须是绝对路径")
    return path


def _require_existing_dir(path: Path, label: str) -> Path:
    try:
        reject_links(path)
    except OSError as exc:
        raise ValidationError(f"{label}不能是符号链接或重解析点") from exc
    try:
        st = os.lstat(path)
    except FileNotFoundError as exc:
        raise ValidationError(f"{label}不存在") from exc
    if stat.S_ISLNK(st.st_mode):
        raise ValidationError(f"{label}不能是符号链接")
    if not stat.S_ISDIR(st.st_mode):
        raise ValidationError(f"{label}必须是目录")
    return path


def _require_existing_file(path: Path, label: str) -> Path:
    try:
        reject_links(path)
    except OSError as exc:
        raise ValidationError(f"{label}不能是符号链接或重解析点") from exc
    try:
        st = os.lstat(path)
    except FileNotFoundError as exc:
        raise ValidationError(f"{label}不存在") from exc
    if stat.S_ISLNK(st.st_mode):
        raise ValidationError(f"{label}不能是符号链接")
    if not stat.S_ISREG(st.st_mode):
        raise ValidationError(f"{label}必须是普通文件")
    return path


def _parse_digest_list(raw: object, label: str) -> tuple[str, ...]:
    if not isinstance(raw, list) or not raw:
        raise ValidationError(f"{label}必须是非空数组")
    items: list[str] = []
    seen: set[str] = set()
    for item in raw:
        text = _require_str(item, label)
        if len(text) != DIGEST_LEN or any(ch not in "0123456789abcdef" for ch in text):
            raise ValidationError(f"{label}必须是小写 sha256")
        if text not in seen:
            seen.add(text)
            items.append(text)
    return tuple(items)


def _file_is_private_regular(path: Path, *, missing_ok: bool = False) -> None:
    try:
        reject_links(path)
    except OSError as exc:
        raise ValidationError("主机配置不能是符号链接或重解析点") from exc
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        if missing_ok:
            return
        raise ValidationError("主机配置不存在")
    if stat.S_ISLNK(st.st_mode):
        raise ValidationError("主机配置不能是符号链接")
    if not stat.S_ISREG(st.st_mode):
        raise ValidationError("主机配置必须是普通文件")
    if not private_permissions(path, st):
        raise ValidationError("主机配置权限必须仅限当前用户")


@dataclass(frozen=True)
class HostConfig:
    schema_version: int
    mode: str
    host_root: Path
    stock_bundle: Path
    patched_bundle: Path
    known_stock_digests: tuple[str, ...]
    known_patched_digests: tuple[str, ...]
    allow_synthetic_apply: bool = False

    def known_bundle_digests(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(list(self.known_stock_digests) + list(self.known_patched_digests)))

    def to_canonical_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "mode": self.mode,
            "hostRoot": str(self.host_root),
            "stockBundle": str(self.stock_bundle),
            "patchedBundle": str(self.patched_bundle),
            "knownStockDigests": list(self.known_stock_digests),
            "knownPatchedDigests": list(self.known_patched_digests),
            "allowSyntheticApply": self.allow_synthetic_apply,
        }

    def artifacts(self) -> ArtifactSet:
        return ArtifactSet(
            stock_bundle=self.stock_bundle,
            patched_bundle=self.patched_bundle,
            known_stock_digests=self.known_stock_digests,
            known_patched_digests=self.known_patched_digests,
        )


def parse_host_config(raw: object) -> HostConfig:
    if IS_WINDOWS:
        raise GrokctlError("Windows 客户端不支持本机实验运行时，请连接 Linux 主机", code="unsupported-platform")
    if isinstance(raw, (bytes, bytearray)):
        if len(raw) > MAX_HOST_CONFIG_BYTES:
            raise ValidationError("主机配置过大")
        try:
            raw = json.loads(bytes(raw).decode("utf-8"), parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as exc:
            raise ValidationError("主机配置不是有效的 JSON") from exc
    mapping = _as_mapping(raw, "host")
    for key in mapping:
        normalized = _norm_field(key)
        if normalized in FORBIDDEN_FIELDS:
            raise ValidationError("配置里不能包含密钥，请用 grokctl secret set 单独安装")
        if normalized not in ALLOWED_HOST_FIELDS:
            raise ValidationError("主机配置含有不支持的字段")
    schema = mapping.get("schemaVersion", SCHEMA_VERSION)
    if schema != SCHEMA_VERSION:
        raise ValidationError("schemaVersion 必须是 1")
    mode = _require_str(mapping.get("mode"), "mode")
    if mode != HOST_MODE_LAB_LOCAL_ROOT:
        raise ValidationError("mode 必须是 lab-local-root")
    allow_synthetic_apply = _optional_bool(mapping, "allowSyntheticApply", False)
    host_root = _require_existing_dir(_require_absolute_path(mapping.get("hostRoot"), "hostRoot"), "hostRoot")
    stock = _require_existing_file(
        _require_absolute_path(mapping.get("stockBundle"), "stockBundle"), "stockBundle"
    )
    patched = _require_existing_file(
        _require_absolute_path(mapping.get("patchedBundle"), "patchedBundle"), "patchedBundle"
    )
    known_stock = _parse_digest_list(mapping.get("knownStockDigests"), "knownStockDigests")
    known_patched = _parse_digest_list(mapping.get("knownPatchedDigests"), "knownPatchedDigests")
    stock_digest = sha256_hex(stock.read_bytes())
    patched_digest = sha256_hex(patched.read_bytes())
    if stock_digest not in known_stock:
        raise ValidationError("主机程序校验和不在已知列表中")
    if patched_digest not in known_patched:
        raise ValidationError("主机程序校验和不在已知列表中")
    return HostConfig(
        schema_version=SCHEMA_VERSION,
        mode=mode,
        host_root=host_root,
        stock_bundle=stock,
        patched_bundle=patched,
        known_stock_digests=known_stock,
        known_patched_digests=known_patched,
        allow_synthetic_apply=allow_synthetic_apply,
    )


def host_config_path(home: Path) -> Path:
    return Path(home) / HOST_CONFIG_NAME


def load_host_config(home: Path) -> Optional[HostConfig]:
    path = host_config_path(home)
    if not path.exists() and not path.is_symlink():
        return None
    _file_is_private_regular(path)
    raw = path.read_bytes()
    return parse_host_config(raw)


def save_host_config(home: Path, config: HostConfig) -> HostConfig:
    path = host_config_path(home)
    _file_is_private_regular(path, missing_ok=True)
    text = json.dumps(config.to_canonical_dict(), ensure_ascii=True, sort_keys=True, indent=2) + "\n"
    atomic_replace(path, text.encode("utf-8"), mode=0o600)
    return load_host_config(home) or config


class ExclusiveLock:
    """Owner-only flock. Stale locks are never stolen by pid guessing."""

    def __init__(self, home: Path) -> None:
        self.home = ensure_private_dir(Path(home))
        self.path = self.home / LOCK_NAME

    @contextmanager
    def holding(self) -> Iterator[None]:
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = open_nofollow(self.path, flags)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise ValidationError("控制面锁不能是符号链接") from exc
            raise ValidationError("无法创建控制面锁") from exc
        acquired = False
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise ValidationError("控制面锁必须是普通文件")
            set_private_permissions(self.path, fd=fd)
            try:
                lock_exclusive(fd)
                acquired = True
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                raise BusyError("控制面正在忙") from exc
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            os.write(fd, b"%d\n" % os.getpid())
            os.fsync(fd)
            yield
        finally:
            try:
                if acquired:
                    unlock(fd)
            except OSError:
                pass
            os.close(fd)


class RegistryCatalog:
    """Canonical profiles from the single ProfileRegistry. Official is built-in."""

    def __init__(self, registry: ProfileRegistry) -> None:
        self.registry = registry

    def get(self, profile_id: str) -> dict[str, object]:
        if profile_id == OFFICIAL_ID:
            profile = official_profile()
        else:
            profile = self.registry.get(profile_id)
        return json.loads(canonical_dumps(profile.to_canonical_dict()))


class SecretAwareRuntime:
    """Host runtime that inspects SecretStore and never deletes operator secrets."""

    def __init__(self, runtime: HostRuntime, secrets: SecretStore) -> None:
        self._runtime = runtime
        self._secrets = secrets

    def __getattr__(self, name: str) -> Any:
        return getattr(self._runtime, name)

    def secret_path(self, secret_ref: str) -> Path:
        profile_id = _profile_id_from_ref(secret_ref)
        return self._secrets.path_for(profile_id)

    def inspect_secret(self, secret_ref: str) -> dict[str, object]:
        hop = load_provider_hop()
        return hop.inspect_secret_metadata(self.secret_path(secret_ref))

    def remove_secret(self, secret_ref: str) -> None:
        # Operator SecretStore is the only secret owner. Official deactivation
        # must not delete installed keys from GROKCTL_HOME.
        return


def _profile_id_from_ref(secret_ref: str) -> str:
    text = str(secret_ref or "")
    prefix = "profile/"
    if not text.startswith(prefix) or text == prefix or "/" in text[len(prefix) :]:
        raise SwitchError("missing secret metadata", "missing_secret")
    return text[len(prefix) :]


@contextmanager
def temporary_host_resolver(resolver: Any) -> Iterator[None]:
    """Test-only DNS injection. Always restores the previous resolver."""

    hop = load_provider_hop()
    previous = hop.get_host_resolver()
    hop.set_host_resolver(resolver)
    try:
        yield
    finally:
        hop.set_host_resolver(previous)


def hydrate_runtime(runtime: HostRuntime) -> HostRuntime:
    receipt = None
    try:
        receipt = runtime.current_receipt()
    except HostError:
        receipt = None
    if isinstance(receipt, dict):
        pid = receipt.get("hostPid")
        started = receipt.get("startedAt")
        if isinstance(pid, int) and pid > 0:
            runtime.processes.host_pid = pid
            runtime.processes.next_pid = max(int(runtime.processes.next_pid), pid + 1)
        if isinstance(started, str) and started:
            runtime.processes.host_started_at = started
    hop_pid = None
    try:
        hop_pid = runtime.read_hop_pid()
    except HostError:
        hop_pid = None
    if hop_pid is not None:
        runtime.processes.cmdlines[int(hop_pid)] = runtime.layout.hop_cmdline_token
        cfg_path = runtime.layout.hop_config_path
        if cfg_path.is_file():
            try:
                payload = load_json(cfg_path)
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                payload = {}
            if isinstance(payload, dict):
                runtime.processes.running_hops[int(hop_pid)] = dict(payload)
        runtime.processes.next_pid = max(int(runtime.processes.next_pid), int(hop_pid) + 1)
    return runtime


def build_host_runtime(config: HostConfig) -> HostRuntime:
    if IS_WINDOWS:
        raise GrokctlError("Windows 客户端不支持本机实验运行时，请连接 Linux 主机", code="unsupported-platform")
    runtime = build_runtime(
        config.host_root,
        clock=Clock(),
        ids=UuidSource(),
    )
    hydrate_runtime(runtime)
    return runtime


def build_switch_engine(
    registry: ProfileRegistry,
    secrets: SecretStore,
    config: HostConfig,
    *,
    runtime: Optional[HostRuntime] = None,
) -> SwitchEngine:
    host = runtime if runtime is not None else build_host_runtime(config)
    if not isinstance(host, SecretAwareRuntime):
        host = SecretAwareRuntime(host, secrets)
    return SwitchEngine(host, RegistryCatalog(registry), config.artifacts())


def _mismatch(message: str = "主机状态已变化，请重新查看计划") -> GrokctlError:
    return GrokctlError(message, code="snapshot-mismatch")


def _regular_file(path: Path) -> bytes:
    try:
        st = os.lstat(path)
    except FileNotFoundError as exc:
        raise _mismatch() from exc
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise _mismatch()
    return path.read_bytes()


def current_profile_digest(registry: ProfileRegistry, profile_id: str) -> str:
    if profile_id == OFFICIAL_ID:
        profile = official_profile()
    else:
        profile = registry.get(profile_id)
    return profile.digest()


def verified_switch_back_target(
    runtime: HostRuntime,
    registry: ProfileRegistry,
) -> tuple[str, dict[str, object]]:
    try:
        receipt = runtime.current_receipt()
    except HostError as exc:
        raise GrokctlError(switch_message("missing-receipt"), code="missing-receipt") from exc
    if not isinstance(receipt, dict):
        raise GrokctlError(switch_message("missing-receipt"), code="missing-receipt")
    previous = receipt.get("previousProfile")
    snapshot = receipt.get("previousSnapshot") or {}
    if not isinstance(snapshot, dict):
        raise GrokctlError(switch_message("missing-receipt"), code="missing-receipt")
    snapshot_dir = snapshot.get("snapshotDir")
    snapshot_profile = snapshot.get("profileId")
    if not isinstance(previous, str) or not previous:
        raise GrokctlError(switch_message("missing-receipt"), code="missing-receipt")
    if snapshot_profile != previous:
        raise _mismatch()
    if not isinstance(snapshot_dir, str) or not snapshot_dir:
        raise GrokctlError(switch_message("missing-receipt"), code="missing-receipt")
    path = Path(snapshot_dir)
    try:
        st = os.lstat(path)
    except FileNotFoundError as exc:
        raise GrokctlError(switch_message("missing-receipt"), code="missing-receipt") from exc
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise GrokctlError(switch_message("missing-receipt"), code="missing-receipt")
    bundle_digest = sha256_hex(_regular_file(path / "host-main.cjs"))
    expected_bundle = snapshot.get("bundleDigest")
    if not isinstance(expected_bundle, str) or bundle_digest != expected_bundle:
        raise _mismatch()
    meta_raw = _regular_file(path / "meta.json")
    try:
        meta = json.loads(meta_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _mismatch() from exc
    if not isinstance(meta, dict):
        raise _mismatch()
    state = meta.get("state")
    if not isinstance(state, dict):
        raise _mismatch()
    if state.get("activeProfile") != previous:
        raise _mismatch()
    if int(state.get("generation") or -1) != int(snapshot.get("generation") or -2):
        raise _mismatch()
    try:
        digest = current_profile_digest(registry, previous)
    except GrokctlError as exc:
        raise _mismatch() from exc
    if snapshot.get("profileDigest") != digest:
        raise _mismatch()
    expected_config = snapshot.get("configDigest")
    config_path = path / "external.json"
    if expected_config in {None, ""}:
        if config_path.exists() or config_path.is_symlink():
            raise _mismatch()
    else:
        if not isinstance(expected_config, str):
            raise _mismatch()
        if sha256_hex(_regular_file(config_path)) != expected_config:
            raise _mismatch()
    return previous, receipt


def referenced_profile_ids(runtime: Optional[HostRuntime]) -> set[str]:
    refs: set[str] = set()
    if runtime is None:
        return refs
    observed = runtime.observe()
    if observed.profile_id:
        refs.add(str(observed.profile_id))
    try:
        receipt = runtime.current_receipt()
    except HostError:
        receipt = None
    if not isinstance(receipt, dict):
        return refs
    for key in ("requestedProfile", "previousProfile"):
        value = receipt.get(key)
        if isinstance(value, str) and value:
            refs.add(value)
    snapshot = receipt.get("previousSnapshot") or {}
    if isinstance(snapshot, dict):
        profile_id = snapshot.get("profileId")
        if isinstance(profile_id, str) and profile_id:
            refs.add(profile_id)
    return refs


def collect_blockers(
    *,
    profile_id: str,
    secret_installed: bool,
    secret_rejected: bool,
    secret_required: bool,
    enabled: bool,
    runtime: Optional[HostRuntime],
    config: Optional[HostConfig],
    require_receipt: bool = False,
    registry: Optional[ProfileRegistry] = None,
) -> list[str]:
    blocking: list[str] = []
    if not enabled:
        blocking.append("disabled")
    if secret_required and not secret_installed:
        blocking.append("needs-key")
    if secret_rejected:
        blocking.append("secret-rejected")
    if config is None or runtime is None:
        blocking.append("not-wired")
        return blocking
    if runtime.pending_command() is not None:
        blocking.append("pending-command")
    if runtime.is_busy():
        blocking.append("busy-agent")
    observed = runtime.observe()
    digest = observed.bundle_digest
    if not digest or digest not in config.known_bundle_digests():
        blocking.append("unknown-hash")
    if require_receipt:
        if registry is None:
            blocking.append("missing-receipt")
        else:
            try:
                verified_switch_back_target(runtime, registry)
            except GrokctlError as exc:
                blocking.append(public_switch_code(exc.code))
    return blocking


def public_receipt(receipt: Optional[Mapping[str, object]]) -> Optional[dict[str, object]]:
    if not isinstance(receipt, Mapping):
        return None
    payload = dict(receipt)
    for key in ("secret", "token", "authorization", "apiKey", "secretFile"):
        payload.pop(key, None)
    payload["runtimeKind"] = RUNTIME_KIND_LAB_SYNTHETIC
    return payload


def lab_runtime_fields(config: Optional[HostConfig]) -> dict[str, object]:
    if config is None:
        return {"runtimeKind": None, "allowSyntheticApply": False}
    return {
        "runtimeKind": RUNTIME_KIND_LAB_SYNTHETIC,
        "allowSyntheticApply": bool(config.allow_synthetic_apply),
    }


def status_from_host(
    *,
    home: Path,
    config: Optional[HostConfig],
    runtime: Optional[HostRuntime],
    providers: int,
    secrets_installed: int,
    desired_fallback: str = OFFICIAL_ID,
) -> dict[str, object]:
    desired = desired_fallback
    observed_profile = None
    generation = 0
    drift = False
    last_receipt = None
    blockers: list[str] = []
    host_payload: dict[str, object] = {
        "wired": False,
        "state": "not-wired",
        "mode": None,
        "hostRoot": None,
        "pid": None,
        "startedAt": None,
        "bundleDigest": None,
        "hopHealth": None,
        "hopPid": None,
        "generation": 0,
        "runtimeKind": None,
        "allowSyntheticApply": False,
    }
    active_profile = None
    if config is None or runtime is None:
        blockers.append("not-wired")
        return {
            "schemaVersion": SCHEMA_VERSION,
            "home": str(home),
            "desiredProfile": desired,
            "observedProfile": None,
            "activeProfile": None,
            "generation": 0,
            "drift": False,
            "lastReceipt": None,
            "blocking": blockers,
            "host": host_payload,
            "providers": providers,
            "secretsInstalled": secrets_installed,
            "fallbackPolicy": "never",
            **lab_runtime_fields(None),
        }
    observed = runtime.observe()
    try:
        receipt = runtime.current_receipt()
    except HostError:
        receipt = None
    last_receipt = public_receipt(receipt if isinstance(receipt, dict) else None)
    if isinstance(receipt, dict) and isinstance(receipt.get("requestedProfile"), str):
        desired = str(receipt["requestedProfile"])
    observed_profile = observed.profile_id
    generation = int(observed.generation)
    digest = observed.bundle_digest
    known = digest in config.known_bundle_digests() if digest else False
    if runtime.pending_command() is not None:
        blockers.append("pending-command")
    if runtime.is_busy():
        blockers.append("busy-agent")
    if not known:
        blockers.append("unknown-hash")
    receipt_ok = False
    if isinstance(receipt, dict):
        receipt_ok = (
            receipt.get("requestedProfile") == observed.profile_id
            and int(receipt.get("generation") or -1) == generation
            and receipt.get("bundleDigest") == digest
            and int(receipt.get("hostPid") or -1) == int(observed.pid)
        )
        if not receipt_ok:
            drift = True
            blockers.append("drift")
    elif observed_profile != OFFICIAL_ID or generation != 0:
        drift = True
        blockers.append("missing-receipt")
    if desired != observed_profile:
        drift = True
        if "drift" not in blockers:
            blockers.append("drift")
    host_state = "blocked" if blockers else "healthy"
    if drift and host_state == "healthy":
        host_state = "drifted"
    host_payload = {
        "wired": True,
        "state": host_state,
        "mode": config.mode,
        "hostRoot": str(config.host_root),
        "pid": observed.pid,
        "startedAt": observed.started_at,
        "bundleDigest": digest or None,
        "hopHealth": observed.hop_health,
        "hopPid": observed.hop_pid,
        "generation": generation,
        "runtimeKind": RUNTIME_KIND_LAB_SYNTHETIC,
        "allowSyntheticApply": bool(config.allow_synthetic_apply),
    }
    if not drift and not blockers:
        active_profile = observed_profile
    return {
        "schemaVersion": SCHEMA_VERSION,
        "home": str(home),
        "desiredProfile": desired,
        "observedProfile": observed_profile,
        "activeProfile": active_profile,
        "generation": generation,
        "drift": drift,
        "lastReceipt": last_receipt,
        "blocking": blockers,
        "host": host_payload,
        "providers": providers,
        "secretsInstalled": secrets_installed,
        "fallbackPolicy": "never",
        **lab_runtime_fields(config),
    }
