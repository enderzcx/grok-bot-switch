#!/usr/bin/env python3
"""End-to-end synthetic-host tests for the grokctl service wiring."""

from __future__ import annotations

import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from grokctl.integration import BusyError, ExclusiveLock  # noqa: E402
from grokctl.models import GrokctlError, NotWiredError, ValidationError, sha256_hex  # noqa: E402
from grokctl.remote import sha256_file  # noqa: E402
from grokctl.service import GrokctlService  # noqa: E402


FIXTURES = ROOT / "tests" / "fixtures" / "switching"
HOST_FIXTURE = ROOT / "tests" / "fixtures" / "host-roots" / "local-root" / "host-main.cjs"
SECRET_A = "sk-custom-openai-fixture"
SECRET_B = "sk-other-profile-fixture"


def load_profile(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class ServiceIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.home = self.base / "grokctl-home"
        self.home.mkdir()
        os.chmod(self.home, 0o700)
        self.host_root = self.base / "host-root"
        self.host_root.mkdir()
        os.chmod(self.host_root, 0o700)
        self.artifacts = self.base / "artifacts"
        self.artifacts.mkdir()
        self.stock = self.artifacts / "stock.cjs"
        self.patched = self.artifacts / "patched.cjs"
        shutil.copyfile(FIXTURES / "stock-bundle.cjs", self.stock)
        shutil.copyfile(FIXTURES / "patched-bundle.cjs", self.patched)
        shutil.copyfile(HOST_FIXTURE, self.host_root / "host-main.cjs")
        self.stock_digest = sha256_file(self.stock)
        self.patched_digest = sha256_file(self.patched)
        self.assertEqual(self.stock_digest, sha256_hex(HOST_FIXTURE.read_bytes()))
        self.sentinel_home = self.base / "sentinel-home"
        self.sentinel_home.mkdir()
        self.service = GrokctlService(self.home)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _host_file(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "mode": "local-root",
            "hostRoot": str(self.host_root),
            "stockBundle": str(self.stock),
            "patchedBundle": str(self.patched),
            "knownStockDigests": [self.stock_digest],
            "knownPatchedDigests": [self.patched_digest],
        }

    def _configure(self) -> None:
        self.service.configure_host(self._host_file())

    def _add_and_key(self, name: str, secret: str) -> None:
        self.service.add_provider(load_profile(name))
        profile_id = load_profile(name)["id"]
        self.service.set_secret(profile_id, io.BytesIO(secret.encode("ascii")))

    def test_unconfigured_status_is_not_wired(self) -> None:
        status = self.service.status()
        self.assertEqual(status["desiredProfile"], "official")
        self.assertIsNone(status["activeProfile"])
        self.assertFalse(status["host"]["wired"])
        self.assertIn("not-wired", status["blocking"])
        with self.assertRaises(NotWiredError):
            self.service.use("official", apply=True)
        with self.assertRaises(NotWiredError):
            self.service.rollback(apply=True)
        with self.assertRaises(NotWiredError):
            self.service.test_profile("official", live=True)

    def test_configure_rejects_home_inference_and_unknown_hash(self) -> None:
        bad = self._host_file()
        bad["hostRoot"] = "~/not-a-host"
        with self.assertRaises(ValidationError):
            self.service.configure_host(bad)
        relative = self._host_file()
        relative["stockBundle"] = "stock.cjs"
        with self.assertRaises(ValidationError):
            self.service.configure_host(relative)
        unknown = self._host_file()
        unknown["knownStockDigests"] = ["0" * 64]
        with self.assertRaises(ValidationError):
            self.service.configure_host(unknown)
        self.assertFalse((self.sentinel_home / ".grokctl").exists())

    def test_official_to_external_status_and_official_round_trip(self) -> None:
        self._configure()
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        plan = self.service.plan("custom-openai")
        self.assertTrue(plan["wired"])
        self.assertFalse(plan["apply"])
        self.assertFalse(plan["hostMutation"])
        self.assertEqual(plan["blocking"], [])
        self.assertEqual(plan["resolvedMethod"], "POST")
        self.assertEqual(plan["resolvedEndpoint"], "https://api.example.com/v1/chat/completions")
        self.assertEqual(plan["protocol"], "openai-chat")
        self.assertEqual(plan["model"], "model-name")
        self.assertEqual(plan["fallbackPolicy"], "never")
        applied = self.service.use("custom-openai", apply=True)
        self.assertTrue(applied["apply"])
        self.assertTrue(applied["hostMutation"])
        self.assertFalse(applied["dryRun"])
        self.assertEqual(applied["receipt"]["requestedProfile"], "custom-openai")
        self.assertFalse(applied["receipt"]["liveVerified"])
        blob = json.dumps(applied)
        self.assertNotIn(SECRET_A, blob)

        status = self.service.status()
        self.assertTrue(status["host"]["wired"])
        self.assertEqual(status["desiredProfile"], "custom-openai")
        self.assertEqual(status["observedProfile"], "custom-openai")
        self.assertEqual(status["activeProfile"], "custom-openai")
        self.assertEqual(status["generation"], 1)
        self.assertFalse(status["drift"])
        self.assertEqual(status["blocking"], [])
        self.assertEqual(status["host"]["hopHealth"], "healthy")
        self.assertEqual(status["host"]["bundleDigest"], self.patched_digest)
        self.assertIsNotNone(status["host"]["pid"])
        self.assertIsNotNone(status["lastReceipt"])
        self.assertNotIn(SECRET_A, json.dumps(status))

        verify = self.service.verify()
        self.assertTrue(verify["ok"])
        self.assertFalse(verify["live"])
        self.assertEqual(verify["protocol"], "openai-chat")
        self.assertEqual(verify["model"], "model-name")

        back = self.service.use("official", apply=True)
        self.assertEqual(back["target"], "official")
        self.assertEqual(back["receipt"]["requestedProfile"], "official")
        after = self.service.status()
        self.assertEqual(after["desiredProfile"], "official")
        self.assertEqual(after["observedProfile"], "official")
        self.assertEqual(after["activeProfile"], "official")
        self.assertEqual(after["host"]["hopHealth"], "stopped")
        self.assertEqual(after["host"]["bundleDigest"], self.stock_digest)
        secret_path = self.home / "secrets" / "profile" / "custom-openai"
        self.assertTrue(secret_path.is_file())
        self.assertEqual(stat.S_IMODE((self.home / "host.json").stat().st_mode), 0o600)

    def test_a_to_b_rollback_uses_receipt_not_hardcoded_official(self) -> None:
        self._configure()
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        self._add_and_key("profile-other.json", SECRET_B)
        self.service.use("custom-openai", apply=True)
        self.service.use("other-profile", apply=True)
        preview = self.service.rollback(apply=False)
        self.assertTrue(preview["dryRun"])
        self.assertEqual(preview["target"], "custom-openai")
        self.assertNotEqual(preview["target"], "official")
        rolled = self.service.rollback(apply=True)
        self.assertEqual(rolled["target"], "custom-openai")
        self.assertTrue(rolled["hostMutation"])
        status = self.service.status()
        self.assertEqual(status["desiredProfile"], "custom-openai")
        self.assertEqual(status["observedProfile"], "custom-openai")
        self.assertEqual(status["activeProfile"], "custom-openai")
        self.assertFalse(status["drift"])

    def test_drift_pending_unknown_hash_and_missing_receipt(self) -> None:
        self._configure()
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        self.service.use("custom-openai", apply=True)

        state_path = self.host_root / "grokctl" / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["activeProfile"] = "other-profile"
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        drifted = self.service.status()
        self.assertTrue(drifted["drift"])
        self.assertIn("drift", drifted["blocking"])
        self.assertIsNone(drifted["activeProfile"])
        self.assertEqual(drifted["desiredProfile"], "custom-openai")
        self.assertEqual(drifted["observedProfile"], "other-profile")
        state["activeProfile"] = "custom-openai"
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

        command = self.host_root / "supervisor" / "command.json"
        command.parent.mkdir(parents=True, exist_ok=True)
        command.write_text(json.dumps({"id": "already-pending", "kind": "restart"}) + "\n", encoding="utf-8")
        pending = self.service.plan("official")
        self.assertIn("pending-command", pending["blocking"])
        with self.assertRaises(ValidationError):
            self.service.use("official", apply=True)
        command.unlink()

        bundle = self.host_root / "host-main.cjs"
        bundle.write_text("UNKNOWN_BUNDLE\n", encoding="utf-8")
        unknown = self.service.status()
        self.assertIn("unknown-hash", unknown["blocking"])
        with self.assertRaises(ValidationError):
            self.service.use("official", apply=True)
        shutil.copyfile(self.patched, bundle)

        receipt = self.host_root / "grokctl" / "receipts" / "current.json"
        self.assertTrue(receipt.is_file())
        receipt.unlink()
        missing = self.service.rollback(apply=False)
        self.assertIn("missing-receipt", missing["blocking"])
        with self.assertRaises(ValidationError) as ctx:
            self.service.rollback(apply=True)
        self.assertIn("回执", str(ctx.exception))

    def test_busy_lock_rejects_second_process_without_stealing(self) -> None:
        self._configure()
        lock_path = self.home / "lock"
        holder = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import fcntl, os, sys, time\n"
                "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)\n"
                "fcntl.flock(fd, fcntl.LOCK_EX)\n"
                "sys.stdout.write('held\\n')\n"
                "sys.stdout.flush()\n"
                "time.sleep(30)\n",
                str(lock_path),
            ],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            line = holder.stdout.readline() if holder.stdout is not None else ""
            self.assertEqual(line.strip(), "held")
            with self.assertRaises(BusyError) as ctx:
                self.service.add_provider(load_profile("profile-custom-openai.json"))
            self.assertEqual(ctx.exception.code, "busy")
            self.assertEqual(ctx.exception.message, "控制面正在忙")
            self.assertFalse((self.home / "profiles.json").exists())
        finally:
            holder.terminate()
            holder.wait(timeout=5)
            if holder.stdout is not None:
                holder.stdout.close()
            if holder.stderr is not None:
                holder.stderr.close()
        added = self.service.add_provider(load_profile("profile-custom-openai.json"))
        self.assertEqual(added["id"], "custom-openai")

    def test_live_remains_not_wired_after_configure(self) -> None:
        self._configure()
        with self.assertRaises(NotWiredError):
            self.service.verify(live=True)
        with self.assertRaises(NotWiredError):
            self.service.test_profile("official", live=True)

    def test_mutations_do_not_touch_sentinel_home(self) -> None:
        self._configure()
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        self.service.use("custom-openai", apply=True)
        self.assertFalse((self.sentinel_home / ".grokctl").exists())
        self.assertTrue((self.home / "host.json").is_file())
        self.assertTrue((self.home / "profiles.json").is_file())
        self.assertTrue((self.home / "secrets" / "profile" / "custom-openai").is_file())


class LockContractTests(unittest.TestCase):
    def test_lock_file_is_owner_only(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        try:
            home = Path(tmp.name) / "home"
            home.mkdir()
            os.chmod(home, 0o700)
            lock = ExclusiveLock(home)
            with lock.holding():
                mode = stat.S_IMODE((home / "lock").stat().st_mode)
                self.assertEqual(mode, 0o600)
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
