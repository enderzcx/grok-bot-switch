"""Pinned Windows adapter installation. Never starts, kills, or elevates a client."""
from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import uuid
from pathlib import Path

from grokctl import asar_patch
from grokctl.platform_security import open_nofollow, private_permissions, reject_links, set_private_permissions
from grokctl.profiles import atomic_replace, ensure_private_dir

STOCK_SHA256 = "3476b583b2757ec94b155197a20d0ebe0123929ec280483726cc3d8d6caa5591"
VERSION = "0.28.0"
ANCHOR = "const installedHome = null; // INSTALL_HOME_PLACEHOLDER"


class ClientInstallError(RuntimeError):
    def __init__(self, code: str, *, recovery: dict | None = None):
        self.code, self.recovery = code, recovery
        super().__init__(code)


def _windows_only():
    if sys.platform != "win32":
        raise ClientInstallError("unsupported-platform")


def _read(path: Path, *, private=False, limit=asar_patch.MAX_ARCHIVE_SIZE) -> bytes:
    reject_links(path)
    fd = open_nofollow(path, os.O_RDONLY)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ClientInstallError("unsafe-file")
        if private and (not private_permissions(path, info, fd=fd) or (os.name != "nt" and info.st_uid != os.getuid())):
            raise ClientInstallError("unsafe-file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        if len(raw) > limit:
            raise ClientInstallError("unsafe-file")
        return raw
    finally:
        os.close(fd)


def _sha(path: Path, *, private=False) -> str:
    return hashlib.sha256(_read(path, private=private)).hexdigest()


def _exclusive(path: Path, raw: bytes, *, private=False):
    fd = open_nofollow(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    try:
        if private:
            set_private_permissions(path, fd=fd)
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    if _read(path, private=private) != raw:
        raise ClientInstallError("write-readback-failed")


def _target(installation: dict) -> tuple[Path, Path]:
    root, executable = Path(installation["path"]), Path(installation["executable"])
    if not root.is_absolute() or not executable.is_absolute() or executable != root / "Grok Bot.exe" or installation.get("version") != VERSION:
        raise ClientInstallError("unsupported-installation")
    for path in (root, executable, root / "resources", root / "resources" / "app.asar"):
        reject_links(path)
    if not executable.is_file():
        raise ClientInstallError("unsupported-installation")
    target = root / "resources" / "app.asar"
    header, payload, _ = asar_patch._parse(_read(target))
    entry = header["files"]["package.json"]
    if any(key in entry for key in ("link", "unpacked", "files")) or entry.get("size", 65537) > 65536:
        raise ClientInstallError("unsupported-installation")
    offset = asar_patch._offset(entry, len(payload))
    package = json.loads(payload[offset:offset + entry["size"]])
    if not isinstance(package, dict) or package.get("productName") != "Grok Bot" or package.get("name") != "sand" or package.get("version") != VERSION:
        raise ClientInstallError("unsupported-installation")
    return executable, target


def _assert_not_running(executable: Path):
    """Enumerate native processes; inaccessible same-name processes are busy."""
    import ctypes as c
    from ctypes import wintypes as w

    class Entry(c.Structure):
        _fields_ = [("dwSize", w.DWORD), ("cntUsage", w.DWORD), ("pid", w.DWORD),
                    ("heap", c.c_size_t), ("module", w.DWORD), ("threads", w.DWORD),
                    ("parent", w.DWORD), ("priority", w.LONG), ("flags", w.DWORD), ("name", w.WCHAR * 260)]

    kernel = c.WinDLL("kernel32", use_last_error=True)
    def api(name, args, result=w.BOOL):
        fn = getattr(kernel, name)
        fn.argtypes, fn.restype = args, result
        return fn
    snapshot = api("CreateToolhelp32Snapshot", [w.DWORD, w.DWORD], w.HANDLE)
    first = api("Process32FirstW", [w.HANDLE, c.POINTER(Entry)])
    next_entry = api("Process32NextW", [w.HANDLE, c.POINTER(Entry)])
    open_process = api("OpenProcess", [w.DWORD, w.BOOL, w.DWORD], w.HANDLE)
    query = api("QueryFullProcessImageNameW", [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)])
    close = api("CloseHandle", [w.HANDLE])
    handle = snapshot(2, 0)
    if handle == w.HANDLE(-1).value:
        raise ClientInstallError("process-check-failed")
    try:
        entry = Entry(dwSize=c.sizeof(Entry))
        success = first(handle, c.byref(entry))
        while success:
            if entry.name.casefold() == executable.name.casefold():
                process = open_process(0x1000, False, entry.pid)
                if not process:
                    raise ClientInstallError("client-busy")
                try:
                    length, buffer = w.DWORD(32768), c.create_unicode_buffer(32768)
                    if not query(process, 0, buffer, c.byref(length)):
                        raise ClientInstallError("client-busy")
                    if os.path.normcase(os.path.normpath(buffer.value)) == os.path.normcase(os.path.normpath(str(executable))):
                        raise ClientInstallError("client-busy")
                finally:
                    close(process)
            success = next_entry(handle, c.byref(entry))
        if c.get_last_error() != 18:  # ERROR_NO_MORE_FILES
            raise ClientInstallError("process-check-failed")
    finally:
        close(handle)


def _replace_windows(target: Path, staged: Path, previous: Path):
    """ReplaceFile preserves the replaced archive's DACL; never ignore ACL errors."""
    import ctypes as c
    from ctypes import wintypes as w
    kernel = c.WinDLL("kernel32", use_last_error=True)
    replace = kernel.ReplaceFileW
    replace.argtypes = [w.LPCWSTR, w.LPCWSTR, w.LPCWSTR, w.DWORD, c.c_void_p, c.c_void_p]
    replace.restype = w.BOOL
    if not replace(str(target), str(staged), str(previous), 0, None, None):
        raise ClientInstallError("replace-failed")


def _ownership(home: Path, current: str) -> dict | None:
    path = home / "patch-receipt.json"
    if not path.exists() and not path.is_symlink():
        return None
    receipt = json.loads(_read(path, private=True, limit=16384))
    if not isinstance(receipt, dict) or receipt.get("before_sha256") != STOCK_SHA256 or receipt.get("after_sha256") != current or receipt.get("state") == "restored":
        return None
    return receipt


def _original(home: Path, target: Path, current: str, owned: dict | None) -> Path:
    backups = ensure_private_dir(home / "backups")
    backup = backups / (STOCK_SHA256 + ".asar")
    if backup.exists() or backup.is_symlink():
        if _sha(backup, private=True) != STOCK_SHA256:
            raise ClientInstallError("invalid-backup")
        return backup
    if current == STOCK_SHA256:
        raw = _read(target)
    elif owned is not None:
        # Compatibility with the explicitly owned pre-installer acceptance setup.
        raw = _read(target.parent / "app.asar.original-v028")
    else:
        raise ClientInstallError("unmanaged-archive")
    if hashlib.sha256(raw).hexdigest() != STOCK_SHA256:
        raise ClientInstallError("invalid-backup")
    _exclusive(backup, raw, private=True)
    return backup


def _swap(home, executable, target, staged, current, after, receipt, backup, *, restored=False):
    previous = target.parent / ("app.asar.previous-" + uuid.uuid4().hex)
    recovery = {"originalBackup": str(backup), "previousArchive": str(previous),
                "expectedBefore": current, "expectedAfter": after}
    # No file writes intervene between the final checks and ReplaceFileW.
    if _sha(staged) != after or _sha(target) != current:
        raise ClientInstallError("archive-changed")
    reject_links(previous)
    if previous.exists():
        raise ClientInstallError("backup-collision")
    _assert_not_running(executable)
    try:
        _replace_windows(target, staged, previous)
        if _sha(target) != after or _sha(previous) != current:
            raise ClientInstallError("swap-readback-failed")
        result = {**receipt, "managed": not restored, "state": "restored" if restored else "installed",
                  "version": VERSION, "backupPath": str(backup), "previousArchive": str(previous)}
        atomic_replace(home / "bridge-enabled.json", json.dumps({"schemaVersion": 1, "mode": "disabled" if restored else "native-switch"}).encode())
        atomic_replace(home / "patch-receipt.json", json.dumps(result, sort_keys=True).encode())
        if _sha(target) != after or json.loads(_read(home / "patch-receipt.json", private=True, limit=16384)) != result:
            raise ClientInstallError("receipt-readback-failed")
        return result
    except Exception:
        # ReplaceFile itself may fail after renaming one of its inputs. Keep all
        # artifacts and never attempt an automatic overwrite based on assumptions.
        raise ClientInstallError("recovery-required", recovery=recovery) from None


def install_adapter(home: Path, installation: dict, source_template: bytes) -> dict:
    _windows_only()
    try:
        if not isinstance(source_template, bytes) or not 0 < len(source_template) <= 2 * 1024 * 1024:
            raise ClientInstallError("invalid-template")
        source = source_template.decode("utf-8")
        if source.count(ANCHOR) != 1:
            raise ClientInstallError("invalid-template")
        home = Path(home).absolute()
        executable, target = _target(installation)
        _assert_not_running(executable)
        home = ensure_private_dir(home)
        current = _sha(target)
        owned = _ownership(home, current)
        if current != STOCK_SHA256 and owned is None:
            raise ClientInstallError("unmanaged-archive")
        backup = _original(home, target, current, owned)
        source = source.replace(ANCHOR, "const installedHome = " + json.dumps(str(home)) + ";")
        staged = target.parent / (".app.asar.staged-" + uuid.uuid4().hex)
        receipt = asar_patch.build_patch(backup, staged, source.encode(), STOCK_SHA256)
        return _swap(home, executable, target, staged, current, receipt["after_sha256"], receipt, backup)
    except ClientInstallError:
        raise
    except Exception:
        raise ClientInstallError("install-failed") from None


def restore_adapter(home: Path, installation: dict) -> dict:
    _windows_only()
    try:
        home = ensure_private_dir(Path(home).absolute())
        executable, target = _target(installation)
        _assert_not_running(executable)
        current = _sha(target)
        owned = _ownership(home, current)
        if owned is None or current == STOCK_SHA256:
            raise ClientInstallError("unmanaged-archive")
        backup = _original(home, target, current, owned)
        staged = target.parent / (".app.asar.restore-" + uuid.uuid4().hex)
        _exclusive(staged, _read(backup, private=True))
        receipt = {"before_sha256": STOCK_SHA256, "after_sha256": STOCK_SHA256, "restored_from_sha256": current}
        return _swap(home, executable, target, staged, current, STOCK_SHA256, receipt, backup, restored=True)
    except ClientInstallError:
        raise
    except Exception:
        raise ClientInstallError("restore-failed") from None
