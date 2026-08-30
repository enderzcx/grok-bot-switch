"""Synthetic ASAR and injected Windows operations; no real app/process access."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from grokctl import asar_patch
from grokctl import client_install as ci
from grokctl.profiles import atomic_replace, ensure_private_dir


def fixture(version="0.28.0", product="Grok Bot"):
    main = b"'use strict';\n"
    package = json.dumps({"name": "sand", "productName": product, "version": version}).encode()
    header = {"files": {
        "package.json": {"offset": str(len(main)), "size": len(package)},
        "dist": {"files": {"electron-main": {"files": {"main.cjs": {"offset": "0", "size": len(main)}}}}}}}
    return asar_patch._pack(header, main + package)


class ClientInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.root = self.base / "client"
        self.resources = self.root / "resources"
        self.resources.mkdir(parents=True)
        (self.root / "Grok Bot.exe").write_bytes(b"synthetic executable")
        self.target = self.resources / "app.asar"
        self.stock = fixture()
        self.target.write_bytes(self.stock)
        self.stock_sha = hashlib.sha256(self.stock).hexdigest()
        self.installation = {"path": str(self.root), "executable": str(self.root / "Grok Bot.exe"), "version": "0.28.0"}
        self.template = (ci.ANCHOR + "\nglobalThis.fixture = installedHome;").encode()
        self.real_guard = ci._windows_only
        self.real_process_check = ci._assert_not_running
        for name, value in (("_windows_only", lambda: None), ("STOCK_SHA256", self.stock_sha)):
            active = patch.object(ci, name, value)
            active.start()
            self.addCleanup(active.stop)
        active = patch.object(ci, "_assert_not_running")
        self.process_check = active.start()
        self.addCleanup(active.stop)
        active = patch.object(ci, "_replace_windows", side_effect=self.replace)
        self.replaced = active.start()
        self.addCleanup(active.stop)

    @staticmethod
    def replace(target, staged, previous):
        target.rename(previous)
        staged.rename(target)

    def install(self, template=None):
        return ci.install_adapter(self.home, self.installation, self.template if template is None else template)

    def test_install_backup_receipt_and_restore(self):
        installed = self.install()
        self.assertTrue(installed["managed"])
        self.assertEqual(installed["state"], "installed")
        self.assertEqual(installed["before_sha256"], self.stock_sha)
        self.assertEqual(ci._sha(self.target), installed["after_sha256"])
        backup = Path(installed["backupPath"])
        self.assertEqual(backup.read_bytes(), self.stock)
        self.assertEqual(Path(installed["previousArchive"]).read_bytes(), self.stock)
        if os.name != "nt":
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads((self.home / "bridge-enabled.json").read_bytes())["mode"], "native-switch")
        self.assertIn(json.dumps(str(self.home)).encode(), self.target.read_bytes())
        restored = ci.restore_adapter(self.home, self.installation)
        self.assertFalse(restored["managed"])
        self.assertEqual(restored["state"], "restored")
        self.assertEqual(self.target.read_bytes(), self.stock)
        self.assertEqual(json.loads((self.home / "bridge-enabled.json").read_bytes())["mode"], "disabled")
        self.assertEqual(self.process_check.call_count, 4)

    def test_unknown_patched_archive_is_never_overwritten(self):
        self.target.write_bytes(self.stock + b"foreign patch")
        before = self.target.read_bytes()
        with self.assertRaises(ci.ClientInstallError) as error:
            self.install()
        self.assertEqual(error.exception.code, "unmanaged-archive")
        self.assertEqual(self.target.read_bytes(), before)
        self.replaced.assert_not_called()

    def test_owned_adapter_upgrade_starts_from_original_backup(self):
        first = self.install()
        second = self.install(self.template + b"\n// update")
        self.assertEqual(second["before_sha256"], self.stock_sha)
        self.assertNotEqual(first["after_sha256"], second["after_sha256"])
        self.assertEqual(ci._sha(Path(second["previousArchive"])), first["after_sha256"])

    def test_legacy_original_only_accepted_with_matching_private_receipt(self):
        home = ensure_private_dir(self.home)
        legacy = self.resources / "app.asar.original-v028"
        legacy.write_bytes(self.stock)
        staged = self.resources / "legacy-patched.asar"
        receipt = asar_patch.build_patch(legacy, staged, b"// prior acceptance adapter", self.stock_sha)
        self.target.write_bytes(staged.read_bytes())
        with self.assertRaises(ci.ClientInstallError):
            self.install()
        atomic_replace(home / "patch-receipt.json", json.dumps(receipt).encode())
        result = self.install()
        self.assertEqual(Path(result["backupPath"]).read_bytes(), self.stock)

    def test_template_limits_and_single_anchor(self):
        for template in (b"no anchor", self.template + self.template, b"\xff", b"x" * (2 * 1024 * 1024 + 1)):
            with self.subTest(size=len(template)), self.assertRaises(ci.ClientInstallError):
                self.install(template)
        self.replaced.assert_not_called()
        self.assertEqual(self.target.read_bytes(), self.stock)

    def test_actual_metadata_not_discovery_claim_is_validated(self):
        for version, product in (("0.29.0", "Grok Bot"), ("0.28.0", "Other")):
            self.target.write_bytes(fixture(version, product))
            with self.assertRaises(ci.ClientInstallError):
                self.install()
        self.replaced.assert_not_called()

    def test_client_starting_before_swap_blocks_replace(self):
        self.process_check.side_effect = [None, ci.ClientInstallError("client-busy")]
        with self.assertRaises(ci.ClientInstallError) as error:
            self.install()
        self.assertEqual(error.exception.code, "client-busy")
        self.replaced.assert_not_called()
        self.assertEqual(self.target.read_bytes(), self.stock)

    def test_changed_target_before_swap_is_not_overwritten(self):
        original = ci.asar_patch.build_patch
        def build(*args, **kwargs):
            result = original(*args, **kwargs)
            self.target.write_bytes(self.stock + b"external change")
            return result
        with patch.object(ci.asar_patch, "build_patch", side_effect=build), self.assertRaises(ci.ClientInstallError) as error:
            self.install()
        self.assertEqual(error.exception.code, "archive-changed")
        self.replaced.assert_not_called()

    def test_post_swap_receipt_failure_retains_backups_and_does_not_rollback(self):
        original = ci.atomic_replace
        def write(path, raw, **kwargs):
            if path.name == "patch-receipt.json":
                raise OSError("synthetic write failure")
            return original(path, raw, **kwargs)
        with patch.object(ci, "atomic_replace", side_effect=write), self.assertRaises(ci.ClientInstallError) as error:
            self.install()
        self.assertEqual(error.exception.code, "recovery-required")
        self.assertEqual(self.replaced.call_count, 1)
        recovery = error.exception.recovery
        self.assertEqual(Path(recovery["originalBackup"]).read_bytes(), self.stock)
        self.assertEqual(Path(recovery["previousArchive"]).read_bytes(), self.stock)
        self.assertEqual(ci._sha(self.target), recovery["expectedAfter"])

    def test_restore_rejects_changed_archive_or_backup(self):
        result = self.install()
        Path(result["backupPath"]).write_bytes(b"corrupt backup")
        with self.assertRaises(ci.ClientInstallError) as error:
            ci.restore_adapter(self.home, self.installation)
        self.assertEqual(error.exception.code, "invalid-backup")
        self.assertEqual(self.replaced.call_count, 1)

    def test_non_windows_guard_precedes_all_file_access(self):
        # The real guard is independent of injected install operations.
        with patch.object(ci, "_windows_only", self.real_guard), patch.object(ci.sys, "platform", "darwin"), self.assertRaises(ci.ClientInstallError) as error:
            ci.install_adapter(Path("/Applications/Grok Bot.app"), {}, self.template)
        self.assertEqual(error.exception.code, "unsupported-platform")
        self.replaced.assert_not_called()

    def test_matching_process_with_unreadable_path_is_busy(self):
        import ctypes
        kernel = Mock()
        kernel.CreateToolhelp32Snapshot.return_value = 100
        kernel.OpenProcess.return_value = 0
        def first(_handle, entry):
            entry._obj.name = "Grok Bot.exe"
            entry._obj.pid = 1234
            return True
        kernel.Process32FirstW.side_effect = first
        with patch.object(ctypes, "WinDLL", return_value=kernel, create=True), self.assertRaises(ci.ClientInstallError) as error:
            self.real_process_check(Path(self.installation["executable"]))
        self.assertEqual(error.exception.code, "client-busy")
        kernel.CloseHandle.assert_called_with(100)

    def test_partial_replace_error_retains_recovery_backup_without_guessing(self):
        def fail_after_rename(target, _staged, previous):
            target.rename(previous)
            raise OSError("simulated ReplaceFile partial failure")
        self.replaced.side_effect = fail_after_rename
        with self.assertRaises(ci.ClientInstallError) as error:
            self.install()
        self.assertEqual(error.exception.code, "recovery-required")
        self.assertFalse(self.target.exists())
        self.assertEqual(Path(error.exception.recovery["previousArchive"]).read_bytes(), self.stock)
        self.assertEqual(Path(error.exception.recovery["originalBackup"]).read_bytes(), self.stock)
        self.replaced.assert_called_once()


if __name__ == "__main__":
    unittest.main()
