"""Read-only discovery of the installed Grok Bot client, not its login data.

An installation is never proof that routing has been connected or activated.
Only public package metadata is read; credentials and user settings are not.
"""
from __future__ import annotations

import json
import ntpath
import os
import plistlib
import struct
import sys
import re
from pathlib import Path
from typing import Mapping, Sequence

MAX_HEADER = 4 * 1024 * 1024
MAX_PACKAGE = 64 * 1024


def asar_package(path: Path) -> dict:
    """Read only package.json from Electron ASAR, with bounded offsets/sizes."""
    with path.open("rb") as archive:
        size = os.fstat(archive.fileno()).st_size
        raw = archive.read(16)
        if len(raw) != 16:
            raise ValueError("invalid ASAR header")
        marker, header_size, pickle_size, json_size = struct.unpack("<4I", raw)
        if marker != 4 or not 0 < json_size <= MAX_HEADER or header_size < json_size + 8:
            raise ValueError("invalid ASAR header")
        if header_size > MAX_HEADER + 16 or pickle_size + 4 != header_size or 8 + header_size > size:
            raise ValueError("invalid ASAR size")
        header = json.loads(archive.read(json_size))
        if not isinstance(header, dict):
            raise ValueError("invalid ASAR directory")
        entry = header["files"]["package.json"]
        if not isinstance(entry, dict):
            raise ValueError("invalid ASAR entry")
        if entry.get("unpacked") or entry.get("link"):
            raise ValueError("package metadata must be packed")
        offset, length = int(entry["offset"]), int(entry["size"])
        start = 8 + header_size + offset
        if offset < 0 or not 0 < length <= MAX_PACKAGE or start + length > size:
            raise ValueError("invalid package range")
        archive.seek(start)
        package = json.loads(archive.read(length))
        if not isinstance(package, dict):
            raise ValueError("invalid package")
        return package


def windows_registry_paths(display_name: object, location: object, icon: object) -> list[str]:
    """NSIS often stores a versioned name and DisplayIcon, not InstallLocation."""
    if not isinstance(display_name, str) or not re.fullmatch(r"Grok Bot(?: \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)?", display_name):
        return []
    paths = []
    if isinstance(location, str):
        value = location.strip().strip('"')
        if ntpath.isabs(value) and ntpath.splitdrive(value)[0]:
            paths.append(value)
    if isinstance(icon, str):
        match = re.fullmatch(r'\s*(?:"([^"\r\n]+\.exe)"|([^"\r\n]+?\.exe))\s*(?:,\s*-?\d+)?\s*', icon, re.IGNORECASE)
        if match:
            binary = match.group(1) or match.group(2)
            if ntpath.isabs(binary) and ntpath.splitdrive(binary)[0] and ntpath.basename(binary).lower() == "grok bot.exe":
                paths.append(ntpath.dirname(binary))
    return list(dict.fromkeys(paths))


def windows_registry_roots() -> list[Path]:
    if sys.platform != "win32":
        return []
    import winreg
    roots = []
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, r"Software\Microsoft\Windows\CurrentVersion\Uninstall", 0,
                                    winreg.KEY_READ | view) as parent:
                    for i in range(winreg.QueryInfoKey(parent)[0]):
                        try:
                            with winreg.OpenKey(parent, winreg.EnumKey(parent, i)) as key:
                                values = []
                                for field in ("DisplayName", "InstallLocation", "DisplayIcon"):
                                    try:
                                        values.append(winreg.QueryValueEx(key, field)[0])
                                    except OSError:
                                        values.append(None)
                                roots.extend(Path(p) for p in windows_registry_paths(*values))
                        except OSError:
                            continue
            except OSError:
                continue
    return roots


def candidate_roots(platform: str, env: Mapping[str, str]) -> list[Path]:
    if platform == "darwin":
        return [Path("/Applications/Grok Bot.app"), Path.home() / "Applications/Grok Bot.app"]
    if platform == "win32":
        roots = windows_registry_roots()
        for name, suffix in (("LOCALAPPDATA", "Programs/Grok Bot"),
                             ("LOCALAPPDATA", "Programs/grok-bot"),
                             ("ProgramFiles", "Grok Bot"), ("ProgramFiles(x86)", "Grok Bot")):
            if env.get(name):
                roots.append(Path(env[name]) / suffix)
        return roots
    return []


def inspect_installation(root: Path, platform: str) -> dict:
    if platform == "darwin":
        with (root / "Contents/Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        if info.get("CFBundleIdentifier") != "com.anysphere.sand":
            raise ValueError("unexpected application")
        executable = info.get("CFBundleExecutable", "")
        if not executable or Path(executable).name != executable:
            raise ValueError("invalid executable")
        binary = root / "Contents/MacOS" / executable
        resources = root / "Contents/Resources"
    else:
        binary = root / "Grok Bot.exe"
        resources = root / "resources"
    if not binary.is_file():
        raise ValueError("missing executable")
    package = asar_package(resources / "app.asar")
    if package.get("productName") != "Grok Bot" or package.get("name") != "sand":
        raise ValueError("unexpected package")
    version = package.get("version")
    if not isinstance(version, str) or not version or len(version) > 64 or any(ord(c) < 32 for c in version):
        raise ValueError("invalid version")
    return {"path": str(root), "executable": str(binary), "version": version}


def discover_installation(*, platform: str | None = None,
                          roots: Sequence[Path] | None = None,
                          env: Mapping[str, str] | None = None) -> dict:
    platform = platform or sys.platform
    candidates = candidate_roots(platform, os.environ if env is None else env) if roots is None else roots
    found = []
    seen = set()
    for root in candidates:
        root = Path(root)
        try:
            identity = str(root.resolve())
            if identity in seen:
                continue
            seen.add(identity)
            found.append(inspect_installation(root, platform))
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            continue
    return {"detected": bool(found), "ambiguous": len(found) > 1,
            "installations": found, "integrationReady": False}
