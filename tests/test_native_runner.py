import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from grokctl.profiles import atomic_replace, ensure_private_dir
from ops import native_runner as runner


class NativeRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = ensure_private_dir(Path(self.temp.name) / "grok-home")
        self.patch = patch.object(runner, "ROOT", self.root)
        self.patch.start()
        self.observation = {"pid": 123, "startedAt": 2000, "health": True, "isBusy": False,
                            "hostBundleSha256": sorted(runner.SUPPORTED_STOCK_SHA256)[0],
                            "hostVersion": "17184bb", "pendingCommand": None, "supervisorLastCommand": None}
        class Host:
            def read_observation(inner):
                return dict(self.observation)
            def _assert_supervisor(inner):
                pass
        self.host = Host()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_stock_readback_is_official_not_external_activation(self):
        result = runner.inspect(self.host)
        self.assertEqual(result["activeProfile"], "official")
        self.assertIsNone(result["activation"])
        self.assertEqual(result["blocking"], [])

    def test_unknown_host_is_not_switch_ready(self):
        self.observation["hostBundleSha256"] = "f" * 64
        result = runner.inspect(self.host)
        self.assertIsNone(result["activeProfile"])
        self.assertFalse(result["providerSwitchReady"])

    def test_unowned_config_is_not_claimed_as_active(self):
        atomic_replace(self.root / "config/external.json", b'{"enabled":true}')
        result = runner.inspect(self.host)
        self.assertIsNone(result["activeProfile"])
        self.assertIn("unknown-host-state", result["blocking"])

    def test_receipt_identity_and_config_are_checked_fresh(self):
        config = b'{"enabled":false}'
        atomic_replace(self.root / "config/external.json", config)
        active = {**self.observation, "target": "official", "verified": True,
                  "configDigest": hashlib.sha256(config).hexdigest(), "hop": None,
                  "secret": "SENTINEL_NEVER_RETURN"}
        atomic_replace(self.root / "native-active.json", json.dumps(active).encode())
        self.assertEqual(runner.inspect(self.host)["activeProfile"], "official")
        self.observation["pid"] += 1
        result = runner.inspect(self.host)
        self.assertIsNone(result["activeProfile"])
        self.assertIn("active-state-drift", result["blocking"])
        self.assertFalse(result["providerSwitchReady"])
        self.assertNotIn("SENTINEL", json.dumps(result))

    def test_pending_status_does_not_advance_or_touch_journal(self):
        job = self.root / "native-job.json"
        atomic_replace(job, b'{"id":"test","status":"pending","target":"custom","secret":"SENTINEL"}')
        before = job.read_bytes(), job.stat().st_mtime_ns
        result = runner.inspect(self.host)
        self.assertEqual(result["desiredProfile"], "custom")
        self.assertIn("activation-in-progress", result["blocking"])
        self.assertFalse(result["providerSwitchReady"])
        self.assertNotIn("SENTINEL", json.dumps(result))
        self.assertEqual(before, (job.read_bytes(), job.stat().st_mtime_ns))

    def test_busy_or_pending_command_is_not_switch_ready(self):
        for field, value in (("isBusy", True), ("pendingCommand", {"id": "other"})):
            with self.subTest(field=field):
                previous = self.observation[field]
                self.observation[field] = value
                result = runner.inspect(self.host)
                self.assertFalse(result["providerSwitchReady"])
                self.assertEqual(result["activeProfile"], "official")
                self.observation[field] = previous

    def test_public_errors_are_fixed_and_never_raw_exception_text(self):
        from ops.native_activation import ActivationError
        self.assertEqual(runner.public_error(ActivationError("host-not-healthy-idle")), "host-not-healthy-idle")
        self.assertEqual(runner.public_error(ValueError("host-not-healthy-idle")), "native-operation-failed")
        self.assertEqual(runner.public_error(ActivationError("SECRET_SENTINEL")), "native-operation-failed")


if __name__ == "__main__":
    unittest.main()
