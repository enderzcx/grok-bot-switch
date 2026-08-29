"""Shared grokctl service used by the CLI and later local surfaces."""

from __future__ import annotations

import json
import os
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Mapping, Optional

from grokctl.integration import (
    ExclusiveLock,
    HostConfig,
    RUNTIME_KIND_LAB_SYNTHETIC,
    SecretAwareRuntime,
    build_host_runtime,
    build_switch_engine,
    collect_blockers,
    lab_runtime_fields,
    load_host_config,
    parse_host_config,
    public_switch_code,
    public_receipt,
    raise_switch_error,
    referenced_profile_ids,
    save_host_config,
    status_from_host,
    switch_message,
    verified_switch_back_target,
)
from grokctl.models import (
    OFFICIAL_ID,
    SCHEMA_VERSION,
    ConflictError,
    GrokctlError,
    NotWiredError,
    ProviderProfile,
    SecretError,
    ValidationError,
    official_profile,
    validate_profile_id,
)
from grokctl.profiles import ProfileRegistry, ensure_private_dir
from grokctl.secrets import SecretStatus, SecretStore
from grokctl.switching import ActivationPlan, SwitchError


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def profile_state(profile: ProviderProfile, secret: SecretStatus) -> str:
    if secret.rejected:
        return "invalid"
    if profile.requires_secret() and not secret.installed:
        return "needs-key"
    return "ready"


def public_profile(profile: ProviderProfile, secret: SecretStatus) -> dict[str, object]:
    payload = profile.to_canonical_dict()
    payload["resolvedMethod"] = profile.resolved_method()
    payload["resolvedEndpoint"] = profile.resolved_endpoint()
    payload["authType"] = profile.auth.type.value
    payload["state"] = profile_state(profile, secret)
    payload["secret"] = secret.to_public_dict()
    return payload


class GrokctlService:
    def __init__(self, home: Path) -> None:
        self.home = ensure_private_dir(Path(home))
        self.registry = ProfileRegistry(self.home)
        self.secrets = SecretStore(self.home)
        self.activity_path = self.home / "activity.jsonl"
        self._lock = ExclusiveLock(self.home)

    def _secret_for(self, profile: ProviderProfile) -> SecretStatus:
        return self.secrets.status(profile.id, required=profile.requires_secret())

    def _append_activity(self, event_type: str, *, profile_id: str | None = None, extra: Mapping[str, object] | None = None) -> None:
        event: dict[str, object] = {
            "at": utc_now(),
            "type": event_type,
            "ok": True,
        }
        if profile_id is not None:
            event["profileId"] = profile_id
        if extra:
            for key, value in extra.items():
                if key in {"secret", "token", "authorization", "apiKey", "secretFile"}:
                    continue
                event[key] = value
        line = json.dumps(event, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n"
        ensure_private_dir(self.home)
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
        try:
            fd = os.open(str(self.activity_path), flags, 0o600)
        except OSError as exc:
            raise ValidationError("活动记录文件不安全") from exc
        try:
            os.write(fd, line.encode("ascii"))
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)

    def _profile(self, target: str) -> ProviderProfile:
        profile_id = validate_profile_id(target, allow_official=True)
        if profile_id == OFFICIAL_ID:
            return official_profile()
        return self.registry.get(profile_id)

    def _host(self) -> tuple[Optional[HostConfig], Optional[SecretAwareRuntime]]:
        config = load_host_config(self.home)
        if config is None:
            return None, None
        runtime = SecretAwareRuntime(build_host_runtime(config), self.secrets)
        return config, runtime

    def _engine(self, config: HostConfig, runtime: SecretAwareRuntime):
        return build_switch_engine(self.registry, self.secrets, config, runtime=runtime)

    def configure_host(self, raw: Any) -> dict[str, object]:
        with self._lock.holding():
            config = parse_host_config(raw)
            saved = save_host_config(self.home, config)
            self._append_activity("host.configured", extra={"mode": saved.mode, "hostRoot": str(saved.host_root)})
            payload = saved.to_canonical_dict()
            payload.update(lab_runtime_fields(saved))
            return payload

    def show_host(self) -> dict[str, object]:
        config = load_host_config(self.home)
        if config is None:
            raise NotWiredError("尚未配置本机根目录")
        payload = config.to_canonical_dict()
        payload.update(lab_runtime_fields(config))
        return payload

    def status(self) -> dict[str, object]:
        profiles = self.registry.list_profiles()
        installed = 0
        for profile in profiles:
            secret = self._secret_for(profile)
            if secret.installed:
                installed += 1
        config, runtime = self._host()
        return status_from_host(
            home=self.home,
            config=config,
            runtime=runtime,
            providers=len(profiles),
            secrets_installed=installed,
        )

    def list_providers(self) -> dict[str, object]:
        providers = [
            public_profile(profile, self._secret_for(profile))
            for profile in self.registry.list_profiles()
        ]
        return {"schemaVersion": SCHEMA_VERSION, "providers": providers}

    def show_provider(self, profile_id: str) -> dict[str, object]:
        profile = self.registry.get(profile_id)
        return public_profile(profile, self._secret_for(profile))

    def add_provider(self, raw: Any) -> dict[str, object]:
        with self._lock.holding():
            profile = self.registry.add(raw)
            self._append_activity("provider.added", profile_id=profile.id)
            return public_profile(profile, self._secret_for(profile))

    def remove_provider(self, profile_id: str) -> dict[str, object]:
        with self._lock.holding():
            profile = self.registry.get(profile_id)
            _config, runtime = self._host()
            if profile.id in referenced_profile_ids(runtime):
                raise ConflictError("该提供方正在使用，不能删除")
            tombstone = None
            if profile.id != OFFICIAL_ID:
                tombstone = self.secrets.quarantine(profile.id)
            try:
                removed = self.registry.remove(profile.id)
            except Exception:
                if tombstone is not None:
                    self.secrets.restore(profile.id, tombstone)
                raise
            self.secrets.discard_tombstone(tombstone)
            self._append_activity("provider.removed", profile_id=removed.id)
            return {"ok": True, "id": removed.id, "removed": True}

    def set_secret(self, profile_id: str, stream: BinaryIO) -> dict[str, object]:
        with self._lock.holding():
            profile = self.registry.get(profile_id)
            if profile.id == OFFICIAL_ID or profile.mode == "official":
                raise SecretError("官方通道不使用密钥")
            status = self.secrets.set_from_stream(profile.id, stream)
            self._append_activity(
                "secret.set",
                profile_id=profile.id,
                extra={
                    "byteCount": status.byte_count,
                    "fingerprintPrefix": status.fingerprint_prefix,
                },
            )
            return {
                "ok": True,
                "id": profile.id,
                "secret": status.to_public_dict(),
            }

    def remove_secret(self, profile_id: str) -> dict[str, object]:
        with self._lock.holding():
            profile = self.registry.get(profile_id)
            self.secrets.remove(profile.id)
            self._append_activity("secret.removed", profile_id=profile.id)
            return {"ok": True, "id": profile.id, "removed": True}

    def test_profile(self, profile_id: str, *, live: bool = False) -> dict[str, object]:
        if live:
            raise NotWiredError("在线测试尚未接入")
        profile = self.registry.get(profile_id)
        secret = self._secret_for(profile)
        checks = [
            {"name": "schema", "ok": True},
            {
                "name": "endpoint",
                "ok": True,
                "resolvedMethod": profile.resolved_method(),
                "resolvedEndpoint": profile.resolved_endpoint(),
            },
        ]
        secret_ok = (not profile.requires_secret()) or (secret.installed and not secret.rejected)
        checks.append(
            {
                "name": "secret",
                "ok": secret_ok,
                "required": profile.requires_secret(),
                "installed": secret.installed,
                "rejected": secret.rejected,
            }
        )
        result = {
            "ok": all(item["ok"] is True for item in checks),
            "live": False,
            "profileId": profile.id,
            "resolvedMethod": profile.resolved_method(),
            "resolvedEndpoint": profile.resolved_endpoint(),
            "checks": checks,
            "state": profile_state(profile, secret),
        }
        self._append_activity(
            "test.completed",
            profile_id=profile.id,
            extra={"ok": result["ok"], "live": False},
        )
        return result

    def _base_plan(
        self,
        profile: ProviderProfile,
        *,
        action: str,
        apply: bool,
        current: str,
        blocking: list[str],
        wired: bool,
    ) -> dict[str, object]:
        secret = self._secret_for(profile)
        return {
            "schemaVersion": SCHEMA_VERSION,
            "dryRun": not apply,
            "apply": apply,
            "action": action,
            "target": profile.id,
            "current": current,
            "protocol": None if profile.protocol is None else profile.protocol.value,
            "model": profile.model,
            "authType": profile.auth.type.value,
            "resolvedMethod": profile.resolved_method(),
            "resolvedEndpoint": profile.resolved_endpoint(),
            "fallbackPolicy": profile.fallback_policy.value,
            "secret": {
                "required": profile.requires_secret(),
                "installed": secret.installed,
                "rejected": secret.rejected,
            },
            "hostMutation": False,
            "wired": wired,
            "blocking": blocking,
            "liveVerified": False,
            "runtimeKind": RUNTIME_KIND_LAB_SYNTHETIC if wired else None,
        }

    def _merge_engine_plan(self, payload: dict[str, object], plan: ActivationPlan) -> dict[str, object]:
        data = plan.to_dict()
        payload.update(
            {
                "transactionId": data.get("transactionId"),
                "generation": data.get("generation"),
                "profileDigest": data.get("profileDigest"),
                "bundleDigest": data.get("bundleDigest"),
                "previousProfile": data.get("previousProfile"),
                "targetKind": data.get("targetKind"),
                "stagedPaths": data.get("stagedPaths"),
                "supervisorCommandId": data.get("supervisorCommandId"),
                "observedPid": data.get("observedPid"),
                "observedStartedAt": data.get("observedStartedAt"),
                "hopHealth": data.get("hopHealth"),
                "previousSnapshot": data.get("previousSnapshot"),
                "resolvedEndpoint": data.get("resolvedEndpoint") or payload.get("resolvedEndpoint"),
                "protocol": data.get("protocol") if data.get("protocol") is not None else payload.get("protocol"),
                "model": data.get("model") if data.get("model") is not None else payload.get("model"),
                "authType": data.get("authType") or payload.get("authType"),
                "liveVerified": False,
            }
        )
        return payload

    def plan(self, target: str) -> dict[str, object]:
        profile = self._profile(target)
        secret = self._secret_for(profile)
        config, runtime = self._host()
        wired = config is not None and runtime is not None
        current = OFFICIAL_ID
        if runtime is not None:
            current = runtime.observe().profile_id
        blocking = collect_blockers(
            profile_id=profile.id,
            secret_installed=secret.installed,
            secret_rejected=secret.rejected,
            secret_required=profile.requires_secret(),
            enabled=profile.enabled,
            runtime=runtime,
            config=config,
        )
        payload = self._base_plan(
            profile,
            action="use",
            apply=False,
            current=current,
            blocking=blocking,
            wired=wired,
        )
        payload.update(lab_runtime_fields(config))
        if wired and not blocking:
            try:
                engine_plan = self._engine(config, runtime).plan(profile.id)
            except (SwitchError, Exception) as exc:
                if isinstance(exc, SwitchError):
                    payload["blocking"] = [exc.code.replace("_", "-")]
                    return payload
                raise_switch_error(exc)
            payload = self._merge_engine_plan(payload, engine_plan)
        self._append_activity("plan.generated", profile_id=profile.id, extra={"action": "use"})
        return payload

    def use(self, target: str, *, apply: bool = False) -> dict[str, object]:
        if not apply:
            return self.plan(target)
        with self._lock.holding():
            return self._apply_use_locked(target)

    def _apply_use_locked(self, target: str) -> dict[str, object]:
        profile = self._profile(target)
        secret = self._secret_for(profile)
        config, runtime = self._host()
        if config is None or runtime is None:
            raise NotWiredError("尚未配置本机根目录")
        if not config.allow_synthetic_apply:
            raise GrokctlError(switch_message("lab-runtime"), code="lab-runtime")
        current = runtime.observe().profile_id
        blocking = collect_blockers(
            profile_id=profile.id,
            secret_installed=secret.installed,
            secret_rejected=secret.rejected,
            secret_required=profile.requires_secret(),
            enabled=profile.enabled,
            runtime=runtime,
            config=config,
        )
        if blocking:
            raise ValidationError("无法切换：" + "、".join(switch_message(item) for item in blocking))
        engine = self._engine(config, runtime)
        try:
            engine_plan = engine.plan(profile.id)
            receipt = engine.apply(engine_plan, apply=True)
        except Exception as exc:
            raise_switch_error(exc)
        payload = self._base_plan(
            profile,
            action="use",
            apply=True,
            current=current,
            blocking=[],
            wired=True,
        )
        payload = self._merge_engine_plan(payload, engine_plan)
        payload["dryRun"] = False
        payload["apply"] = True
        payload["hostMutation"] = True
        payload["receipt"] = public_receipt(receipt.to_dict())
        payload.update(lab_runtime_fields(config))
        payload["liveVerified"] = False
        self._append_activity(
            "switch.applied",
            profile_id=profile.id,
            extra={
                "transactionId": receipt.transaction_id,
                "generation": receipt.generation,
                "previousProfile": receipt.previous_profile,
            },
        )
        return payload

    def verify(self, *, live: bool = False) -> dict[str, object]:
        if live:
            raise NotWiredError("在线校验尚未接入")
        config, runtime = self._host()
        if config is None or runtime is None:
            return self.test_profile(OFFICIAL_ID, live=False)
        status = self.status()
        observed_id = status.get("observedProfile") or OFFICIAL_ID
        profile = self._profile(str(observed_id))
        secret = self._secret_for(profile)
        blocking = list(status.get("blocking") or [])
        checks = [
            {"name": "host-wired", "ok": True},
            {"name": "bundle", "ok": "unknown-hash" not in blocking, "digest": status["host"].get("bundleDigest")},
            {"name": "receipt", "ok": "missing-receipt" not in blocking and "drift" not in blocking},
            {"name": "supervisor", "ok": "pending-command" not in blocking and "busy-agent" not in blocking},
            {
                "name": "secret",
                "ok": (not profile.requires_secret()) or (secret.installed and not secret.rejected),
                "required": profile.requires_secret(),
                "installed": secret.installed,
                "rejected": secret.rejected,
            },
        ]
        ok = all(item["ok"] is True for item in checks) and not status.get("drift")
        result = {
            "ok": ok,
            "live": False,
            "profileId": profile.id,
            "resolvedMethod": profile.resolved_method(),
            "resolvedEndpoint": profile.resolved_endpoint(),
            "protocol": None if profile.protocol is None else profile.protocol.value,
            "model": profile.model,
            "authType": profile.auth.type.value,
            "fallbackPolicy": profile.fallback_policy.value,
            "state": "drifted" if status.get("drift") else ("blocked" if blocking else "active"),
            "drift": bool(status.get("drift")),
            "blocking": blocking,
            "checks": checks,
            "generation": status.get("generation"),
            "hostPid": status["host"].get("pid"),
            "startedAt": status["host"].get("startedAt"),
            "bundleDigest": status["host"].get("bundleDigest"),
            "hopHealth": status["host"].get("hopHealth"),
            "lastReceipt": status.get("lastReceipt"),
        }
        self._append_activity(
            "verify.completed",
            profile_id=profile.id,
            extra={"ok": result["ok"], "live": False},
        )
        return result

    def rollback(self, *, apply: bool = False) -> dict[str, object]:
        return self.switch_back(apply=apply)

    def switch_back(self, *, apply: bool = False) -> dict[str, object]:
        if apply:
            with self._lock.holding():
                return self._switch_back_locked(apply=True)
        return self._switch_back_locked(apply=False)

    def _switch_back_locked(self, *, apply: bool) -> dict[str, object]:
        config, runtime = self._host()
        if config is None or runtime is None:
            payload = {
                "schemaVersion": SCHEMA_VERSION,
                "dryRun": not apply,
                "apply": apply,
                "action": "switch-back",
                "target": OFFICIAL_ID,
                "snapshot": False,
                "hostMutation": False,
                "wired": False,
                "blocking": ["not-wired"],
                "liveVerified": False,
                "exactRestore": False,
            }
            payload.update(lab_runtime_fields(None))
            if apply:
                raise NotWiredError("尚未配置本机根目录")
            self._append_activity("plan.generated", profile_id=OFFICIAL_ID, extra={"action": "switch-back"})
            return payload
        if apply and not config.allow_synthetic_apply:
            raise GrokctlError(switch_message("lab-runtime"), code="lab-runtime")
        blocking = collect_blockers(
            profile_id=OFFICIAL_ID,
            secret_installed=True,
            secret_rejected=False,
            secret_required=False,
            enabled=True,
            runtime=runtime,
            config=config,
            require_receipt=True,
            registry=self.registry,
        )
        target_id = None
        receipt = None
        verify_error: GrokctlError | None = None
        try:
            target_id, receipt = verified_switch_back_target(runtime, self.registry)
            blocking = [item for item in blocking if item not in {"missing-receipt", "snapshot-mismatch"}]
        except GrokctlError as exc:
            verify_error = exc
            code = public_switch_code(exc.code)
            if code not in blocking:
                blocking.append(code)
        current = runtime.observe().profile_id
        if target_id is None:
            payload = {
                "schemaVersion": SCHEMA_VERSION,
                "dryRun": not apply,
                "apply": apply,
                "action": "switch-back",
                "target": None,
                "current": current,
                "snapshot": False,
                "hostMutation": False,
                "wired": True,
                "blocking": blocking,
                "liveVerified": False,
                "fallbackPolicy": "never",
                "exactRestore": False,
            }
            payload.update(lab_runtime_fields(config))
            if apply:
                if verify_error is not None:
                    raise verify_error
                raise ValidationError("无法切回：" + "、".join(switch_message(item) for item in blocking))
            self._append_activity("plan.generated", extra={"action": "switch-back"})
            return payload
        profile = self._profile(target_id)
        secret = self._secret_for(profile)
        extra = collect_blockers(
            profile_id=profile.id,
            secret_installed=secret.installed,
            secret_rejected=secret.rejected,
            secret_required=profile.requires_secret(),
            enabled=profile.enabled,
            runtime=runtime,
            config=config,
        )
        for item in extra:
            if item not in blocking:
                blocking.append(item)
        payload = self._base_plan(
            profile,
            action="switch-back",
            apply=apply,
            current=current,
            blocking=blocking,
            wired=True,
        )
        payload.update(lab_runtime_fields(config))
        payload["snapshot"] = True
        payload["exactRestore"] = False
        payload["previousReceipt"] = public_receipt(receipt)
        if not apply:
            self._append_activity("plan.generated", profile_id=profile.id, extra={"action": "switch-back"})
            return payload
        if blocking:
            raise ValidationError("无法切回：" + "、".join(switch_message(item) for item in blocking))
        engine = self._engine(config, runtime)
        try:
            engine_plan = engine.plan(profile.id)
            applied = engine.apply(engine_plan, apply=True)
        except Exception as exc:
            raise_switch_error(exc)
        payload = self._merge_engine_plan(payload, engine_plan)
        payload["dryRun"] = False
        payload["apply"] = True
        payload["hostMutation"] = True
        payload["blocking"] = []
        payload["receipt"] = public_receipt(applied.to_dict())
        payload.update(lab_runtime_fields(config))
        payload["liveVerified"] = False
        payload["exactRestore"] = False
        self._append_activity(
            "switch.switched_back",
            profile_id=profile.id,
            extra={
                "transactionId": applied.transaction_id,
                "generation": applied.generation,
                "previousProfile": applied.previous_profile,
            },
        )
        return payload

    def activity(self, *, limit: int = 50) -> dict[str, object]:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 1000:
            raise ValidationError("limit 必须是 1 到 1000 的整数")
        events: list[dict[str, object]] = []
        try:
            st = os.lstat(self.activity_path)
        except FileNotFoundError:
            return {"schemaVersion": SCHEMA_VERSION, "events": []}
        if stat.S_ISLNK(st.st_mode):
            raise ValidationError("活动记录文件不能是符号链接")
        if not stat.S_ISREG(st.st_mode):
            raise ValidationError("活动记录文件必须是普通文件")
        if st.st_mode & 0o077:
            raise ValidationError("活动记录文件权限必须仅限当前用户")
        try:
            fd = os.open(str(self.activity_path), os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as exc:
            raise ValidationError("活动记录文件不安全") from exc
        try:
            chunks: list[bytes] = []
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
            raw = b"".join(chunks)
        finally:
            os.close(fd)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValidationError("活动记录不是有效文本") from exc
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                events.append(item)
        return {"schemaVersion": SCHEMA_VERSION, "events": events[-limit:]}

    def ui(self, *, port: int = 0) -> dict[str, object]:
        raise NotWiredError("本地面板尚未接入")
