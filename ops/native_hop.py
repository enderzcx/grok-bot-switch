"""Linux-only provider-hop lifecycle with exact process and config ownership."""
from __future__ import annotations

import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from grokctl.platform_security import open_nofollow, private_permissions, reject_links
from grokctl.profiles import atomic_replace, ensure_private_dir
from grokctl.models import canonical_dumps
from ops import provider_hop


class NativeHopError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def read_private(path: Path, limit=65536) -> bytes:
    reject_links(path)
    fd = open_nofollow(path, os.O_RDONLY)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or not private_permissions(path, info, fd=fd) or info.st_size > limit:
            raise NativeHopError("unsafe-file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise NativeHopError("unsafe-file")
        return data
    finally:
        os.close(fd)


def process_identity(pid: int) -> tuple[int, list[str]]:
    if type(pid) is not int or pid <= 0:
        raise NativeHopError("ownership-mismatch")
    base = Path("/proc") / str(pid)
    raw = (base / "stat").read_bytes()
    if len(raw) > 8192:
        raise NativeHopError("ownership-mismatch")
    # comm may include spaces or ')' characters. starttime is field 22.
    fields = raw.rsplit(b")", 1)[1].split()
    if fields[0] == b"Z":
        raise ProcessLookupError()
    ticks = int(fields[19])
    with (base / "cmdline").open("rb") as stream:
        cmdline = stream.read(16385)
    if len(cmdline) > 16384:
        raise NativeHopError("ownership-mismatch")
    return ticks, [part.decode("utf-8") for part in cmdline.rstrip(b"\0").split(b"\0")]


def owns_listener(pid: int, port: int, *, allow_wildcard: bool = False) -> bool:
    """A matching HTTP body alone cannot attribute somebody else's listener."""
    inodes = set()
    for fd in (Path("/proc") / str(pid) / "fd").iterdir():
        try:
            target = os.readlink(fd)
        except FileNotFoundError:
            continue
        if target.startswith("socket:[") and target.endswith("]"):
            inodes.add(target[8:-1])
    addresses = {f"0100007F:{port:04X}"}
    if allow_wildcard:
        addresses.add(f"00000000:{port:04X}")
    with (Path("/proc") / str(pid) / "net" / "tcp").open() as stream:
        for line in stream:
            fields = line.split()
            if len(fields) >= 10 and fields[1] in addresses and fields[3] == "0A" and fields[9] in inodes:
                return True
    return False


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HopManager:
    def __init__(self, root: Path):
        self.root = Path(root).absolute()
        self.worker = self.root / "ops" / "native_hop_worker.py"
        self.python = str(Path(sys.executable).absolute())
        self.children = {}

    def _argv(self, path):
        return [self.python, str(self.worker), "--config", str(path)]

    def _owned(self, handle, *, config=False):
        try:
            ticks, argv = process_identity(handle["pid"])
            if ticks != handle["startedTicks"] or argv != self._argv(handle["configPath"]):
                return False
            if config:
                raw = read_private(Path(handle["configPath"]))
                if hashlib.sha256(raw).hexdigest() != handle["configDigest"]:
                    return False
                if handle.get("port") is not None and not owns_listener(handle["pid"], handle["port"]):
                    return False
            return True
        except (OSError, ValueError, KeyError, IndexError, TypeError, NativeHopError):
            return False

    def _gone(self, handle):
        try:
            ticks, _ = process_identity(handle["pid"])
            return ticks != handle["startedTicks"]
        except (FileNotFoundError, ProcessLookupError):
            return True
        except (OSError, ValueError, KeyError, IndexError, TypeError, NativeHopError):
            return False

    def start(self, config: dict, generation_dir: Path) -> dict:
        if not sys.platform.startswith("linux"):
            raise NativeHopError("unsupported-platform")
        child = None
        handle = None
        try:
            generation = config.get("generation")
            digest = config.get("profileDigest")
            if type(generation) is not int or generation <= 0 or not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest):
                raise NativeHopError("invalid-generation")
            provider_hop._assert_no_secret_material(config)
            provider_hop.validate_headers(config.get("headers") or {})
            directory = ensure_private_dir(Path(generation_dir).absolute())
            path, ready = directory / "hop.json", directory / "hop-ready.json"
            if ready.exists() or ready.is_symlink():
                raise NativeHopError("generation-exists")
            if config.get("listenHost") != "127.0.0.1" or type(config.get("listenPort")) is not int or config["listenPort"] != 0:
                raise NativeHopError("invalid-config")
            receipt = Path(config.get("receiptFile", ""))
            if not receipt.is_absolute() or receipt.parent != directory:
                raise NativeHopError("invalid-config")
            raw = canonical_dumps(config).encode()
            if len(raw) > 65536:
                raise NativeHopError("invalid-config")
            if path.exists() or path.is_symlink():
                if read_private(path) != raw:
                    raise NativeHopError("config-mismatch")
            else:
                atomic_replace(path, raw)
            # Validate without loading secret bytes or making an inference call.
            provider_hop.load_config(path)
            reject_links(self.worker)
            logfd = open_nofollow(directory / "hop.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL)
            try:
                child = subprocess.Popen(self._argv(path), stdin=subprocess.DEVNULL,
                                         stdout=logfd, stderr=logfd, close_fds=True,
                                         start_new_session=True, cwd=str(self.root),
                                         env={"PATH": os.defpath, "LANG": "C.UTF-8"})
                self.children[child.pid] = child
            finally:
                os.close(logfd)
            ticks, _ = process_identity(child.pid)
            handle = {"pid": child.pid, "port": None, "generation": generation, "profileDigest": digest,
                      "configPath": str(path), "configDigest": hashlib.sha256(raw).hexdigest(), "startedTicks": ticks}
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise NativeHopError("worker-exited")
                if ready.exists():
                    record = json.loads(read_private(ready, 8192))
                    if not isinstance(record, dict) or any(record.get(key) != handle[key] for key in ("pid", "startedTicks", "configDigest")):
                        raise NativeHopError("invalid-readiness")
                    if type(record.get("port")) is not int or not 1 <= record["port"] <= 65535 or not self._owned(handle, config=True):
                        raise NativeHopError("invalid-readiness")
                    handle["port"] = record["port"]
                    if not self._owned(handle, config=True):
                        raise NativeHopError("invalid-readiness")
                    return handle
                time.sleep(0.05)
            raise NativeHopError("startup-timeout")
        except Exception as error:
            if child is not None and handle is None and child.poll() is None:
                try:
                    ticks, argv = process_identity(child.pid)
                    if argv != self._argv(path):
                        raise NativeHopError("ownership-mismatch")
                    handle = {"pid": child.pid, "startedTicks": ticks, "configPath": str(path)}
                except Exception:
                    raise NativeHopError("cleanup-pending") from None
            cleanup = self.stop(handle) if handle is not None and child is not None else None
            if cleanup and not cleanup["stopped"]:
                raise NativeHopError("cleanup-pending") from None
            code = error.code if isinstance(error, NativeHopError) else "startup-failed"
            raise NativeHopError(code) from None

    def health(self, handle: dict) -> dict:
        if not self._owned(handle, config=True):
            raise NativeHopError("ownership-mismatch")
        try:
            config = json.loads(read_private(Path(handle["configPath"])))
            if config.get("generation") != handle["generation"] or config.get("profileDigest") != handle["profileDigest"]:
                raise NativeHopError("ownership-mismatch")
            port = handle["port"]
            if type(port) is not int or not 1 <= port <= 65535:
                raise NativeHopError("ownership-mismatch")
            # Readiness binds this port to the exact still-running child.
            ready = json.loads(read_private(Path(handle["configPath"]).parent / "hop-ready.json", 8192))
            if any(ready.get(key) != handle[key] for key in ("pid", "port", "startedTicks", "configDigest")):
                raise NativeHopError("ownership-mismatch")
            url = f"http://127.0.0.1:{port}/healthz"
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
            with opener.open(urllib.request.Request(url, method="GET"), timeout=2) as response:
                if response.status != 200 or response.geturl() != url:
                    raise NativeHopError("unhealthy")
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise NativeHopError("unhealthy")
            result = json.loads(raw)
            expected = {"ok": True, "service": "grokctl-provider-hop", "listenHost": "127.0.0.1", "listenPort": port,
                        "credentialLoaded": config["authType"] != "none"}
            expected.update({key: config[key] for key in ("profileId", "protocol", "model", "authType", "resolvedEndpoint")})
            if not isinstance(result, dict) or any(type(result.get(key)) is not type(value) or result[key] != value for key, value in expected.items()):
                raise NativeHopError("unhealthy")
            if not self._owned(handle, config=True):
                raise NativeHopError("ownership-mismatch")
            return {**expected, "generation": config["generation"], "profileDigest": config["profileDigest"]}
        except Exception as error:
            raise NativeHopError(error.code if isinstance(error, NativeHopError) else "unhealthy") from None

    def stop(self, handle: dict) -> dict:
        child = self.children.get(handle.get("pid"))
        if child is not None and child.poll() is not None:
            self.children.pop(handle["pid"], None)
            return {"stopped": True, "reason": None}
        if self._gone(handle):
            return {"stopped": True, "reason": None}
        if not self._owned(handle):
            return {"stopped": False, "reason": "ownership-mismatch"}
        # pidfd binds the signal to this process, closing the check/kill PID
        # reuse race. Old kernels/runtimes fail closed rather than use kill(pid).
        pidfd = None
        try:
            if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
                return {"stopped": False, "reason": "cleanup-pending"}
            pidfd = os.pidfd_open(handle["pid"])
            if not self._owned(handle):
                return {"stopped": False, "reason": "ownership-mismatch"}
            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
        except ProcessLookupError:
            return {"stopped": True, "reason": None}
        except OSError:
            return {"stopped": False, "reason": "cleanup-pending"}
        finally:
            if pidfd is not None:
                os.close(pidfd)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if child is not None and child.poll() is not None:
                self.children.pop(handle["pid"], None)
                return {"stopped": True, "reason": None}
            if self._gone(handle):
                return {"stopped": True, "reason": None}
            time.sleep(0.05)
        return {"stopped": False, "reason": "cleanup-pending"}
