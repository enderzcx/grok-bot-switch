"""Owner-only secret store. Values never appear in return objects."""

from __future__ import annotations

import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from grokctl.models import (
    OFFICIAL_ID,
    SECRET_REF_PREFIX,
    SecretError,
    fingerprint_prefix,
    validate_profile_id,
)
from grokctl.profiles import ensure_private_dir


def validate_secret_bytes(data: bytes) -> None:
    if not data:
        raise SecretError("密钥不能为空")
    if any(byte <= 32 or byte == 127 for byte in data):
        raise SecretError("密钥不能包含空白或控制字符")


@dataclass(frozen=True)
class SecretStatus:
    installed: bool
    required: bool = False
    rejected: bool = False
    byte_count: int | None = None
    fingerprint_prefix: str | None = None
    reason: str | None = None

    def to_public_dict(self) -> dict[str, object]:
        return {
            "required": self.required,
            "installed": self.installed,
            "rejected": self.rejected,
            "byteCount": self.byte_count,
            "fingerprintPrefix": self.fingerprint_prefix,
            "reason": self.reason,
        }


class SecretStore:
    def __init__(self, home: Path) -> None:
        self.home = ensure_private_dir(Path(home))
        self.root = ensure_private_dir(self.home / "secrets")

    def path_for(self, profile_id: str) -> Path:
        profile_id = validate_profile_id(profile_id, allow_official=True)
        if profile_id == OFFICIAL_ID:
            raise SecretError("官方通道不使用密钥")
        return self.root / "profile" / profile_id

    def set_from_stream(self, profile_id: str, stream: BinaryIO) -> SecretStatus:
        if hasattr(stream, "buffer"):
            stream = stream.buffer  # type: ignore[assignment]
        data = stream.read()
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, (bytes, bytearray)):
            raise SecretError("密钥必须通过标准输入提供")
        payload = bytes(data)
        validate_secret_bytes(payload)
        path = self.path_for(profile_id)
        ensure_private_dir(path.parent)
        if path.exists() or path.is_symlink():
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode):
                raise SecretError("密钥文件不能是符号链接")
            if not stat.S_ISREG(st.st_mode):
                raise SecretError("密钥文件必须是普通文件")
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
        try:
            fd = os.open(str(path), flags, 0o600)
        except OSError as exc:
            raise SecretError("密钥文件不能是符号链接") from exc
        try:
            os.write(fd, payload)
            os.fsync(fd)
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        payload = b""
        return self.status(profile_id, required=True)

    def remove(self, profile_id: str) -> None:
        path = self.path_for(profile_id)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(st.st_mode):
            raise SecretError("密钥文件不能是符号链接")
        if not stat.S_ISREG(st.st_mode):
            raise SecretError("密钥文件必须是普通文件")
        os.unlink(path)

    def status(self, profile_id: str, *, required: bool = False) -> SecretStatus:
        if profile_id == OFFICIAL_ID:
            return SecretStatus(installed=False, required=False)
        path = self.path_for(profile_id)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return SecretStatus(installed=False, required=required)
        if stat.S_ISLNK(st.st_mode):
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason="密钥文件不能是符号链接",
            )
        if not stat.S_ISREG(st.st_mode):
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason="密钥文件必须是普通文件",
            )
        if st.st_mode & 0o077:
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason="密钥文件权限必须仅限当前用户",
            )
        flags = os.O_RDONLY | os.O_NOFOLLOW
        try:
            fd = os.open(str(path), flags)
        except OSError:
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason="密钥文件不安全",
            )
        try:
            data = os.read(fd, max(st.st_size, 0) + 1)
        finally:
            os.close(fd)
        try:
            validate_secret_bytes(data)
        except SecretError:
            data = b""
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason="密钥内容无效",
            )
        status = SecretStatus(
            installed=True,
            required=required,
            rejected=False,
            byte_count=len(data),
            fingerprint_prefix=fingerprint_prefix(data),
        )
        data = b""
        return status

    def expected_ref(self, profile_id: str) -> str:
        return SECRET_REF_PREFIX + profile_id
