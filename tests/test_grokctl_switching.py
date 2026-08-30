#!/usr/bin/env python3
"""Synthetic-host tests for the grokctl v0.1 switch transaction engine."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from grokctl.remote import (  # noqa: E402
    SequenceUuid,
    SyntheticProcessGateway,
    atomic_write_bytes,
    atomic_write_text,
    build_runtime,
    load_provider_hop,
    sha256_file,
)
from grokctl.switching import (  # noqa: E402
    HOST_HOP_TIMEOUT_SEC,
    ArtifactSet,
    ProfileCatalog,
    SwitchEngine,
    SwitchError,
)


FIXTURES = ROOT / "tests" / "fixtures" / "switching"
SECRET_A = "sk-custom-openai-fixture"
SECRET_B = "sk-other-profile-fixture"


def load_profile(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def file_tree(root: Path):
    items = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            items.append((str(path.relative_to(root)), sha256_file(path), path.stat().st_size))
    return items


class SwitchTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._hop = load_provider_hop()
        self._previous_resolver = self._hop.get_host_resolver()
        self._hop.set_host_resolver(lambda host: ("8.8.8.8",))
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.stock = self.root / "artifacts" / "stock.cjs"
        self.patched = self.root / "artifacts" / "patched.cjs"
        self.stock.parent.mkdir(parents=True)
        shutil.copyfile(FIXTURES / "stock-bundle.cjs", self.stock)
        shutil.copyfile(FIXTURES / "patched-bundle.cjs", self.patched)
        self.stock_digest = sha256_file(self.stock)
        self.patched_digest = sha256_file(self.patched)
        self.runtime = build_runtime(
            self.root,
            ids=SequenceUuid(),
            processes=SyntheticProcessGateway(),
            hop_cmdline_token="provider_hop.py",
        )
        self.layout = self.runtime.layout
        self.layout.secrets_dir.mkdir(parents=True)
        self.layout.bundle_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.stock, self.layout.bundle_path)
        self._write_secret("profile/custom-openai", SECRET_A)
        self._write_secret("profile/other-profile", SECRET_B)
        self.runtime.write_state({"schemaVersion": 1, "generation": 0, "activeProfile": "official"})
        self.catalog = ProfileCatalog.from_mapping(
            {
                "custom-openai": load_profile("profile-custom-openai.json"),
                "other-profile": load_profile("profile-other.json"),
            }
        )
        self.artifacts = ArtifactSet(
            stock_bundle=self.stock,
            patched_bundle=self.patched,
            known_stock_digests=(self.stock_digest,),
            known_patched_digests=(self.patched_digest,),
            hop_listen_host="127.0.0.1",
            hop_listen_port=18779,
        )
        self.engine = SwitchEngine(self.runtime, self.catalog, self.artifacts)

    def tearDown(self) -> None:
        self.tmp.cleanup()
        self._hop.set_host_resolver(self._previous_resolver)

    def _write_secret(self, secret_ref: str, value: str) -> Path:
        path = self.runtime.secret_path(secret_ref)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value + "\n", encoding="utf-8")
        os.chmod(path, 0o600)
        return path

    def _active_bundle(self) -> str:
        return sha256_file(self.layout.bundle_path)

    def _secret_exists(self, secret_ref: str) -> bool:
        return self.runtime.secret_path(secret_ref).is_file()

    def test_plan_is_pure_and_apply_requires_explicit_authority(self) -> None:
        before = file_tree(self.root)
        plan = self.engine.plan("custom-openai")
        after = file_tree(self.root)
        self.assertEqual(before, after)
        self.assertFalse(plan.live_verified)
        self.assertEqual(plan.target_kind, "external")
        self.assertEqual(plan.previous_profile, "official")
        self.assertEqual(plan.generation, 1)
        self.assertEqual(plan.bundle_digest, self.patched_digest)
        self.assertIn("supervisorCommandId", plan.to_dict())
        self.assertIn("stagedPaths", plan.to_dict())
        self.assertIn("previousSnapshot", plan.to_dict())
        self.assertEqual(plan.to_dict()["liveVerified"], False)
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=False)
        self.assertEqual(ctx.exception.code, "apply_required")
        self.assertEqual(file_tree(self.root), before)
        self.assertEqual(self._active_bundle(), self.stock_digest)

    def test_external_switch_retires_old_hop_and_official_leaves_none(self) -> None:
        self.engine.execute("custom-openai", apply=True)
        first_pid = self.runtime.read_hop_pid()
        self.engine.execute("other-profile", apply=True)
        self.assertEqual(len(self.runtime.processes.running_hops), 1)
        self.assertNotIn(first_pid, self.runtime.processes.running_hops)
        self.engine.execute("official", apply=True)
        self.assertEqual(self.runtime.processes.running_hops, {})
        self.assertIsNone(self.runtime.read_hop_pid())

    def test_hop_health_failure_cleans_candidate_and_restores_old_listener(self) -> None:
        self.engine.execute("custom-openai", apply=True)
        first_pid = self.runtime.read_hop_pid()
        self.runtime.processes.fail_hop_health = True
        with self.assertRaises(SwitchError):
            self.engine.execute("other-profile", apply=True)
        self.assertEqual(list(self.runtime.processes.running_hops), [first_pid])
        self.assertEqual(self.runtime.read_hop_pid(), first_pid)
        self.assertEqual(self.runtime.observe().profile_id, "custom-openai")

    def test_post_restart_failure_cleans_candidate_hop(self) -> None:
        self.engine.execute("custom-openai", apply=True)
        first_pid = self.runtime.read_hop_pid()
        self.runtime.receipts_enabled = False
        with self.assertRaises(SwitchError):
            self.engine.execute("other-profile", apply=True)
        self.assertEqual(list(self.runtime.processes.running_hops), [first_pid])
        self.assertEqual(self.runtime.read_hop_pid(), first_pid)

    def test_official_external_official_round_trip(self) -> None:
        plan = self.engine.plan("custom-openai")
        receipt = self.engine.apply(plan, apply=True)
        self.assertEqual(receipt.requested_profile, "custom-openai")
        self.assertEqual(receipt.previous_profile, "official")
        self.assertEqual(receipt.generation, 1)
        self.assertEqual(receipt.bundle_digest, self.patched_digest)
        self.assertEqual(receipt.hop_health, "healthy")
        self.assertFalse(receipt.live_verified)
        self.assertEqual(receipt.to_dict()["liveVerified"], False)
        self.assertNotEqual(receipt.host_pid, plan.observed_pid)
        self.assertEqual(self._active_bundle(), self.patched_digest)
        self.assertTrue(self.layout.config_path.is_file())
        config = json.loads(self.layout.config_path.read_text(encoding="utf-8"))
        self.assertEqual(config["mode"], "external-only")
        self.assertEqual(config["nativeFallback"], False)
        self.assertEqual(config["profileId"], "custom-openai")
        self.assertTrue(self._secret_exists("profile/custom-openai"))
        self.assertTrue(self._secret_exists("profile/other-profile"))
        self.assertEqual(self.runtime.load_state()["activeProfile"], "custom-openai")
        current = self.runtime.current_receipt()
        self.assertEqual(current["transactionId"], receipt.transaction_id)
        self.assertEqual(current["liveVerified"], False)

        back = self.engine.apply(self.engine.plan("official"), apply=True)
        self.assertEqual(back.requested_profile, "official")
        self.assertEqual(back.previous_profile, "custom-openai")
        self.assertEqual(back.hop_health, "stopped")
        self.assertEqual(self._active_bundle(), self.stock_digest)
        self.assertFalse(self.layout.config_path.exists())
        self.assertTrue(Path(str(self.layout.config_path) + ".disabled").is_file())
        self.assertTrue(self._secret_exists("profile/custom-openai"))
        self.assertTrue(self._secret_exists("profile/other-profile"))
        self.assertIsNone(self.runtime.read_hop_pid())
        self.assertEqual(self.runtime.load_state()["activeProfile"], "official")
        self.assertFalse(back.live_verified)

    def test_pending_command_blocks_without_mutation(self) -> None:
        atomic_write_text(
            self.layout.supervisor_command_path,
            json.dumps({"id": "already-pending", "kind": "restart"}) + "\n",
        )
        before = file_tree(self.root)
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("custom-openai")
        self.assertEqual(ctx.exception.code, "pending_command")
        self.assertEqual(file_tree(self.root), before)
        self.assertEqual(self._active_bundle(), self.stock_digest)

    def test_busy_agent_blocks_without_mutation(self) -> None:
        self.layout.busy_signal_path.parent.mkdir(parents=True, exist_ok=True)
        self.layout.busy_signal_path.write_text("busy\n", encoding="utf-8")
        before = self._active_bundle()
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("custom-openai")
        self.assertEqual(ctx.exception.code, "busy_agent")
        self.assertEqual(self._active_bundle(), before)

    def test_unknown_bundle_hash_blocks_activation(self) -> None:
        self.layout.bundle_path.write_text("UNKNOWN_BUNDLE\n", encoding="utf-8")
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("custom-openai")
        self.assertEqual(ctx.exception.code, "unknown_hash")
        self.assertFalse(self.layout.config_path.exists())
        self.assertIsNone(self.runtime.pending_command())

        shutil.copyfile(self.stock, self.layout.bundle_path)
        self.patched.write_text("UNKNOWN_PATCHED\n", encoding="utf-8")
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("custom-openai")
        self.assertEqual(ctx.exception.code, "unknown_hash")

    def test_mismatched_staged_artifacts_are_rejected(self) -> None:
        plan = self.engine.plan("custom-openai")
        self.patched.write_text("TAMPERED_PATCHED\n", encoding="utf-8")
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=True)
        self.assertEqual(ctx.exception.code, "staged_mismatch")
        self.assertEqual(self._active_bundle(), self.stock_digest)
        self.assertEqual(self.runtime.load_state()["activeProfile"], "official")
        self.assertIsNone(self.runtime.pending_command())

    def test_invalid_secret_metadata_is_rejected(self) -> None:
        path = self.runtime.secret_path("profile/custom-openai")
        os.chmod(path, 0o644)
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("custom-openai")
        self.assertEqual(ctx.exception.code, "invalid_secret")
        os.chmod(path, 0o600)
        path.unlink()
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("custom-openai")
        self.assertIn(ctx.exception.code, ("invalid_secret", "missing_secret"))
        link = self.runtime.secret_path("profile/custom-openai")
        link.symlink_to(self.root / "missing-target")
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("custom-openai")
        self.assertEqual(ctx.exception.code, "invalid_secret")

    def test_unsafe_endpoint_is_rejected(self) -> None:
        bad = load_profile("profile-custom-openai.json")
        bad["baseUrl"] = "http://example.com/v1"
        with self.assertRaises(SwitchError) as ctx:
            ProfileCatalog.from_mapping(
                {"custom-openai": bad, "other-profile": load_profile("profile-other.json")}
            )
        self.assertEqual(ctx.exception.code, "unsafe_endpoint")

    def test_hop_start_failure_leaves_active_state_unchanged(self) -> None:
        self.runtime.processes.fail_hop_start = True
        plan = self.engine.plan("custom-openai")
        before_pid = self.runtime.processes.host_pid
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=True)
        self.assertEqual(ctx.exception.code, "hop_start_failed")
        self.assertEqual(self._active_bundle(), self.stock_digest)
        self.assertEqual(self.runtime.load_state()["activeProfile"], "official")
        self.assertFalse(self.layout.config_path.exists())
        self.assertIsNone(self.runtime.pending_command())
        self.assertEqual(self.runtime.processes.host_pid, before_pid)
        self.assertTrue(self._secret_exists("profile/custom-openai"))

    def test_inconsistent_hop_health_fails_before_restart(self) -> None:
        self.runtime.processes.inconsistent_health = True
        plan = self.engine.plan("custom-openai")
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=True)
        self.assertEqual(ctx.exception.code, "protocol_mismatch")
        self.assertEqual(self._active_bundle(), self.stock_digest)
        self.assertEqual(self.runtime.load_state()["activeProfile"], "official")
        self.assertIsNone(self.runtime.pending_command())

    def test_restart_failure_rolls_back_previous_snapshot(self) -> None:
        plan = self.engine.plan("custom-openai")
        self.runtime.supervisor.fail_next_wait = 1
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=True)
        self.assertEqual(ctx.exception.code, "restart_failed")
        self.assertEqual(ctx.exception.evidence.get("previousProfile"), "official")
        self.assertEqual(ctx.exception.evidence.get("target"), "custom-openai")
        self.assertEqual(self._active_bundle(), self.stock_digest)
        self.assertEqual(self.runtime.load_state()["activeProfile"], "official")
        self.assertIsNone(self.runtime.pending_command())
        self.assertIn("rollbackCommandId", ctx.exception.evidence)
        self.assertTrue(ctx.exception.evidence["restoreProven"])
        self.assertNotEqual(self.runtime.processes.host_pid, plan.observed_pid)

    def test_post_restart_restore_is_read_back_before_claiming_success(self) -> None:
        original_restore = self.runtime.restore_snapshot

        def corrupt_restore(snapshot):
            original_restore(snapshot)
            self.layout.bundle_path.write_bytes(b"corrupt-restored-bundle")

        self.runtime.restore_snapshot = corrupt_restore
        self.runtime.supervisor.fail_next_wait = 1
        with self.assertRaises(SwitchError) as ctx:
            self.engine.execute("custom-openai", apply=True)
        self.assertEqual(ctx.exception.code, "rollback_failed")
        self.assertNotIn("restoreProven", ctx.exception.evidence)

    def test_missing_receipt_rolls_back(self) -> None:
        plan = self.engine.plan("custom-openai")
        self.runtime.receipts_enabled = False
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=True)
        self.assertEqual(ctx.exception.code, "missing_receipt")
        self.assertEqual(self._active_bundle(), self.stock_digest)
        self.assertEqual(self.runtime.load_state()["activeProfile"], "official")
        self.assertFalse((self.layout.receipts_dir / "current.json").exists())

    def test_rollback_does_not_silently_switch_to_official(self) -> None:
        first = self.engine.apply(self.engine.plan("custom-openai"), apply=True)
        self.assertEqual(first.requested_profile, "custom-openai")
        plan = self.engine.plan("other-profile")
        self.runtime.supervisor.fail_next_wait = 1
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=True)
        self.assertEqual(ctx.exception.code, "restart_failed")
        self.assertEqual(ctx.exception.evidence.get("previousProfile"), "custom-openai")
        self.assertEqual(self.runtime.load_state()["activeProfile"], "custom-openai")
        self.assertEqual(self._active_bundle(), self.patched_digest)
        config = json.loads(self.layout.config_path.read_text(encoding="utf-8"))
        self.assertEqual(config["profileId"], "custom-openai")
        self.assertNotEqual(self.runtime.load_state()["activeProfile"], "official")

    def test_pid_ownership_is_required_before_stop(self) -> None:
        self.runtime.processes.cmdlines[9999] = "/usr/bin/sshd"
        atomic_write_text(self.layout.hop_pid_path, "9999\n")
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(self.engine.plan("official"), apply=True)
        self.assertEqual(ctx.exception.code, "pid_ownership")
        self.assertNotIn(9999, self.runtime.processes.killed)
        self.assertEqual(self.runtime.read_hop_pid(), 9999)
        self.assertEqual(self.runtime.processes.cmdline_of(9999), "/usr/bin/sshd")
        self.assertEqual(self._active_bundle(), self.stock_digest)

    def test_switching_does_not_delete_stored_operator_secrets(self) -> None:
        self.engine.apply(self.engine.plan("custom-openai"), apply=True)
        self.assertTrue(self._secret_exists("profile/custom-openai"))
        self.assertTrue(self._secret_exists("profile/other-profile"))
        self.engine.apply(self.engine.plan("official"), apply=True)
        self.assertTrue(self._secret_exists("profile/custom-openai"))
        self.assertTrue(self._secret_exists("profile/other-profile"))
        leftover = list(self.layout.secrets_dir.rglob("*"))
        names = [str(path.relative_to(self.layout.secrets_dir)) for path in leftover if path.is_file()]
        self.assertEqual(sorted(names), ["profile/custom-openai", "profile/other-profile"])

    def test_invalid_secret_permissions_do_not_apply(self) -> None:
        self.engine.apply(self.engine.plan("custom-openai"), apply=True)
        other = self.runtime.secret_path("profile/other-profile")
        os.chmod(other, 0o644)
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("other-profile")
        self.assertEqual(ctx.exception.code, "invalid_secret")
        self.assertEqual(self.runtime.load_state()["activeProfile"], "custom-openai")

    def test_atomic_write_does_not_follow_predictable_tmp_symlink(self) -> None:
        target = self.root / "atomic-target"
        target.write_bytes(b"old-bytes")
        canary = self.root / "atomic-canary"
        canary.write_bytes(b"canary-secret")
        predictable = self.root / "atomic-target.tmp"
        predictable.symlink_to(canary)
        atomic_write_bytes(target, b"new-bytes")
        self.assertEqual(target.read_bytes(), b"new-bytes")
        self.assertEqual(canary.read_bytes(), b"canary-secret")
        self.assertTrue(predictable.is_symlink())

    def test_atomic_write_failed_replace_leaves_previous_target(self) -> None:
        target = self.root / "atomic-fail-target"
        target.write_bytes(b"previous")
        canary = self.root / "atomic-fail-canary"
        canary.write_bytes(b"untouched")
        predictable = self.root / "atomic-fail-target.tmp"
        predictable.symlink_to(canary)
        original = os.replace

        def boom(_src, _dst):
            raise OSError("injected replace failure")

        os.replace = boom
        try:
            with self.assertRaises(OSError):
                atomic_write_bytes(target, b"should-not-land")
        finally:
            os.replace = original
        self.assertEqual(target.read_bytes(), b"previous")
        self.assertEqual(canary.read_bytes(), b"untouched")
        self.assertTrue(predictable.is_symlink())
        leftovers = list(self.root.glob(".atomic-fail-target.*.tmp"))
        self.assertEqual(leftovers, [])

    def test_restore_failure_raises_rollback_failed(self) -> None:
        plan = self.engine.plan("custom-openai")
        self.runtime.fail_restore = True
        self.runtime.processes.fail_hop_start = True
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=True)
        self.assertEqual(ctx.exception.code, "rollback_failed")
        self.assertEqual(ctx.exception.evidence.get("cause"), "hop_start_failed")
        self.assertFalse(ctx.exception.evidence.get("restoreProven"))

    def test_same_root_secret_symlink_is_rejected(self) -> None:
        path = self.runtime.secret_path("profile/custom-openai")
        other = self.runtime.secret_path("profile/other-profile")
        path.unlink()
        path.symlink_to(other)
        with self.assertRaises(SwitchError) as ctx:
            self.engine.plan("custom-openai")
        self.assertEqual(ctx.exception.code, "invalid_secret")

    def test_unsafe_secret_in_tree_fails_snapshot(self) -> None:
        junk = self.layout.secrets_dir / "junk-link"
        junk.symlink_to(self.runtime.secret_path("profile/other-profile"))
        plan = self.engine.plan("custom-openai")
        with self.assertRaises(SwitchError) as ctx:
            self.engine.apply(plan, apply=True)
        self.assertEqual(ctx.exception.code, "invalid_secret")
        self.assertEqual(self._active_bundle(), self.stock_digest)
        self.assertEqual(self.runtime.load_state()["activeProfile"], "official")

    def test_catalog_rejects_key_id_mismatch(self) -> None:
        with self.assertRaises(SwitchError) as ctx:
            ProfileCatalog.from_mapping({"wrong-key": load_profile("profile-custom-openai.json")})
        self.assertEqual(ctx.exception.code, "invalid_profile")

    def _host_config(self, plan) -> dict:
        return {key: value for key, value in plan.host_config}

    def _hop_config(self, plan) -> dict:
        return {key: value for key, value in plan.hop_config}

    def _probe_compiled_host_config(self, host_config: dict, *, executor_max_tokens=None, stream: bool = True) -> dict:
        node = shutil.which("node")
        if node is None:
            raise unittest.SkipTest("node is not available")
        payload = {
            "hostConfig": host_config,
            "executorMaxTokens": executor_max_tokens,
            "stream": stream,
        }
        completed = subprocess.run(
            [node, str(ROOT / "tests" / "provider_parameters_boundary_probe.cjs")],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=30,
        )
        if completed.returncode != 0:
            raise AssertionError(
                "parameter boundary probe failed:\n" + completed.stdout + completed.stderr
            )
        return json.loads(completed.stdout)

    def _anthropic_profile(self, **overrides: object) -> dict:
        payload = load_profile("profile-custom-openai.json")
        payload["id"] = "claude-gateway"
        payload["displayName"] = "Claude Gateway"
        payload["protocol"] = "anthropic-messages"
        payload["endpointPath"] = "/messages"
        payload["auth"] = {"type": "x-api-key", "secretRef": "profile/claude-gateway"}
        payload["parameters"] = {"maxTokens": 4096}
        payload.update(overrides)
        return payload

    def test_plan_preserves_profile_parameters_and_host_deadline_timeout(self) -> None:
        plan = self.engine.plan("custom-openai")
        host_config = self._host_config(plan)
        hop_config = self._hop_config(plan)
        self.assertEqual(host_config["parameters"], {"maxTokens": 8192, "reasoningEffort": "high"})
        self.assertEqual(hop_config["timeoutSec"], 120)
        self.assertEqual(hop_config["timeoutSec"], HOST_HOP_TIMEOUT_SEC)
        self.assertEqual(HOST_HOP_TIMEOUT_SEC, 120)
        receipt = self.engine.apply(plan, apply=True)
        self.assertEqual(receipt.requested_profile, "custom-openai")
        written = json.loads(self.layout.config_path.read_text(encoding="utf-8"))
        self.assertEqual(written["parameters"], {"maxTokens": 8192, "reasoningEffort": "high"})
        self.assertNotIn("apiKey", written)
        self.assertNotIn("authorization", written)

    def test_profile_parameters_cross_compiled_host_config_and_adapter(self) -> None:
        plan = self.engine.plan("custom-openai")
        host_config = self._host_config(plan)
        probed = self._probe_compiled_host_config(host_config)
        self.assertEqual(probed["parsed"]["parameters"], {"maxTokens": 8192, "reasoningEffort": "high"})
        self.assertEqual(probed["adapterBody"]["max_tokens"], 8192)
        self.assertEqual(probed["adapterBody"]["reasoning_effort"], "high")
        self.assertEqual(probed["fetchBody"]["max_tokens"], 8192)
        self.assertEqual(probed["fetchBody"]["reasoning_effort"], "high")
        overridden = self._probe_compiled_host_config(host_config, executor_max_tokens=32)
        self.assertEqual(overridden["adapterBody"]["max_tokens"], 32)
        self.assertEqual(overridden["adapterBody"]["reasoning_effort"], "high")
        self.assertEqual(overridden["fetchBody"]["max_tokens"], 32)
        self.assertEqual(overridden["fetchBody"]["reasoning_effort"], "high")
        written_receipt = self.engine.apply(plan, apply=True)
        self.assertEqual(written_receipt.requested_profile, "custom-openai")
        written = json.loads(self.layout.config_path.read_text(encoding="utf-8"))
        after_apply = self._probe_compiled_host_config(written, executor_max_tokens=64)
        self.assertEqual(after_apply["fetchBody"]["max_tokens"], 64)
        self.assertEqual(after_apply["fetchBody"]["reasoning_effort"], "high")

    def test_anthropic_reasoning_effort_fails_closed_at_preflight(self) -> None:
        bad = self._anthropic_profile(parameters={"reasoningEffort": "high", "maxTokens": 4096})
        self._write_secret("profile/claude-gateway", "sk-ant-fixture-aaaaaaaa")
        with self.assertRaises(SwitchError) as ctx:
            ProfileCatalog.from_mapping(
                {
                    "custom-openai": load_profile("profile-custom-openai.json"),
                    "other-profile": load_profile("profile-other.json"),
                    "claude-gateway": bad,
                }
            )
        self.assertEqual(ctx.exception.code, "invalid_profile")
        self.assertIn("reasoningEffort", str(ctx.exception))
        self.assertNotIn("sk-ant-fixture-aaaaaaaa", str(ctx.exception))

    def test_anthropic_profile_forwards_max_tokens_without_reasoning_effort(self) -> None:
        profile = self._anthropic_profile()
        self._write_secret("profile/claude-gateway", "sk-ant-fixture-aaaaaaaa")
        catalog = ProfileCatalog.from_mapping(
            {
                "custom-openai": load_profile("profile-custom-openai.json"),
                "other-profile": load_profile("profile-other.json"),
                "claude-gateway": profile,
            }
        )
        engine = SwitchEngine(self.runtime, catalog, self.artifacts)
        plan = engine.plan("claude-gateway")
        host_config = self._host_config(plan)
        self.assertEqual(host_config["parameters"], {"maxTokens": 4096})
        self.assertNotIn("reasoningEffort", host_config["parameters"])
        hop_config = self._hop_config(plan)
        self.assertEqual(hop_config["timeoutSec"], 120)
        probed = self._probe_compiled_host_config(host_config, stream=False)
        self.assertEqual(probed["adapterBody"]["max_tokens"], 4096)
        self.assertNotIn("reasoning_effort", probed["adapterBody"])

    def test_catalog_isolates_nested_caller_mutation(self) -> None:
        payload = load_profile("profile-custom-openai.json")
        catalog = ProfileCatalog.from_mapping(
            {
                "custom-openai": payload,
                "other-profile": load_profile("profile-other.json"),
            }
        )
        payload["id"] = "mutated"
        payload["auth"]["type"] = "none"
        got = catalog.get("custom-openai")
        got["id"] = "changed"
        got["auth"]["type"] = "none"
        again = catalog.get("custom-openai")
        self.assertEqual(again["id"], "custom-openai")
        self.assertEqual(again["auth"]["type"], "bearer")


if __name__ == "__main__":
    unittest.main()
