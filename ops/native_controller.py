"""Native supervisor observation and restart primitives, with no switch engine.

Gateway credentials are never exported or used. The supervisor alone consumes
restart requests and decides when the host is idle; this module never kills,
pauses, upgrades, deletes a command, or fabricates a restart acknowledgement.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import urllib.request
import uuid

from ops.native_hop import owns_listener


SUPERVISOR_SHA256 = "db270383ac06d217c78e6079508b39939b8a9f77dfe3213308e21b5c38a6c330"
MAX_READ = 64 * 1024
MAX_SOURCE = 128 * 1024 * 1024


class NativeControllerError(RuntimeError):
    """A fixed, credential-free failure code."""

    def __init__(self, code, *, publication="uncertain"):
        self.code = code
        self.publication = publication
        super().__init__(code)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read(path: Path, limit: int = MAX_READ) -> bytes:
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError()
        result = stream.read(limit + 1)
    if len(result) > limit:
        raise ValueError()
    return result


def _json(path: Path) -> dict:
    value = json.loads(_read(path))
    if not isinstance(value, dict):
        raise ValueError()
    return value


def _positive(value) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value) and value > 0
    except OverflowError:
        return False


def _token(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.+-]{1,128}", value) else None


def _command(value: dict, id_key="id", kind_key="kind") -> dict:
    return {"id": _token(value.get(id_key)),
            "kind": value.get(kind_key) if value.get(kind_key) in ("ping", "restart", "upgrade") else None}


def _exists(path: Path) -> bool:
    return os.path.lexists(path)


def _request_id(value: str) -> str:
    try:
        if not isinstance(value, str) or not value.startswith("gbs-") or str(uuid.UUID(value[4:])) != value[4:]:
            raise ValueError()
    except (ValueError, AttributeError, TypeError):
        raise NativeControllerError("invalid-request-id") from None
    return value


class NativeHost:
    def __init__(self, root=Path("/workspace/grok-home"),
                 host_entry=Path("/home/box/sand-host/host-main.cjs"),
                 gateway_path=Path("/home/box/sand-data/gateway.json"),
                 supervisor_dir=Path("/tmp/sand-supervisor"), *, opener=None,
                 proc_root=Path("/proc"), supervisor_source=Path("/usr/local/bin/sand-supervisor.mjs"),
                 listener_owner=None):
        self.root = Path(root)
        self.host_entry = Path(host_entry)
        self.gateway_path = Path(gateway_path)
        self.supervisor_dir = Path(supervisor_dir)
        self.proc_root = Path(proc_root)
        self.supervisor_source = Path(supervisor_source)
        self.listener_owner = listener_owner or owns_listener
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    @property
    def command_path(self):
        return self.supervisor_dir / "command.json"

    def _gateway(self):
        try:
            raw = _json(self.gateway_path)
            port, pid, started = raw.get("port"), raw.get("pid"), raw.get("startedAt")
            if type(port) is not int or not 1 <= port <= 65535 or type(pid) is not int or pid <= 0 or not _positive(started):
                return None
            return port, pid, started
        except Exception:
            return None

    def _live(self, pid):
        try:
            argv = _read(self.proc_root / str(pid) / "cmdline").split(b"\0")
            return os.fsencode(self.host_entry) in argv
        except Exception:
            return False

    def _health(self, port):
        url = f"http://127.0.0.1:{port}/health"
        try:
            request = urllib.request.Request(url, method="GET")
            with self.opener.open(request, timeout=2) as response:
                if response.status != 200 or response.geturl() != url:
                    return False, None
                body = response.read(MAX_READ + 1)
                if len(body) > MAX_READ:
                    return False, None
                result = json.loads(body)
            if not isinstance(result, dict):
                return False, None
            busy = result.get("isBusy")
            return (True, busy) if type(busy) is bool else (False, None)
        except Exception:
            return False, None

    def _owns_health_listener(self, pid, port):
        try:
            return self.listener_owner(pid, port) is True
        except Exception:
            return False

    def read_observation(self) -> dict:
        observed = {"pid": None, "startedAt": None, "hostBundleSha256": None,
                    "hostVersion": None, "isBusy": None, "pendingCommand": None,
                    "supervisorLastCommand": None, "health": False}
        try:
            observed["hostBundleSha256"] = hashlib.sha256(_read(self.host_entry, MAX_SOURCE)).hexdigest()
            observed["hostVersion"] = _token(_read(self.host_entry.parent / "version").decode().strip())
        except Exception:
            pass
        if _exists(self.command_path):
            try:
                observed["pendingCommand"] = _command(_json(self.command_path))
            except Exception:
                observed["pendingCommand"] = {"id": None, "kind": None}
        try:
            observed["supervisorLastCommand"] = _command(_json(self.supervisor_dir / "status.json"), "lastCommandId", "lastCommandKind")
        except Exception:
            pass
        gateway = self._gateway()
        if gateway is not None:
            port, pid, started = gateway
            observed.update(pid=pid, startedAt=started)
            if self._live(pid) and self._owns_health_listener(pid, port):
                health, busy = self._health(port)
                if self._gateway() == gateway and self._live(pid) and self._owns_health_listener(pid, port):
                    observed.update(health=health, isBusy=busy)
        return observed

    def _assert_supervisor(self):
        try:
            matched = hashlib.sha256(_read(self.supervisor_source, MAX_SOURCE)).hexdigest() == SUPERVISOR_SHA256
        except Exception:
            matched = False
        if not matched:
            raise NativeControllerError("supervisor-source-mismatch")

    def _ack_path(self, request_id):
        # Native ackFilename replaces characters outside [a-zA-Z0-9_.-] with _;
        # canonical gbs-UUIDs need no replacement and have no filename suffix.
        return self.supervisor_dir / "acks" / re.sub(r"[^a-zA-Z0-9_.-]", "_", request_id)

    def issue_restart(self, request_id: str, expected: dict) -> dict:
        try:
            request_id = _request_id(request_id)
            self._assert_supervisor()
            current = self.read_observation()
            if not isinstance(expected, dict) or any(current[key] is None or current[key] != expected.get(key)
                    for key in ("pid", "startedAt", "hostBundleSha256")):
                raise NativeControllerError("host-observation-changed")
            if current["health"] is not True or current["isBusy"] is not False:
                raise NativeControllerError("host-not-healthy-idle")
            if current["pendingCommand"] is not None or _exists(self.command_path):
                raise NativeControllerError("supervisor-command-pending")
            if _exists(self._ack_path(request_id)) or current["supervisorLastCommand"] == {"id": request_id, "kind": "restart"}:
                raise NativeControllerError("request-id-already-used")
            command = {"id": request_id, "kind": "restart", "issuedAtMs": time.time_ns() // 1_000_000,
                       "reason": "grok-bot-switch"}
        except NativeControllerError as error:
            raise NativeControllerError(error.code, publication="unpublished") from None
        except Exception:
            raise NativeControllerError("restart-preflight-failed", publication="unpublished") from None
        temp_path = None
        link_attempted = False
        try:
            # A complete fsynced inode is published with link(O_EXCL semantics),
            # never rename-overwrite. The supervisor owns unlinking command.json.
            fd, name = tempfile.mkstemp(prefix=".gbs-command-", dir=self.supervisor_dir)
            temp_path = Path(name)
            with os.fdopen(fd, "wb") as stream:
                stream.write(json.dumps(command, separators=(",", ":")).encode())
                stream.flush()
                os.fsync(stream.fileno())
            link_attempted = True
            os.link(temp_path, self.command_path, follow_symlinks=False)
        except FileExistsError:
            raise NativeControllerError("supervisor-command-pending", publication="unpublished") from None
        except Exception:
            # A generic link error may be returned after an uncertain filesystem
            # outcome. Only failures before entering link prove non-publication.
            raise NativeControllerError("command-publish-failed", publication="uncertain" if link_attempted else "unpublished") from None
        finally:
            if temp_path is not None:
                try:
                    temp_path.unlink()
                except OSError:
                    pass
        return {"id": request_id, "kind": "restart", "status": "pending", "verified": False}

    def restart_receipt(self, request_id: str, previous: dict) -> dict:
        request_id = _request_id(request_id)
        current = self.read_observation()
        pending = current["pendingCommand"] is not None or _exists(self.command_path)
        acknowledgement_present = _exists(self._ack_path(request_id))
        acknowledged_at = None
        try:
            timestamp = float(_read(self._ack_path(request_id), 128).decode().strip())
            if _positive(timestamp):
                acknowledged_at = int(timestamp) if timestamp.is_integer() else timestamp
        except Exception:
            pass
        old_pid = previous.get("pid") if isinstance(previous, dict) else None
        old_started = previous.get("startedAt") if isinstance(previous, dict) else None
        verified = (not pending and acknowledged_at is not None and type(old_pid) is int and old_pid > 0 and _positive(old_started)
                    and current["supervisorLastCommand"] == {"id": request_id, "kind": "restart"}
                    and current["pid"] is not None and current["pid"] != old_pid
                    and _positive(current["startedAt"]) and current["startedAt"] > old_started
                    and current["hostBundleSha256"] is not None
                    and current["hostBundleSha256"] == previous.get("hostBundleSha256")
                    and current["health"] is True)
        return {"id": request_id, "kind": "restart", "status": "pending" if pending else "consumed" if verified else "unverified",
                "verified": verified, "acknowledgedAtMs": acknowledged_at,
                "acknowledgementPresent": acknowledgement_present or acknowledged_at is not None, "observation": current}
