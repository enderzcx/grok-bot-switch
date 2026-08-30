"""Desktop lifetime tests without starting a GUI or making provider requests."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from grokctl.desktop import data_home, run_window


class DesktopTests(unittest.TestCase):
    def test_explicit_home_is_separate(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(data_home({"GROKCTL_HOME": root}), Path(root))
        with self.assertRaises(ValueError):
            data_home({"GROKCTL_HOME": "relative"})

    def test_windows_uses_local_appdata(self):
        self.assertEqual(data_home({"LOCALAPPDATA": "/fixture/local"}, "win32"),
                         Path("/fixture/local/GrokBotSwitch"))
        with self.assertRaises(ValueError):
            data_home({}, "win32")

    def test_window_has_no_python_bridge_and_always_stops_panel(self):
        with tempfile.TemporaryDirectory() as root:
            webview = Mock()
            webview.settings = {}
            panel = Mock(url="http://127.0.0.1:12345")
            with patch("grokctl.ui.start_panel", return_value=panel):
                run_window(Path(root), webview)
            self.assertNotIn("js_api", webview.create_window.call_args.kwargs)
            self.assertEqual(webview.create_window.call_args.args[1], panel.url)
            self.assertFalse(webview.settings["ALLOW_FILE_URLS"])
            self.assertIsNone(webview.settings["REMOTE_DEBUGGING_PORT"])
            panel.stop.assert_called_once()

    def test_gui_start_failure_still_stops_panel(self):
        with tempfile.TemporaryDirectory() as root:
            webview = Mock()
            webview.settings = {}
            webview.start.side_effect = RuntimeError("fixture")
            panel = Mock(url="http://127.0.0.1:12345")
            with patch("grokctl.ui.start_panel", return_value=panel), self.assertRaises(RuntimeError):
                run_window(Path(root), webview)
            panel.stop.assert_called_once()


if __name__ == "__main__":
    unittest.main()
