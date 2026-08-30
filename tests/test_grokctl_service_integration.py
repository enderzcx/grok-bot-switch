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

from grokctl.integration import (  # noqa: E402
    BusyError,
    ExclusiveLock,
    build_switch_engine,
    load_host_config,
    temporary_host_resolver,
)
from grokctl.models import ConflictError, GrokctlError, NotWiredError, ValidationError, sha256_hex  # noqa: E402
from grokctl.remote import load_provider_hop, sha256_file  # noqa: E402
from grokctl.service import GrokctlService  # noqa: E402


FIXTURES = ROOT / "tests" / "fixtures" / "switching"
HOST_FIXTURE = ROOT / "tests" / "fixtures" / "host-roots" / "local-root" / "host-main.cjs"
SECRET_A = "sk-custom-openai-fixture"
SECRET_B = "sk-other-profile-fixture"
PUBLIC_BASE = "https://1.1.1.1/v1"
PUBLIC_ENDPOINT = "https://1.1.1.1/v1/chat/completions"


def load_profile(name: str, **overrides: object) -> dict:
    payload = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    payload["baseUrl"] = PUBLIC_BASE
    payload.update(overrides)
    return payload


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

    def _host_file(self, *, allow_apply: bool = True) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "mode": "lab-local-root",
            "hostRoot": str(self.host_root),
            "stockBundle": str(self.stock),
            "patchedBundle": str(self.patched),
            "knownStockDigests": [self.stock_digest],
            "knownPatchedDigests": [self.patched_digest],
            "allowSyntheticApply": allow_apply,
        }

    def _configure(self, *, allow_apply: bool = True) -> None:
        self.service.configure_host(self._host_file(allow_apply=allow_apply))

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

    def test_active_and_recovery_keys_cannot_be_removed_or_rotated(self) -> None:
        self._configure()
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        before = self.service.show_provider("custom-openai")["secret"]
        self.service.use("custom-openai", apply=True)
        for target in ("custom-openai", "official"):
            if target == "official":
                self.service.use("official", apply=True)
            with self.assertRaises(ConflictError):
                self.service.remove_secret("custom-openai")
            with self.assertRaises(ConflictError):
                self.service.set_secret("custom-openai", io.BytesIO(b"replacement-test-only-key"))
            self.assertEqual(self.service.show_provider("custom-openai")["secret"], before)

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
        self.assertEqual(plan["resolvedEndpoint"], PUBLIC_ENDPOINT)
        self.assertEqual(plan["runtimeKind"], "lab-synthetic")
        self.assertEqual(plan["protocol"], "openai-chat")
        self.assertEqual(plan["model"], "model-name")
        self.assertEqual(plan["fallbackPolicy"], "never")
        applied = self.service.use("custom-openai", apply=True)
        self.assertTrue(applied["apply"])
        self.assertTrue(applied["hostMutation"])
        self.assertFalse(applied["dryRun"])
        self.assertEqual(applied["receipt"]["requestedProfile"], "custom-openai")
        self.assertFalse(applied["receipt"]["liveVerified"])
        self.assertEqual(applied["runtimeKind"], "lab-synthetic")
        self.assertEqual(applied["receipt"]["runtimeKind"], "lab-synthetic")
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
        self.assertEqual(preview["action"], "switch-back")
        self.assertFalse(preview["exactRestore"])
        self.assertEqual(preview["target"], "custom-openai")
        self.assertNotEqual(preview["target"], "official")
        rolled = self.service.switch_back(apply=True)
        self.assertEqual(rolled["action"], "switch-back")
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
        self.assertEqual(missing["action"], "switch-back")
        self.assertIn("missing-receipt", missing["blocking"])
        with self.assertRaises(GrokctlError) as ctx:
            self.service.rollback(apply=True)
        self.assertEqual(ctx.exception.code, "missing-receipt")
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

    def test_lab_apply_requires_explicit_flag(self) -> None:
        self._configure(allow_apply=False)
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        plan = self.service.plan("custom-openai")
        self.assertEqual(plan["runtimeKind"], "lab-synthetic")
        self.assertFalse(plan["allowSyntheticApply"])
        self.assertFalse(plan["hostMutation"])
        with self.assertRaises(GrokctlError) as ctx:
            self.service.use("custom-openai", apply=True)
        self.assertEqual(ctx.exception.code, "lab-runtime")
        status = self.service.status()
        self.assertEqual(status["runtimeKind"], "lab-synthetic")
        self.assertEqual(status["host"]["runtimeKind"], "lab-synthetic")
        self.assertFalse(status["host"]["allowSyntheticApply"])
        self.assertEqual(status["observedProfile"], "official")
        self.assertNotEqual(status["activeProfile"], "custom-openai")
        self.assertIsNone(status["lastReceipt"])

    def test_engine_does_not_install_global_dns_resolver(self) -> None:
        hop = load_provider_hop()
        previous = hop.get_host_resolver()
        hop.set_host_resolver(None)
        try:
            self._configure(allow_apply=True)
            config = load_host_config(self.home)
            self.assertIsNotNone(config)
            build_switch_engine(self.service.registry, self.service.secrets, config)
            self.assertIsNone(hop.get_host_resolver())
        finally:
            hop.set_host_resolver(previous)

    def test_scoped_resolver_rejects_private_mapping_and_restores(self) -> None:
        hop = load_provider_hop()
        previous = hop.get_host_resolver()
        self._configure(allow_apply=True)
        self.service.add_provider(
            load_profile("profile-custom-openai.json", baseUrl="https://api.example.com/v1")
        )
        self.service.set_secret("custom-openai", io.BytesIO(SECRET_A.encode("ascii")))
        with temporary_host_resolver(lambda _host: ("10.0.0.1",)):
            plan = self.service.plan("custom-openai")
            self.assertIn("unsafe-endpoint", plan["blocking"])
        self.assertEqual(hop.get_host_resolver(), previous)

    def test_switch_back_blocks_tampered_snapshot_bundle_metadata_profile_and_digest(self) -> None:
        self._configure()
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        self._add_and_key("profile-other.json", SECRET_B)
        first = self.service.use("custom-openai", apply=True)
        snapshot_dir = Path(first["receipt"]["previousSnapshot"]["snapshotDir"])
        bundle = snapshot_dir / "host-main.cjs"
        original_bundle = bundle.read_bytes()
        bundle.write_bytes(b"TAMPERED_SNAPSHOT_BUNDLE\n")
        with self.assertRaises(GrokctlError) as ctx:
            self.service.switch_back(apply=True)
        self.assertEqual(ctx.exception.code, "snapshot-mismatch")
        bundle.write_bytes(original_bundle)

        meta_path = snapshot_dir / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        original_meta = json.dumps(meta)
        meta["state"]["activeProfile"] = "other-profile"
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        os.chmod(meta_path, 0o600)
        with self.assertRaises(GrokctlError) as ctx:
            self.service.switch_back(apply=True)
        self.assertEqual(ctx.exception.code, "snapshot-mismatch")
        meta_path.write_text(original_meta + "\n", encoding="utf-8")
        os.chmod(meta_path, 0o600)

        receipt_path = self.host_root / "grokctl" / "receipts" / "current.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        original_receipt = json.dumps(receipt)
        receipt["previousSnapshot"]["profileDigest"] = "0" * 64
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        with self.assertRaises(GrokctlError) as ctx:
            self.service.switch_back(apply=True)
        self.assertEqual(ctx.exception.code, "snapshot-mismatch")
        receipt_path.write_text(original_receipt + "\n", encoding="utf-8")

        self.service.use("other-profile", apply=True)
        profiles_path = self.home / "profiles.json"
        doc = json.loads(profiles_path.read_text(encoding="utf-8"))
        doc["profiles"]["custom-openai"]["displayName"] = "Renamed Provider"
        profiles_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        os.chmod(profiles_path, 0o600)
        with self.assertRaises(GrokctlError) as ctx:
            self.service.switch_back(apply=True)
        self.assertEqual(ctx.exception.code, "snapshot-mismatch")

    def test_remove_provider_blocks_active_desired_previous_and_allows_unrelated(self) -> None:
        self._configure()
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        self._add_and_key("profile-other.json", SECRET_B)
        self.service.add_provider(
            load_profile(
                "profile-other.json",
                id="unrelated-profile",
                displayName="Unrelated",
                auth={"type": "bearer"},
            )
        )
        self.service.set_secret("unrelated-profile", io.BytesIO(b"sk-unrelated-profile-key"))
        self.service.use("custom-openai", apply=True)
        with self.assertRaises(ConflictError):
            self.service.remove_provider("custom-openai")
        self.service.use("other-profile", apply=True)
        with self.assertRaises(ConflictError):
            self.service.remove_provider("other-profile")
        with self.assertRaises(ConflictError):
            self.service.remove_provider("custom-openai")
        removed = self.service.remove_provider("unrelated-profile")
        self.assertTrue(removed["removed"])
        listed = self.service.list_providers()
        ids = [item["id"] for item in listed["providers"]]
        self.assertIn("custom-openai", ids)
        self.assertIn("other-profile", ids)
        self.assertNotIn("unrelated-profile", ids)

    def test_legacy_local_root_mode_is_rejected(self) -> None:
        payload = self._host_file()
        payload["mode"] = "local-root"
        with self.assertRaises(ValidationError):
            self.service.configure_host(payload)


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
