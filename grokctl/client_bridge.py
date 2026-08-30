"""Read-only, paired loopback client status. Never return discovery credentials."""

from __future__ import annotations

import json
import http.client
import os
import re
import stat
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from grokctl.platform_security import open_nofollow, private_permissions, reject_links

MARKER = "grok-bot-switch-client-bridge-v1"
MAX_MANIFEST_BYTES = 8 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
TIMEOUT_SECONDS = 15
_VERSION = re.compile(r"[0-9]{1,4}(?:\.[0-9]{1,6}){1,3}(?:[-+][A-Za-z0-9.-]{1,40})?")
_EXECUTOR_REASONS = {"not-provided", "unsupported-address", "ping-rejected", "ping-failed", "host-not-ready"}


class _Invalid(ValueError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _disconnected(reason: str) -> dict[str, object]:
    return {"connected": False, "clientConnected": False, "hostReachable": False,
            "providerSwitchReady": False, "reason": reason}


def _private(path: Path, info, *, directory=False, fd=None) -> None:
    reject_links(path)
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode) or not private_permissions(path, info, fd=fd):
        raise _Invalid()
    if os.name != "nt" and info.st_uid != os.getuid():
        raise _Invalid()


def _object(raw: bytes) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise _Invalid()
            result[key] = value
        return result

    def constant(_):
        raise _Invalid()

    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, dict):
        raise _Invalid()
    return value


def _instance(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value
    except ValueError:
        return False


def _version(value, token: str, *, host=False):
    if value is None:
        return None
    if not isinstance(value, str) or token in value or not (_VERSION.fullmatch(value) or (host and re.fullmatch(r"[a-f0-9]{7,40}", value))):
        raise _Invalid()
    return value


def _manifest(home: Path, installed_executable) -> dict:
    _private(home, home.lstat(), directory=True)
    path = home / "client-bridge.json"
    _private(path, path.lstat())
    fd = open_nofollow(path, os.O_RDONLY)
    try:
        info = os.fstat(fd)
        _private(path, info, fd=fd)
        if info.st_size > MAX_MANIFEST_BYTES:
            raise _Invalid()
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(MAX_MANIFEST_BYTES + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_MANIFEST_BYTES:
        raise _Invalid()
    data = _object(raw)
    if type(data.get("schemaVersion")) is not int or data["schemaVersion"] != 1:
        raise _Invalid()
    if not _instance(data.get("instance")) or type(data.get("pid")) is not int or data["pid"] <= 0:
        raise _Invalid()
    if type(data.get("port")) is not int or not 1 <= data["port"] <= 65535:
        raise _Invalid()
    token, executable = data.get("token"), data.get("executable")
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
        raise _Invalid()
    if not isinstance(executable, str) or not os.path.isabs(executable) or any(ord(c) < 32 for c in executable):
        raise _Invalid()
    if installed_executable is not None:
        expected = os.fspath(installed_executable)
        if not os.path.isabs(expected) or os.path.normcase(os.path.normpath(expected)) != os.path.normcase(os.path.normpath(executable)):
            raise _Invalid()
    _version(data.get("clientVersion"), token)
    return data


def _sanitize(data: dict, manifest: dict) -> dict[str, object]:
    if data.get("service") != MARKER or type(data.get("schemaVersion")) is not int or data["schemaVersion"] != 1:
        raise _Invalid()
    if data.get("instance") != manifest["instance"]:
        raise _Invalid()
    for key in ("clientConnected", "hostReachable", "providerSwitchReady"):
        if type(data.get(key)) is not bool:
            raise _Invalid()
    if data.get("hostBusy") is not None and type(data["hostBusy"]) is not bool:
        raise _Invalid()
    if "clientVersion" not in data:
        raise _Invalid()
    if data["clientVersion"] != manifest.get("clientVersion"):
        raise _Invalid()
    token = manifest["token"]
    result = {"connected": True, "service": MARKER, "schemaVersion": 1,
              "clientConnected": data["clientConnected"], "hostReachable": data["hostReachable"],
              "clientVersion": _version(data["clientVersion"], token),
              "hostVersion": _version(data.get("hostVersion"), token, host=True),
              "hostBusy": data.get("hostBusy"), "providerSwitchReady": False, "reason": None}
    executor = data.get("executor")
    if isinstance(executor, dict) and all(type(executor.get(k)) is bool for k in ("available", "reachable")):
        result["executor"] = {"available": executor["available"], "reachable": executor["reachable"],
                              "reason": executor.get("reason") if executor.get("reason") in _EXECUTOR_REASONS else None}
    return result


def status(home: Path, installed_executable: Path | str | None = None) -> dict[str, object]:
    """Query only the paired local process; errors are bounded public constants.

    This does not inspect native auth, prove host activation, or enable switching.
    No directory creation, permission repair, redirects, environment proxy, or
    discovery URL is used by this read-only probe.
    """
    try:
        manifest = _manifest(Path(home), installed_executable)
    except FileNotFoundError:
        return _disconnected("not-paired")
    except (OSError, ValueError, TypeError, RecursionError):
        return _disconnected("invalid-pairing")
    request = urllib.request.Request(f"http://127.0.0.1:{manifest['port']}/v1/status",
                                     headers={"Authorization": "Bearer " + manifest["token"], "Accept": "application/json"}, method="GET")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
            if response.status != 200 or response.geturl() != request.full_url:
                return _disconnected("probe-rejected")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                return _disconnected("invalid-response")
        return _sanitize(_object(raw), manifest)
    except urllib.error.HTTPError as error:
        error.close()
        return _disconnected("probe-busy" if error.code == 409 else "probe-rejected")
    except (OSError, urllib.error.URLError, http.client.HTTPException):
        return _disconnected("bridge-unreachable")
    except (ValueError, TypeError, RecursionError):
        return _disconnected("invalid-response")
