"""Load the build-time native bridge payload; no user credential inputs."""
from pathlib import Path
import sys


def client_source() -> bytes:
    if getattr(sys, "frozen", False):
        path = Path(sys._MEIPASS) / "bridge" / "client-bridge.cjs"
        if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("invalid native resource")
        return path.read_bytes()
    from desktop.build_windows_probe import make_source
    return make_source(with_host_package=True)
