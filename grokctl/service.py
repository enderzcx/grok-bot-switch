"""Shared grokctl service used by the CLI and later local surfaces."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Mapping

from grokctl.models import (
    OFFICIAL_ID,
    SCHEMA_VERSION,
    NotWiredError,
    ProviderProfile,
    SecretError,
    ValidationError,
    official_profile,
    validate_profile_id,
)
from grokctl.profiles import ProfileRegistry, ensure_private_dir
from grokctl.secrets import SecretStatus, SecretStore


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
                if key in {"secret", "token", "authorization", "apiKey"}:
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

    def status(self) -> dict[str, object]:
        profiles = self.registry.list_profiles()
        installed = 0
        for profile in profiles:
            secret = self._secret_for(profile)
            if secret.installed:
                installed += 1
        return {
            "schemaVersion": SCHEMA_VERSION,
            "home": str(self.home),
            "desiredProfile": OFFICIAL_ID,
            "activeProfile": None,
            "host": {"wired": False, "state": "not-wired"},
            "providers": len(profiles),
            "secretsInstalled": installed,
            "fallbackPolicy": "never",
        }

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
        profile = self.registry.add(raw)
        self._append_activity("provider.added", profile_id=profile.id)
        return public_profile(profile, self._secret_for(profile))

    def remove_provider(self, profile_id: str) -> dict[str, object]:
        profile = self.registry.get(profile_id)
        if profile.id != OFFICIAL_ID:
            self.secrets.remove(profile.id)
        removed = self.registry.remove(profile.id)
        self._append_activity("provider.removed", profile_id=removed.id)
        return {"ok": True, "id": removed.id, "removed": True}

    def set_secret(self, profile_id: str, stream: BinaryIO) -> dict[str, object]:
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

    def plan(self, target: str) -> dict[str, object]:
        profile_id = validate_profile_id(target, allow_official=True)
        profile = official_profile() if profile_id == OFFICIAL_ID else self.registry.get(profile_id)
        secret = self._secret_for(profile)
        blocking: list[str] = []
        if profile.requires_secret() and not secret.installed:
            blocking.append("needs-key")
        if secret.rejected:
            blocking.append("secret-rejected")
        plan = {
            "schemaVersion": SCHEMA_VERSION,
            "dryRun": True,
            "apply": False,
            "action": "use",
            "target": profile.id,
            "current": OFFICIAL_ID,
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
            "wired": False,
            "blocking": blocking,
        }
        self._append_activity("plan.generated", profile_id=profile.id, extra={"action": "use"})
        return plan

    def use(self, target: str, *, apply: bool = False) -> dict[str, object]:
        plan = self.plan(target)
        if not apply:
            return plan
        raise NotWiredError("远程切换尚未接入")

    def verify(self, *, live: bool = False) -> dict[str, object]:
        if live:
            raise NotWiredError("在线校验尚未接入")
        return self.test_profile(OFFICIAL_ID, live=False)

    def rollback(self, *, apply: bool = False) -> dict[str, object]:
        plan = {
            "schemaVersion": SCHEMA_VERSION,
            "dryRun": not apply,
            "apply": apply,
            "action": "rollback",
            "target": OFFICIAL_ID,
            "snapshot": False,
            "hostMutation": False,
            "wired": False,
            "blocking": ["not-wired"],
        }
        if apply:
            raise NotWiredError("远程回滚尚未接入")
        self._append_activity("plan.generated", profile_id=OFFICIAL_ID, extra={"action": "rollback"})
        return plan

    def activity(self, *, limit: int = 50) -> dict[str, object]:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 1000:
            raise ValidationError("limit 必须是 1 到 1000 的整数")
        events: list[dict[str, object]] = []
        if self.activity_path.exists():
            if self.activity_path.is_symlink():
                raise ValidationError("活动记录文件不能是符号链接")
            text = self.activity_path.read_text(encoding="utf-8")
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
