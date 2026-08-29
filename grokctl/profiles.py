"""Atomic owner-only provider profile registry."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from grokctl.models import (
    OFFICIAL_ID,
    SCHEMA_VERSION,
    ConflictError,
    NotFoundError,
    ProviderProfile,
    ValidationError,
    official_profile,
    parse_profile,
    pretty_dumps,
    validate_profile_id,
)


PROFILES_NAME = "profiles.json"
TMP_PREFIX = ".profiles."


def ensure_private_dir(path: Path) -> Path:
    path = Path(path)
    if path.exists() and path.is_symlink():
        raise ValidationError("主目录不能是符号链接")
    path.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ValidationError("主目录无效")
    os.chmod(path, 0o700)
    return path


def atomic_replace(path: Path, data: bytes, *, mode: int = 0o600) -> None:
    path = Path(path)
    ensure_private_dir(path.parent)
    fd, tmp_name = tempfile.mkstemp(prefix=TMP_PREFIX, dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        os.write(fd, data)
        os.fsync(fd)
        os.fchmod(fd, mode)
    except Exception:
        os.close(fd)
        tmp_path.unlink(missing_ok=True)
        raise
    os.close(fd)
    try:
        os.replace(str(tmp_path), str(path))
        os.chmod(path, mode)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _reject_json_constant(_name: str) -> None:
    raise ValidationError("配置不是有效的 JSON")


def _file_is_private_regular(path: Path) -> None:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if os.path.islink(path):
        raise ValidationError("配置文件不能是符号链接")
    if not os.path.isfile(path):
        raise ValidationError("配置文件必须是普通文件")
    if st.st_mode & 0o077:
        raise ValidationError("配置文件权限必须仅限当前用户")


class ProfileRegistry:
    def __init__(self, home: Path) -> None:
        self.home = ensure_private_dir(Path(home))
        self.path = self.home / PROFILES_NAME

    def load(self) -> dict[str, ProviderProfile]:
        profiles = {OFFICIAL_ID: official_profile()}
        if not self.path.exists():
            return profiles
        _file_is_private_regular(self.path)
        raw = self.path.read_bytes()
        try:
            document = json.loads(raw.decode("utf-8"), parse_constant=_reject_json_constant)
        except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as exc:
            raise ValidationError("配置不是有效的 JSON") from exc
        if not isinstance(document, dict):
            raise ValidationError("配置不是有效的 JSON")
        if document.get("schemaVersion") != SCHEMA_VERSION:
            raise ValidationError("schemaVersion 必须是 1")
        extra = set(document) - {"schemaVersion", "profiles"}
        if extra:
            raise ValidationError("配置含有不支持的字段")
        stored = document.get("profiles", {})
        if not isinstance(stored, dict):
            raise ValidationError("profiles 必须是对象")
        seen: set[str] = set()
        for key, value in stored.items():
            if not isinstance(key, str):
                raise ValidationError("提供方编号必须是文本")
            if key == OFFICIAL_ID:
                continue
            profile_id = validate_profile_id(key, allow_official=False)
            if profile_id in seen:
                raise ValidationError("提供方编号重复")
            seen.add(profile_id)
            profile = parse_profile(value, allow_official=False)
            if profile.id != profile_id:
                raise ValidationError("提供方编号与存储键不一致")
            profiles[profile.id] = profile
        return profiles

    def save(self, profiles: dict[str, ProviderProfile]) -> None:
        document = {
            "schemaVersion": SCHEMA_VERSION,
            "profiles": {
                profile_id: profile.to_canonical_dict()
                for profile_id, profile in sorted(profiles.items())
            },
        }
        atomic_replace(self.path, pretty_dumps(document).encode("utf-8"), mode=0o600)

    def list_profiles(self) -> list[ProviderProfile]:
        profiles = self.load()
        official = profiles[OFFICIAL_ID]
        others = [item for key, item in sorted(profiles.items()) if key != OFFICIAL_ID]
        return [official, *others]

    def get(self, profile_id: str) -> ProviderProfile:
        profile_id = validate_profile_id(profile_id, allow_official=True)
        profiles = self.load()
        if profile_id not in profiles:
            raise NotFoundError(f"未找到提供方 {profile_id}")
        return profiles[profile_id]

    def add(self, raw: Any) -> ProviderProfile:
        profile = parse_profile(raw, allow_official=False)
        profiles = self.load()
        if profile.id in profiles:
            raise ConflictError(f"提供方编号已存在：{profile.id}")
        profiles[profile.id] = profile
        self.save(profiles)
        return self.get(profile.id)

    def remove(self, profile_id: str) -> ProviderProfile:
        profile_id = validate_profile_id(profile_id, allow_official=True)
        if profile_id == OFFICIAL_ID:
            raise ConflictError("官方通道不能删除")
        profiles = self.load()
        if profile_id not in profiles:
            raise NotFoundError(f"未找到提供方 {profile_id}")
        removed = profiles.pop(profile_id)
        self.save(profiles)
        return removed
