"""Native window and lifecycle for the existing loopback control plane.

No Javascript-to-Python application bridge is exposed. Closing the window
stops only the local panel, never the Grok Bot host or its inference hop.
"""
from __future__ import annotations

import argparse
import os
import sys
import json
import tempfile
import urllib.request
from pathlib import Path
from typing import Mapping

APP_NAME = "Grok Bot Switch"


def data_home(env: Mapping[str, str], platform: str = sys.platform) -> Path:
    """Use an app-owned directory, never a Grok login/config directory."""
    if env.get("GROKCTL_HOME"):
        path = Path(env["GROKCTL_HOME"])
        if not path.is_absolute():
            raise ValueError("GROKCTL_HOME 必须是绝对路径")
        return path
    if platform == "win32":
        base = env.get("LOCALAPPDATA")
        if not base:
            raise ValueError("无法定位当前用户的应用数据目录")
        return Path(base) / "GrokBotSwitch"
    if platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "GrokBotSwitch"
    return Path(env.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "grok-bot-switch"


def run_window(home: Path, webview_module=None) -> None:
    from grokctl.integration import ExclusiveLock
    from grokctl.service import GrokctlService
    from grokctl.ui import start_panel

    if webview_module is None:
        import webview as webview_module
    # Separate from the service's short-lived mutation lock.
    lock = ExclusiveLock(home)
    lock.path = home / "desktop.lock"
    with lock.holding():
        panel = start_panel(GrokctlService(home))
        try:
            webview_module.settings.update({
                "ALLOW_DOWNLOADS": False,
                "ALLOW_FILE_URLS": False,
                "OPEN_EXTERNAL_LINKS_IN_BROWSER": True,
                "IGNORE_SSL_ERRORS": False,
                "REMOTE_DEBUGGING_PORT": None,
            })
            webview_module.create_window(
                APP_NAME, panel.url, width=1080, height=760,
                min_size=(680, 520), text_select=True,
                background_color="#f7f7f8",
            )
            webview_module.start(
                gui="edgechromium" if sys.platform == "win32" else None,
                debug=False, private_mode=True,
            )
        finally:
            panel.stop()


def show_error(message: str) -> None:
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
    elif sys.stderr is not None:
        print(message, file=sys.stderr)


def self_check() -> dict:
    """Exercise the packaged backend/assets without a desktop or real data."""
    import webview
    from grokctl.service import GrokctlService
    from grokctl.ui import start_panel
    from grokctl.native_resources import client_source

    source = client_source()
    if b"INSTALL_HOME_PLACEHOLDER" not in source or b"createHostBridge" not in source:
        raise RuntimeError("packaged native adapter missing")

    with tempfile.TemporaryDirectory(prefix="grok-switch-check-") as root:
        service = GrokctlService(Path(root) / "state")
        panel = start_panel(service)
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(panel.url, timeout=5) as response:
                html = response.read()
            with opener.open(panel.url + "/app.js", timeout=5) as response:
                javascript = response.read()
            with opener.open(panel.url + "/api/status", timeout=5) as response:
                status = json.load(response)
            if b"app.js" not in html or len(javascript) < 1000 or status["host"]["wired"]:
                raise RuntimeError("packaged surface failed validation")
            return {"ok": True, "frozen": bool(getattr(sys, "frozen", False)),
                    "platform": sys.platform, "backend": True, "frontendAssets": True,
                    "nativeAdapter": True,
                    "windowTested": False, "hostModified": False}
        finally:
            panel.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="grok-bot-switch")
    parser.add_argument("--home", type=Path, help="独立应用数据目录")
    parser.add_argument("--self-check", action="store_true", help="只检查打包资源和本地服务，不打开窗口")
    parser.add_argument("--report", type=Path, help="自检报告保存位置")
    args = parser.parse_args(argv)
    try:
        if args.self_check:
            if args.report is None:
                raise ValueError("self-check requires report")
            from grokctl.profiles import atomic_replace
            atomic_replace(args.report.absolute(), json.dumps(self_check()).encode("utf-8"))
            return 0
        home = args.home.absolute() if args.home else data_home(os.environ)
        run_window(home)
        return 0
    except Exception as exc:
        if args.self_check:
            # Unattended checks must never hang in a message box on Session 0.
            return 1
        # Never print arbitrary exceptions that could contain credentials/paths.
        code = getattr(exc, "code", "startup")
        if code == "busy":
            show_error("Grok Bot Switch 已在运行，请使用已打开的窗口。")
        else:
            show_error("无法启动 Grok Bot Switch。请确认应用目录可写；Windows 需要 Microsoft Edge WebView2 Runtime。已有配置不会被删除。")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
