"""Owner-only secret store. Values never appear in return objects."""

from __future__ import annotations

import errno
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
from grokctl.platform_security import open_nofollow, private_permissions, reject_links, set_private_permissions


MAX_SECRET_BYTES = 64 * 1024
SECRET_TMP_PREFIX = ".secret."
READ_CHUNK = 4096


def validate_secret_bytes(data: bytes) -> None:
    if not data:
        raise SecretError("密钥不能为空")
    if any(byte <= 32 or byte == 127 for byte in data):
        raise SecretError("密钥不能包含空白或控制字符")
    if len(data) > MAX_SECRET_BYTES:
        raise SecretError("密钥过大")


def _unlink_quiet(path: Path | None) -> None:
    if path is None:
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        return


def fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    directory = getattr(os, "O_DIRECTORY", 0)
    if directory:
        flags |= directory
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        return
    finally:
        os.close(fd)


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        written = os.write(fd, view[offset:])
        if written <= 0:
            raise SecretError("密钥写入失败")
        offset += written


def _read_stream_bounded(stream: BinaryIO) -> bytes:
    if hasattr(stream, "buffer"):
        buffered = getattr(stream, "buffer")
        if buffered is not None and buffered is not stream:
            stream = buffered
    chunks: list[bytes] = []
    total = 0
    sized = True
    try:
        stream.read(0)
    except TypeError:
        sized = False
    while True:
        try:
            chunk = stream.read(READ_CHUNK if sized else -1)
        except TypeError:
            chunk = stream.read()
            sized = False
        if chunk is None or chunk == b"" or chunk == "":
            break
        if isinstance(chunk, str):
            chunk = chunk.encode("utf-8")
        if not isinstance(chunk, (bytes, bytearray)):
            raise SecretError("密钥必须通过标准输入提供")
        total += len(chunk)
        if total > MAX_SECRET_BYTES:
            raise SecretError("密钥过大")
        chunks.append(bytes(chunk))
        if not sized:
            break
    payload = b"".join(chunks)
    if len(payload) > MAX_SECRET_BYTES:
        raise SecretError("密钥过大")
    return payload


def _read_complete(fd: int, expected: int) -> tuple[bytes, str | None]:
    if expected > MAX_SECRET_BYTES:
        return b"", "密钥文件过大"
    if expected < 0:
        return b"", "密钥文件不安全"
    buf = bytearray()
    while len(buf) < expected:
        chunk = os.read(fd, expected - len(buf))
        if not chunk:
            return bytes(buf), "密钥文件大小已变化"
        buf.extend(chunk)
        if len(buf) > MAX_SECRET_BYTES:
            return b"", "密钥文件过大"
    extra = os.read(fd, 1)
    if extra:
        return b"", "密钥文件大小已变化"
    return bytes(buf), None


def _reject_unsafe_existing(path: Path) -> None:
    try:
        reject_links(path)
    except OSError as exc:
        raise SecretError("密钥文件不能是符号链接或重解析点") from exc
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(st.st_mode):
        raise SecretError("密钥文件不能是符号链接")
    if not stat.S_ISREG(st.st_mode):
        raise SecretError("密钥文件必须是普通文件")


def _open_exclusive_temp(directory: Path, prefix: str) -> tuple[int, Path]:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    for _ in range(32):
        candidate = directory / (prefix + os.urandom(8).hex())
        try:
            fd = open_nofollow(candidate, flags)
        except FileExistsError:
            continue
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise SecretError("密钥文件不能是符号链接") from exc
            raise SecretError("密钥写入失败") from exc
        return fd, candidate
    raise SecretError("无法创建临时密钥文件")


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
        payload = _read_stream_bounded(stream)
        validate_secret_bytes(payload)
        path = self.path_for(profile_id)
        ensure_private_dir(path.parent)
        _reject_unsafe_existing(path)
        fd: int | None = None
        tmp: Path | None = None
        try:
            fd, tmp = _open_exclusive_temp(path.parent, SECRET_TMP_PREFIX)
            set_private_permissions(tmp, fd=fd)
            _write_all(fd, payload)
            os.fsync(fd)
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or not private_permissions(tmp, st, fd=fd) or st.st_size != len(payload):
                raise SecretError("密钥文件不安全")
            os.close(fd)
            fd = None
            os.replace(str(tmp), str(path))
            tmp = None
            fsync_directory(path.parent)
        except SecretError:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            _unlink_quiet(tmp)
            raise
        except Exception as exc:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            _unlink_quiet(tmp)
            raise SecretError("密钥写入失败") from exc
        payload = b""
        return self.status(profile_id, required=True)

    def remove(self, profile_id: str) -> None:
        path = self.path_for(profile_id)
        _reject_unsafe_existing(path)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(st.st_mode):
            raise SecretError("密钥文件不能是符号链接")
        if not stat.S_ISREG(st.st_mode):
            raise SecretError("密钥文件必须是普通文件")
        os.unlink(path)

    def quarantine(self, profile_id: str) -> Path | None:
        path = self.path_for(profile_id)
        _reject_unsafe_existing(path)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            return None
        if stat.S_ISLNK(st.st_mode):
            raise SecretError("密钥文件不能是符号链接")
        if not stat.S_ISREG(st.st_mode):
            raise SecretError("密钥文件必须是普通文件")
        tombstone = path.parent / f".{path.name}.tombstone.{os.urandom(8).hex()}"
        try:
            os.replace(str(path), str(tombstone))
            fsync_directory(path.parent)
        except OSError as exc:
            raise SecretError("无法隔离密钥文件") from exc
        return tombstone

    def restore(self, profile_id: str, tombstone: Path) -> None:
        path = self.path_for(profile_id)
        _reject_unsafe_existing(path)
        _reject_unsafe_existing(tombstone)
        try:
            st = os.lstat(tombstone)
        except FileNotFoundError as exc:
            raise SecretError("密钥备份不存在") from exc
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            raise SecretError("密钥备份不安全")
        try:
            os.replace(str(tombstone), str(path))
            fsync_directory(path.parent)
        except OSError as exc:
            raise SecretError("无法恢复密钥文件") from exc

    def discard_tombstone(self, tombstone: Path | None) -> None:
        if tombstone is None:
            return
        _reject_unsafe_existing(tombstone)
        try:
            st = os.lstat(tombstone)
        except FileNotFoundError:
            return
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            raise SecretError("密钥备份不安全")
        os.unlink(tombstone)

    def status(self, profile_id: str, *, required: bool = False) -> SecretStatus:
        if profile_id == OFFICIAL_ID:
            return SecretStatus(installed=False, required=False)
        path = self.path_for(profile_id)
        try:
            _reject_unsafe_existing(path)
        except SecretError:
            return SecretStatus(installed=False, required=required, rejected=True, reason="密钥文件不安全")
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
        if not private_permissions(path, st):
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason="密钥文件权限必须仅限当前用户",
            )
        if st.st_size > MAX_SECRET_BYTES:
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason="密钥文件过大",
            )
        flags = os.O_RDONLY
        try:
            fd = open_nofollow(path, flags)
        except OSError:
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason="密钥文件不安全",
            )
        try:
            if not private_permissions(path, fd=fd):
                return SecretStatus(installed=False, required=required, rejected=True, reason="密钥文件权限必须仅限当前用户")
            data, reason = _read_complete(fd, st.st_size)
        finally:
            os.close(fd)
        if reason:
            data = b""
            return SecretStatus(
                installed=False,
                required=required,
                rejected=True,
                reason=reason,
            )
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
