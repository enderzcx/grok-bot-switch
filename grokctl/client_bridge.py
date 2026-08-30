"""Read-only, paired loopback client status. Never return discovery credentials."""

from __future__ import annotations

import json
import http.client
import os
import re
import stat
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from grokctl.platform_security import open_nofollow, private_permissions, reject_links
from grokctl.client_process import ReceiverError, verified_receiver

MARKER = "grok-bot-switch-client-bridge-v1"
MAX_MANIFEST_BYTES = 8 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
TIMEOUT_SECONDS = 15
OPERATION_TIMEOUT_SECONDS = 35
_VERSION = re.compile(r"[0-9]{1,4}(?:\.[0-9]{1,6}){1,3}(?:[-+][A-Za-z0-9.-]{1,40})?")
_EXECUTOR_REASONS = {"not-provided", "unsupported-address", "ping-rejected", "ping-failed", "host-not-ready"}
_NATIVE_ERRORS = {"host-not-healthy-idle", "supervisor-command-pending", "activation-in-progress",
                  "active-state-drift", "unknown-host-bundle", "supervisor-source-mismatch",
                  "unmanaged-patched-host", "unmanaged-host-config"}


class _Invalid(ValueError):
    pass


class ClientBridgeError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


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
    if data.get("mode", "probe") not in ("probe", "native-switch"):
        raise _Invalid()
    return data


def _profile_id(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,62}", value) else None


def _digest(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) else None


def _runtime(data):
    if not isinstance(data, dict) or data.get("ok") is not True or data.get("runtimeKind") != "native-host":
        return None
    blocks = data.get("blocking")
    if not isinstance(blocks, list) or len(blocks) > 32 or any(not isinstance(v, str) or not re.fullmatch(r"[a-z-]{1,64}", v) for v in blocks):
        raise _Invalid()
    result = {"runtimeKind": "native-host", "activeProfile": _profile_id(data.get("activeProfile")),
              "desiredProfile": _profile_id(data.get("desiredProfile")), "profileDigest": _digest(data.get("profileDigest")),
              "previousProfile": _profile_id(data.get("previousProfile")),
              "blocking": blocks, "providerSwitchReady": data.get("providerSwitchReady") is True}
    activation = data.get("activation")
    if isinstance(activation, dict):
        result["activation"] = _action_result(activation)
    return result


def _action_result(data):
    if not isinstance(data, dict):
        raise _Invalid()
    out = {}
    for key in ("ok", "verified", "providerSwitchReady"):
        if type(data.get(key)) is bool:
            out[key] = data[key]
    for key in ("id", "status", "phase", "error", "mode"):
        value = data.get(key)
        if value is None or isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", value):
            out[key] = value
    for key in ("target",):
        if data.get(key) is not None:
            out[key] = _profile_id(data[key])
    for key in ("packageSha256", "stockSha256", "patchedSha256", "profileDigest", "hostBundleSha256"):
        if data.get(key) is not None:
            out[key] = _digest(data[key])
    if type(data.get("generation")) is int and data["generation"] > 0:
        out["generation"] = data["generation"]
    return out


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
    mode = data.get("mode", "probe")
    if mode != manifest.get("mode", "probe"):
        raise _Invalid()
    runtime = _runtime(data.get("runtime")) if mode == "native-switch" else None
    result = {"connected": True, "service": MARKER, "schemaVersion": 1,
              "clientConnected": data["clientConnected"], "hostReachable": data["hostReachable"],
              "clientVersion": _version(data["clientVersion"], token),
              "hostVersion": _version(data.get("hostVersion"), token, host=True),
              "hostBusy": data.get("hostBusy"), "mode": mode, "runtime": runtime,
              "providerSwitchReady": mode == "native-switch" and runtime is not None and runtime["providerSwitchReady"], "reason": None}
    executor = data.get("executor")
    if isinstance(executor, dict) and all(type(executor.get(k)) is bool for k in ("available", "reachable")):
        result["executor"] = {"available": executor["available"], "reachable": executor["reachable"],
                              "reason": executor.get("reason") if executor.get("reason") in _EXECUTOR_REASONS else None}
    if token in json.dumps(result):
        raise _Invalid()
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
        with opener.open(request, timeout=OPERATION_TIMEOUT_SECONDS if manifest.get("mode") == "native-switch" else TIMEOUT_SECONDS) as response:
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


def call(home: Path, action: str, *, profile=None, secret=None, installed_executable=None) -> dict:
    """One operation, with receiver proof and a shared 35-second network budget.

    The private instance is authenticated before any POST, and process/listener
    ownership is rechecked immediately before dispatch. Both requests use one
    socket, with automatic reconnect disabled. begin is never retried.
    """
    if action not in ("bootstrap", "inspect", "setup", "plan", "begin", "progress"):
        raise ClientBridgeError("unsupported-operation")
    try:
        manifest = _manifest(Path(home), installed_executable)
    except Exception:
        raise ClientBridgeError("invalid-pairing") from None
    if manifest.get("mode") != "native-switch":
        raise ClientBridgeError("probe-only")
    payload = {} if action == "bootstrap" else {"action": action}
    if profile is not None:
        if action not in ("plan", "begin"):
            raise ClientBridgeError("invalid-operation")
        payload["profile"] = profile
    if secret is not None:
        if action != "begin" or not isinstance(secret, str):
            raise ClientBridgeError("invalid-operation")
        payload["secret"] = secret
    body = json.dumps(payload, separators=(",", ":")).encode()
    if len(body) > 65536:
        raise ClientBridgeError("request-too-large")
    route = "/v1/bootstrap" if action == "bootstrap" else "/v1/operation"
    headers = {"Authorization": "Bearer " + manifest["token"], "Content-Type": "application/json"}
    deadline = time.monotonic() + OPERATION_TIMEOUT_SECONDS
    posted = False
    connection = None
    def remaining():
        timeout = deadline - time.monotonic()
        if timeout <= 0:
            raise TimeoutError()
        return timeout
    try:
        with verified_receiver(manifest["pid"], manifest["executable"], manifest["port"]) as receiver:
            # Direct fixed-address HTTPConnection never consults proxies or
            # follows redirects. Hold this exact connection through the POST.
            connection = http.client.HTTPConnection("127.0.0.1", manifest["port"], timeout=remaining())
            connection.auto_open = 0
            connection.connect()
            authenticated_socket = connection.sock
            connection.request("GET", "/v1/status", headers={"Authorization": headers["Authorization"], "Accept": "application/json"})
            with connection.getresponse() as response:
                if response.status == 409:
                    raise ClientBridgeError("probe-busy")
                if response.status != 200:
                    raise _Invalid()
                check_raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(check_raw) > MAX_RESPONSE_BYTES:
                    raise _Invalid()
            state = _sanitize(_object(check_raw), manifest)
            if state["clientConnected"] is not True or state["mode"] != "native-switch":
                raise _Invalid()
            if _manifest(Path(home), installed_executable) != manifest:
                raise _Invalid()
            if connection.sock is None or connection.sock is not authenticated_socket:
                raise _Invalid()
            connection.sock.settimeout(remaining())
            receiver.recheck()
            posted = True
            connection.request("POST", route, body=body, headers=headers)
            with connection.getresponse() as response:
                if response.status == 409:
                    raise ClientBridgeError("probe-busy")
                if response.status != 200:
                    raise _Invalid()
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES or manifest["token"].encode() in raw:
                    raise _Invalid()
                if secret and len(secret) >= 8 and secret.encode() in raw:
                    raise _Invalid()
        data = _object(raw)
        result = _runtime(data) if action == "inspect" else _action_result(data)
        if result is None:
            raise _Invalid()
        if data.get("ok") is False:
            code = data.get("error")
            raise ClientBridgeError(code if isinstance(code, str) and code in _NATIVE_ERRORS else "native-operation-failed")
        if action == "bootstrap" and not (result.get("ok") is True and result.get("packageSha256")):
            raise _Invalid()
        if action == "setup" and not (result.get("ok") is True and result.get("stockSha256") and result.get("patchedSha256")):
            raise _Invalid()
        if action == "plan" and not (result.get("status") == "planned" and result.get("target") and result.get("verified") is False):
            raise _Invalid()
        if action in ("begin", "progress") and (result.get("status") not in ("idle", "pending", "verified", "failed", "needs-attention") or type(result.get("verified")) is not bool or (result["status"] == "verified") != result["verified"]):
            raise _Invalid()
        return result
    except ClientBridgeError:
        raise
    except ReceiverError:
        raise ClientBridgeError("receiver-unverified") from None
    except Exception:
        # No automatic retry of begin: the remote journal may already exist.
        raise ClientBridgeError("native-operation-unconfirmed" if posted else "receiver-unverified") from None
    finally:
        if connection is not None:
            connection.close()
