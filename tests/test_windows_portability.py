"""Credential-free portable tests; native DACL/junction tests require Windows."""

import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from grokctl import platform_security as security
from grokctl.integration import BusyError, ExclusiveLock, parse_host_config
from grokctl.models import GrokctlError, ValidationError
from grokctl.profiles import ensure_private_dir
from grokctl.service import GrokctlService


class PortabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "control"

    def tearDown(self):
        self.tmp.cleanup()

    def test_service_secret_roundtrip_without_host(self):
        service = GrokctlService(self.home)
        service.add_provider({
            "schemaVersion": 1, "id": "portable", "displayName": "Portable",
            "protocol": "openai-chat", "baseUrl": "https://example.com/v1",
            "model": "test-model", "auth": {"type": "bearer"},
            "headers": {}, "parameters": {}, "fallbackPolicy": "never", "enabled": True,
        })
        service.set_secret("portable", io.BytesIO(b"synthetic-portability-key"))
        self.assertTrue(service.secrets.status("portable").installed)
        self.assertTrue(security.private_permissions(service.secrets.path_for("portable")))
        self.assertTrue(security.private_permissions(service.registry.path))
        self.assertFalse(service.status()["host"]["wired"])
        self.assertEqual(len(service.list_providers()["providers"]), 2)
        self.assertTrue(service.activity()["events"])
        service.secrets.remove("portable")
        self.assertFalse(service.secrets.status("portable").installed)

    def test_busy_process_cannot_modify_or_unlock_owner_lock(self):
        lock = ExclusiveLock(self.home)
        script = (
            "import sys; from pathlib import Path; "
            "from grokctl.integration import ExclusiveLock, BusyError\n"
            "try:\n"
            " with ExclusiveLock(Path(sys.argv[1])).holding(): sys.exit(3)\n"
            "except BusyError: sys.exit(0)\n"
        )
        with lock.holding():
            # Windows byte-range locks also block reads via a second handle.
            before = lock.path.stat().st_size if os.name == "nt" else lock.path.read_bytes()
            for _ in range(2):
                result = subprocess.run([sys.executable, "-c", script, str(self.home)], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                after = lock.path.stat().st_size if os.name == "nt" else lock.path.read_bytes()
                self.assertEqual(after, before)
        with lock.holding():
            pass

    def test_failed_lock_never_unlocks(self):
        lock = ExclusiveLock(self.home)
        with patch("grokctl.integration.lock_exclusive", side_effect=BlockingIOError(11, "busy")), patch("grokctl.integration.unlock") as release:
            with self.assertRaises(BusyError), lock.holding():
                self.fail("entered contended lock")
            release.assert_not_called()

    def test_reparse_attribute_rejected_even_if_not_symlink(self):
        info = SimpleNamespace(st_mode=0o100600, st_file_attributes=0x400)
        with patch.object(Path, "lstat", return_value=info):
            with self.assertRaises(OSError):
                security.reject_links(self.home)

    def test_windows_host_configuration_fails_closed(self):
        with patch("grokctl.integration.IS_WINDOWS", True):
            with self.assertRaises(GrokctlError) as raised:
                parse_host_config({})
            self.assertEqual(raised.exception.code, "unsupported-platform")

    @unittest.skipUnless(os.name == "nt", "native Windows ACL validation")
    def test_windows_rejects_broad_acl_before_secret_read(self):
        service = GrokctlService(self.home)
        service.secrets.set_from_stream("portable", io.BytesIO(b"synthetic-key"))
        path = service.secrets.path_for("portable")
        subprocess.run(["icacls", str(path), "/grant", "*S-1-1-0:(R)"], check=True, capture_output=True)
        self.assertFalse(security.private_permissions(path))
        with patch("grokctl.secrets._read_complete", side_effect=AssertionError("read unsafe secret")):
            self.assertTrue(service.secrets.status("portable").rejected)

    @unittest.skipUnless(os.name == "nt", "native Windows junction validation")
    def test_windows_rejects_junction_parent(self):
        target = Path(self.tmp.name) / "target"
        target.mkdir()
        link = Path(self.tmp.name) / "junction"
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True)
        try:
            with self.assertRaises(ValidationError):
                ensure_private_dir(link / "secrets")
            self.assertFalse((target / "secrets").exists())
        finally:
            link.rmdir()


if __name__ == "__main__":
    unittest.main()
