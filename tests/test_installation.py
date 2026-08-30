"""Installation discovery reads application metadata only, never login files."""
import json
import plistlib
import struct
import tempfile
import unittest
from pathlib import Path
from grokctl.installation import asar_package, discover_installation, windows_registry_paths


def make_asar(package):
    payload = json.dumps(package).encode()
    header = json.dumps({"files": {"package.json": {"offset": "0", "size": len(payload)}}}).encode()
    padding = b"\0" * (-len(header) % 4)
    header_size = len(header) + len(padding) + 8
    return struct.pack("<4I", 4, header_size, header_size - 4, len(header)) + header + padding + payload


class InstallationTests(unittest.TestCase):
    def test_windows_real_versioned_uninstall_entry_without_location(self):
        self.assertEqual(windows_registry_paths("Grok Bot 0.28.0", None,
                         r"F:\grok-bot\Grok Bot\Grok Bot.exe,0"), [r"F:\grok-bot\Grok Bot"])
    def test_windows_quoted_icon_and_install_location(self):
        self.assertEqual(windows_registry_paths("Grok Bot", '"F:\\grok-bot\\Grok Bot"',
                         '"F:\\grok-bot\\Grok Bot\\Grok Bot.exe",0'), [r"F:\grok-bot\Grok Bot"])
    def test_other_grok_app_and_uninstall_commands_are_not_candidates(self):
        self.assertEqual(windows_registry_paths("Grok", r"F:\Grok", r"F:\Grok\grok-app.exe"), [])
        self.assertEqual(windows_registry_paths("Grok Bot", None, r"F:\Grok\uninstall.exe,0"), [])
        self.assertEqual(windows_registry_paths("Grok Bot", "relative", "Grok Bot.exe"), [])
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
    def tearDown(self):
        self.tmp.cleanup()
    def installation(self, name="Grok Bot", platform="darwin"):
        root = self.root / name
        if platform == "darwin":
            resource = root / "Contents/Resources"
            executable = root / "Contents/MacOS/Grok Bot"
            executable.parent.mkdir(parents=True)
            (root / "Contents/Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "com.anysphere.sand", "CFBundleExecutable": "Grok Bot"}))
        else:
            resource = root / "resources"
            executable = root / "Grok Bot.exe"
        resource.mkdir(parents=True)
        executable.touch()
        (resource / "app.asar").write_bytes(make_asar({"name": "sand", "productName": "Grok Bot", "version": "0.30.0"}))
        return root
    def test_detects_macos_without_claiming_connected(self):
        root = self.installation()
        result = discover_installation(platform="darwin", roots=[root])
        self.assertTrue(result["detected"])
        self.assertFalse(result["integrationReady"])
        self.assertEqual(result["installations"][0]["version"], "0.30.0")
    def test_detects_windows_public_package(self):
        root = self.installation(platform="win32")
        result = discover_installation(platform="win32", roots=[root])
        self.assertTrue(result["detected"])
        self.assertTrue(result["installations"][0]["executable"].endswith("Grok Bot.exe"))
    def test_missing_install_returns_not_detected(self):
        self.assertFalse(discover_installation(roots=[self.root / "missing"])["detected"])
    def test_multiple_installs_not_silently_selected(self):
        a, b = self.installation("one"), self.installation("two")
        result = discover_installation(platform="darwin", roots=[a, a, b])
        self.assertTrue(result["ambiguous"])
        self.assertEqual(len(result["installations"]), 2)
    def test_wrong_bundle_identifier_rejected(self):
        root = self.installation()
        (root / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "unrelated"}))
        self.assertFalse(discover_installation(platform="darwin", roots=[root])["detected"])
    def test_corrupt_archive_does_not_break_discovery(self):
        root = self.installation()
        (root / "Contents/Resources/app.asar").write_bytes(struct.pack("<4I", 4, 0xFFFFFFFF, 0, 0xFFFFFFF0))
        self.assertFalse(discover_installation(platform="darwin", roots=[root])["detected"])
    def test_other_electron_app_not_accepted(self):
        root = self.installation()
        (root / "Contents/Resources/app.asar").write_bytes(make_asar({"productName": "Other", "name": "other", "version": "1"}))
        self.assertFalse(discover_installation(platform="darwin", roots=[root])["detected"])


if __name__ == "__main__":
    unittest.main()
