"""Offline cloud-local panel lifecycle. Installation never switches the host."""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))
DEFAULT_ROOT = Path("/workspace/grok-bot-switch-independent")


class InstallError(Exception):
    pass


def private_dir(path):
    path = Path(path).absolute()
    for item in (*reversed(path.parents), path):
        if item.is_symlink():
            raise InstallError("unsafe-directory")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise InstallError("unsafe-directory")
    return path


def read_json(path):
    from grokctl.profiles import _file_is_private_regular
    _file_is_private_regular(path)
    if path.stat().st_size > 4096:
        raise InstallError("invalid-state")
    result = json.loads(path.read_bytes())
    if not isinstance(result, dict):
        raise InstallError("invalid-state")
    return result


def install(archive, expected, root):
    archive = Path(archive)
    if (not re.fullmatch(r"[a-f0-9]{64}", expected or "") or archive.is_symlink()
            or not archive.is_file() or archive.stat().st_size > 8 * 1024 * 1024):
        raise InstallError("invalid-archive")
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise InstallError("checksum-mismatch")
    import io
    with zipfile.ZipFile(io.BytesIO(data)) as bundle:
        members = bundle.infolist()
        if len(members) > 100 or sum(m.file_size for m in members) > 16 * 1024 * 1024:
            raise InstallError("archive-too-large")
        names = set()
        for member in members:
            name = member.filename
            parts = PurePosixPath(name)
            if (name in names or parts.is_absolute() or ".." in parts.parts or "\\" in name
                    or str(parts) != name or member.is_dir()
                    or stat.S_ISLNK(member.external_attr >> 16)):
                raise InstallError("unsafe-archive-member")
            names.add(name)
        if not {"ops/independent.py", "grokctl/independent_service.py", "grokctl/web/index.html"} <= names:
            raise InstallError("incomplete-archive")
        versions = private_dir(root / "versions")
        target = versions / expected
        if target.exists() or target.is_symlink():
            private_dir(target)
            for member in members:
                path = target / member.filename
                for parent in path.parents:
                    if parent == target:
                        break
                    if parent.is_symlink():
                        raise InstallError("installed-source-changed")
                if path.is_symlink() or not path.is_file() or path.read_bytes() != bundle.read(member):
                    raise InstallError("installed-source-changed")
        else:
            with tempfile.TemporaryDirectory(prefix=".install-", dir=versions) as staging:
                for member in members:
                    path = Path(staging) / member.filename
                    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with path.open("xb") as stream:
                        stream.write(bundle.read(member))
                    path.chmod(0o600)
                os.rename(staging, target)
    return target


def running(root):
    path = root / "state/panel.json"
    if not path.exists() and not path.is_symlink():
        return None
    state = read_json(path)
    port = state.get("port")
    if type(port) is not int or not 1 <= port <= 65535:
        raise InstallError("invalid-state")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
    try:
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        if response.status != 200:
            return None
        health = json.loads(response.read(4096))
        if health != {"ok": True, "mode": "independent", "instanceId": state.get("instanceId")}:
            return None
        return state
    except (OSError, ValueError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def start(root, package, port):
    state = running(root)
    if state:
        if state.get("package") != str(package):
            raise InstallError("stop-panel-before-upgrade")
        return state
    log = root / "panel.log"
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise InstallError("unsafe-log")
        child = subprocess.Popen([sys.executable, "-I", str(package / "ops/independent.py"),
                                  "serve", "--root", str(root), "--port", str(port)],
                                 stdin=subprocess.DEVNULL, stdout=fd, stderr=fd, start_new_session=True)
    finally:
        os.close(fd)
    for _ in range(50):
        if child.poll() is not None:
            raise InstallError("panel-start-failed")
        state = running(root)
        if state and state.get("pid") == child.pid:
            return state
        time.sleep(0.1)
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        raise InstallError("panel-start-unconfirmed") from None
    raise InstallError("panel-start-timeout")


def serve(root, port):
    from grokctl.independent_service import IndependentService
    from grokctl.integration import ExclusiveLock
    from grokctl.profiles import atomic_replace
    from grokctl.ui import ProviderPanel
    home = private_dir(root / "state")
    lock = ExclusiveLock(home)
    lock.path = home / "panel.lock"
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    with lock.holding():
        service = IndependentService(home)
        service.panel_instance_id = secrets.token_hex(32)
        with ProviderPanel(service, port=port) as panel:
            atomic_replace(home / "panel.json", json.dumps({"pid": os.getpid(), "port": panel.port,
                "url": panel.url, "instanceId": service.panel_instance_id, "package": str(PACKAGE)}).encode())
            stopped.wait()


def stop(root):
    state = running(root)
    if not state:
        return {"running": False}
    pid = state.get("pid")
    if type(pid) is not int or pid <= 1:
        raise InstallError("invalid-panel-pid")
    command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    expected = [str(Path(state["package"]) / "ops/independent.py").encode(), b"serve",
                b"--root", str(root).encode(), b"--port", str(state["port"]).encode()]
    # The requested port may be zero, so check the fixed prefix, not the actual bound port.
    if command[2:7] != expected[:5]:
        raise InstallError("panel-process-mismatch")
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        if running(root) is None:
            return {"running": False}
        time.sleep(0.1)
    raise InstallError("panel-stop-unconfirmed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "start", "status", "stop", "serve"))
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--sha256")
    parser.add_argument("--port", type=int, default=18994)
    args = parser.parse_args()
    if sys.platform != "linux":
        raise InstallError("run-inside-grok-cloud-linux")
    if not 0 <= args.port <= 65535:
        raise InstallError("invalid-port")
    os.umask(0o077)
    root = private_dir(args.root)
    if args.action == "serve":
        serve(root, args.port)
        return
    from grokctl.integration import ExclusiveLock
    from grokctl.profiles import atomic_replace
    with ExclusiveLock(root).holding():
        if args.action == "install":
            package = install(args.archive or Path(sys.argv[0]), args.sha256, root)
            result = start(root, package, args.port)
            atomic_replace(root / "current.json", json.dumps({"sha256": package.name}).encode())
        elif args.action == "start":
            digest = read_json(root / "current.json").get("sha256")
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise InstallError("invalid-state")
            result = start(root, private_dir(root / "versions" / digest), args.port)
        elif args.action == "stop":
            result = stop(root)
        else:
            result = running(root) or {"running": False}
    print(json.dumps({"ok": True, "mode": "independent", "hostModified": False, **result}))


def entrypoint():
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, InstallError) else "independent-operation-failed"
        print(json.dumps({"ok": False, "error": code}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    entrypoint()
