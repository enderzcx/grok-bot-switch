"""Native orchestration tests with fake host/hop boundaries, never real processes."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from grokctl.models import official_profile
from ops import native_activation as na


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def profile(name="first", auth="bearer"):
    return {"schemaVersion": 1, "id": name, "displayName": name, "mode": "external",
            "protocol": "openai-chat", "baseUrl": "https://provider.example/v1", "model": "test-model",
            "auth": {"type": auth, **({"secretRef": "profile/" + name} if auth != "none" else {})},
            "fallbackPolicy": "never", "enabled": True}


class FakeHost:
    def __init__(self, entry, command):
        self.host_entry, self.command = entry, command
        self.pid, self.started, self.busy, self.healthy = 111, 100, False, True
        self.last, self.acked = None, set()
        self.issued = []
        self.after_issue_error = False

    def read_observation(self):
        pending = json.loads(self.command.read_text()) if self.command.exists() else None
        return {"pid": self.pid, "startedAt": self.started, "hostBundleSha256": digest(self.host_entry),
                "hostVersion": "synthetic", "isBusy": self.busy, "pendingCommand": pending,
                "supervisorLastCommand": self.last, "health": self.healthy}

    def issue_restart(self, id, expected):
        current = self.read_observation()
        assert current["health"] is True and current["isBusy"] is False and current["pendingCommand"] is None
        for key in ("pid", "startedAt", "hostBundleSha256"):
            assert current[key] == expected[key]
        self.command.write_text(json.dumps({"id": id, "kind": "restart"}))
        self.issued.append(id)
        if self.after_issue_error:
            raise RuntimeError("PRIVATE_EXCEPTION_SECRET")

    def consume(self):
        self.last = json.loads(self.command.read_text())
        self.acked.add(self.last["id"])
        self.command.unlink()
        self.pid += 1
        self.started += 100

    def restart_receipt(self, id, previous):
        observed = self.read_observation()
        ok = (not self.command.exists() and id in self.acked and self.last == {"id": id, "kind": "restart"}
              and self.pid != previous["pid"] and self.started > previous["startedAt"] and self.healthy
              and observed["hostBundleSha256"] == previous["hostBundleSha256"])
        return {"verified": ok, "observation": observed}


class FakeHops:
    def __init__(self):
        self.started, self.stopped = [], []
        self.healthy = True
        self.on_start = None
        self.force_port = None
        self.stop_result = {"stopped": True, "reason": None}

    def start(self, config, directory):
        handle = {"pid": 900 + len(self.started), "port": self.force_port or 19001 + len(self.started),
                  "generation": config["generation"], "profileDigest": config["profileDigest"],
                  "configPath": str(directory / "hop.json"), "configDigest": digest(directory / "hop.json"),
                  "startedTicks": 1000 + len(self.started)}
        self.started.append(handle)
        if self.on_start:
            self.on_start(config, directory)
        return handle

    def health(self, handle):
        config = json.loads(Path(handle["configPath"]).read_text())
        return {"ok": self.healthy, "service": "grokctl-provider-hop", "listenHost": "127.0.0.1",
                "listenPort": handle["port"], "generation": handle["generation"], "profileDigest": handle["profileDigest"],
                "credentialLoaded": config["authType"] != "none",
                **{key: config[key] for key in ("profileId", "protocol", "model", "resolvedEndpoint", "authType")}}

    def stop(self, handle):
        self.stopped.append(handle)
        return self.stop_result


class NativeActivationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "project"
        self.stock, self.patched, self.entry = (self.base / name for name in ("stock.cjs", "patched.cjs", "host-main.cjs"))
        self.stock.write_bytes(b"synthetic stock")
        self.patched.write_bytes(b"synthetic patched")
        self.entry.write_bytes(self.stock.read_bytes())
        self.stock_sha, self.patched_sha = digest(self.stock), digest(self.patched)
        known = patch.object(na, "KNOWN_STOCK_SHA256", {self.stock_sha})
        known.start()
        self.addCleanup(known.stop)
        self.host = FakeHost(self.entry, self.base / "command.json")
        self.hops = FakeHops()
        self.engine = na.NativeActivation(self.root, self.host, self.stock, self.patched, self.hops,
                                         stock_sha256=self.stock_sha, patched_sha256=self.patched_sha)
        old_resolver = self.engine.hop.get_host_resolver()
        self.engine.hop.set_host_resolver(lambda hostname: ("8.8.8.8",))
        self.addCleanup(lambda: self.engine.hop.set_host_resolver(old_resolver))
        self.secret = "sk-PRIVATE_KEY_DO_NOT_LEAK"

    def tree(self):
        return {str(p.relative_to(self.base)): (p.read_bytes(), p.stat().st_mtime_ns) for p in self.base.rglob("*") if p.is_file()}

    def activate(self, raw=None):
        result = self.engine.begin(raw or profile(), secret=self.secret)
        self.assertEqual(result["status"], "pending")
        self.host.consume()
        self.assertEqual(self.engine.progress()["status"], "verified")

    def test_plan_is_read_only_and_never_active(self):
        before = self.tree()
        result = self.engine.plan(profile())
        self.assertEqual(result["status"], "planned")
        self.assertFalse(result["verified"])
        self.assertEqual(self.tree(), before)
        self.assertFalse(self.engine.active_path.exists())
        self.assertFalse(self.hops.started)

    def test_pending_progress_never_mutates_cancels_or_reissues(self):
        result = self.engine.begin(profile(), secret=self.secret)
        self.assertEqual(result["status"], "pending")
        self.assertFalse(self.engine.active_path.exists())
        self.host.busy = True  # supervisor is allowed to defer after our initial idle fence
        before = self.tree()
        for _ in range(3):
            self.assertEqual(self.engine.progress()["status"], "pending")
        self.assertEqual(self.tree(), before)
        self.assertEqual(len(self.host.issued), 1)
        self.assertEqual(self.hops.stopped, [])

    def test_busy_unknown_health_and_foreign_command_reject_before_mutation(self):
        for busy, healthy in ((True, True), (None, True), (False, False)):
            self.host.busy, self.host.healthy = busy, healthy
            with self.assertRaisesRegex(na.ActivationError, "host-not-healthy-idle"):
                self.engine.begin(profile(), secret=self.secret)
        self.host.busy, self.host.healthy = False, True
        self.host.command.write_text('{"id":"foreign","kind":"upgrade"}')
        with self.assertRaisesRegex(na.ActivationError, "supervisor-command-pending"):
            self.engine.begin(profile(), secret=self.secret)
        self.assertEqual(self.entry.read_bytes(), b"synthetic stock")
        self.assertFalse(self.hops.started)

    def test_external_to_external_to_official_keeps_old_hop_until_verified(self):
        self.activate()
        old = self.hops.started[0]
        old_directory = Path(old["configPath"]).parent
        old_config_bytes = (old_directory / "hop.json").read_bytes()
        self.engine.begin(profile("second"), secret="sk-second")
        self.assertEqual((old_directory / "secret.key").read_text(), self.secret)
        self.assertEqual((old_directory / "hop.json").read_bytes(), old_config_bytes)
        self.assertEqual(self.hops.stopped, [])
        config = json.loads(self.engine.config.read_text())
        self.assertEqual(config["baseUrl"], "http://127.0.0.1:19002")
        self.assertEqual(config["mode"], "external-only")
        self.assertIs(config["nativeFallback"], False)
        self.assertEqual(config["generation"], 2)
        self.host.consume()
        self.assertTrue(self.engine.progress()["verified"])
        self.assertEqual(self.hops.stopped, [old])
        self.engine.begin(official_profile().to_canonical_dict())
        self.assertEqual(len(self.hops.started), 2)
        self.assertEqual(self.entry.read_bytes(), b"synthetic stock")
        self.assertIs(json.loads(self.engine.config.read_text())["enabled"], False)
        self.assertEqual(len(self.hops.stopped), 1)
        self.host.consume()
        self.assertTrue(self.engine.progress()["verified"])
        self.assertEqual(len(self.hops.stopped), 2)
        active = json.loads(self.engine.active_path.read_text())
        self.assertEqual(active["target"], "official")
        self.assertIsNone(active["hop"])

    def test_snapshot_precedes_hop_start_and_all_sensitive_files_are_private(self):
        def inspect_start(config, directory):
            job = json.loads(self.engine.job_path.read_text())
            self.assertEqual(job["phase"], "starting-hop")
            self.assertEqual((directory / "original-bundle.cjs").read_bytes(), b"synthetic stock")
            self.assertEqual(self.entry.read_bytes(), b"synthetic stock")
            self.assertFalse(self.engine.config.exists())
        self.hops.on_start = inspect_start
        result = self.engine.begin(profile(), secret=self.secret)
        job = json.loads(self.engine.job_path.read_text())
        directory = Path(job["directory"])
        self.assertEqual((directory / "secret.key").read_text(), self.secret)
        for p in self.root.rglob("*"):
            self.assertEqual(p.stat().st_mode & 0o077, 0)
            if p.is_file() and p.name != "secret.key":
                self.assertNotIn(self.secret.encode(), p.read_bytes())
        self.assertNotIn(self.secret, json.dumps(result))
        self.assertEqual(self.host.command.read_text().count(self.secret), 0)

    def test_hop_failure_precommand_restores_without_native_restart(self):
        self.hops.healthy = False
        result = self.engine.begin(profile(), secret=self.secret)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["phase"], "starting-hop")
        self.assertEqual(self.entry.read_bytes(), b"synthetic stock")
        self.assertFalse(self.engine.config.exists())
        self.assertEqual(len(self.hops.stopped), 1)
        self.assertEqual(self.host.issued, [])

    def test_config_install_failure_restores_owned_bundle(self):
        real = na._replace
        def fail_config(path, data, expected, mode=0o600):
            if path == self.engine.config:
                raise OSError("PRIVATE_EXCEPTION_SECRET")
            return real(path, data, expected, mode)
        with patch.object(na, "_replace", side_effect=fail_config):
            result = self.engine.begin(profile(), secret=self.secret)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.entry.read_bytes(), b"synthetic stock")
        self.assertFalse(self.engine.config.exists())
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_uncertain_hop_start_requires_attention_without_guessing_ownership(self):
        def uncertain(config, directory):
            raise RuntimeError("PRIVATE_EXCEPTION_SECRET")
        self.hops.on_start = uncertain
        result = self.engine.begin(profile(), secret=self.secret)
        self.assertEqual(result["status"], "needs-attention")
        self.assertEqual(result["error"], "hop-start-outcome-uncertain")
        self.assertEqual(self.hops.stopped, [])
        self.assertEqual(self.entry.read_bytes(), b"synthetic stock")
        self.assertFalse(self.engine.config.exists())
        with self.assertRaisesRegex(na.ActivationError, "activation-in-progress"):
            self.engine.begin(profile("second"), secret=self.secret)

    def test_foreign_drift_after_snapshot_is_preserved(self):
        self.hops.on_start = lambda config, directory: self.entry.write_bytes(b"FOREIGN_BUNDLE")
        result = self.engine.begin(profile(), secret=self.secret)
        self.assertEqual(result["status"], "needs-attention")
        self.assertEqual(self.entry.read_bytes(), b"FOREIGN_BUNDLE")
        self.assertEqual(self.host.issued, [])
        self.assertFalse(self.engine.active_path.exists())

    def test_foreign_command_after_snapshot_is_preserved(self):
        self.hops.on_start = lambda config, directory: self.host.command.write_text('{"id":"foreign","kind":"upgrade"}')
        result = self.engine.begin(profile(), secret=self.secret)
        self.assertEqual(result["status"], "needs-attention")
        before = self.tree()
        self.assertEqual(self.engine.progress()["error"], "foreign-command-pending")
        self.assertEqual(self.tree(), before)
        self.assertEqual(self.host.issued, [])

    def test_postrestart_crash_requires_attention_without_guessed_rollback(self):
        self.engine.begin(profile(), secret=self.secret)
        self.host.consume()
        self.host.healthy = False
        before = self.tree()
        result = self.engine.progress()
        self.assertEqual(result["status"], "needs-attention")
        self.assertEqual(result["error"], "restart-not-verified")
        self.assertFalse(result["verified"])
        self.assertEqual(self.tree(), before)
        self.assertFalse(self.engine.active_path.exists())
        self.assertEqual(self.hops.stopped, [])
        self.host.pid += 1  # native supervisor recovers, not the activation controller
        self.host.started += 100
        self.host.healthy = True
        self.assertTrue(self.engine.progress()["verified"])

    def test_publication_error_never_clears_published_command(self):
        self.host.after_issue_error = True
        result = self.engine.begin(profile(), secret=self.secret)
        self.assertEqual(result["status"], "needs-attention")
        self.assertTrue(self.host.command.exists())
        before = self.tree()
        self.assertEqual(self.engine.progress()["status"], "pending")
        self.assertEqual(self.tree(), before)
        self.host.consume()
        self.assertTrue(self.engine.progress()["verified"])

    def test_mismatched_hop_health_never_commits_or_stops_old_hop(self):
        self.activate()
        self.engine.begin(profile("second"), secret=self.secret)
        self.host.consume()
        with patch.object(self.hops, "health", return_value={"ok": True, "generation": 1}):
            result = self.engine.progress()
        self.assertEqual(result["status"], "needs-attention")
        self.assertEqual(json.loads(self.engine.active_path.read_text())["target"], "first")
        self.assertEqual(self.hops.stopped, [])

    def test_old_hop_cleanup_failure_does_not_invalidate_verified_host(self):
        self.activate()
        self.engine.begin(profile("second"), secret=self.secret)
        self.host.consume()
        self.hops.stop_result = {"stopped": False, "reason": "ownership-mismatch"}
        result = self.engine.progress()
        self.assertTrue(result["verified"])
        self.assertEqual(result["error"], "old-hop-cleanup-needs-attention")
        self.assertEqual(json.loads(self.engine.active_path.read_text())["target"], "second")

    def test_unknown_hash_artifact_drift_and_invalid_endpoint_fail_closed(self):
        self.entry.write_bytes(b"UNKNOWN")
        with self.assertRaisesRegex(na.ActivationError, "unknown-host-bundle"):
            self.engine.plan(profile())
        self.entry.write_bytes(self.stock.read_bytes())
        self.patched.write_bytes(b"CHANGED_ARTIFACT")
        with self.assertRaisesRegex(na.ActivationError, "artifact-drift"):
            self.engine.plan(profile())
        self.patched.write_bytes(b"synthetic patched")
        for raw in ({**profile(), "baseUrl": "https://169.254.169.254/v1"},
                    {**profile(), "headers": {"Authorization": "Bearer PRIVATE_SECRET"}}):
            with self.assertRaisesRegex(na.ActivationError, "^invalid-profile$"):
                self.engine.plan(raw)

    def test_wrong_hop_port_and_active_config_drift_are_rejected(self):
        self.activate()
        self.hops.force_port = 19001
        result = self.engine.begin(profile("second"), secret=self.secret)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(len(self.host.issued), 1)
        self.engine.config.write_bytes(b"FOREIGN_CONFIG")
        with self.assertRaisesRegex(na.ActivationError, "active-state-drift"):
            self.engine.plan(profile("third"))

    def test_auth_none_never_creates_secret_and_official_never_starts_hop(self):
        self.engine.begin(profile(auth="none"))
        job = json.loads(self.engine.job_path.read_text())
        self.assertFalse((Path(job["directory"]) / "secret.key").exists())
        self.host.consume()
        self.assertTrue(self.engine.progress()["verified"])
        self.engine.begin(official_profile().to_canonical_dict())
        self.assertEqual(len(self.hops.started), 1)

    def test_anthropic_configuration_and_parameters_use_canonical_contract(self):
        raw = {**profile(), "protocol": "anthropic-messages", "auth": {"type": "x-api-key", "secretRef": "profile/first"},
               "parameters": {"maxTokens": 4096}, "headers": {"X-Feature": "synthetic"}}
        self.engine.begin(raw, secret=self.secret)
        job = json.loads(self.engine.job_path.read_text())
        hop = json.loads((Path(job["directory"]) / "hop.json").read_text())
        host = json.loads(self.engine.config.read_text())
        self.assertEqual(hop["anthropicVersion"], "2023-06-01")
        self.assertEqual(hop["authType"], "x-api-key")
        self.assertEqual(hop["resolvedEndpoint"], "https://provider.example/v1/messages")
        self.assertEqual(hop["endpointPath"], "/v1/messages")
        self.assertEqual(host["endpointPath"], "/v1/messages")
        self.assertEqual(host["parameters"], {"maxTokens": 4096})

    def test_after_restart_config_drift_is_preserved_and_never_committed(self):
        self.engine.begin(profile(), secret=self.secret)
        self.host.consume()
        self.engine.config.write_bytes(b"FOREIGN_CONFIG")
        before = self.tree()
        result = self.engine.progress()
        self.assertEqual(result["status"], "needs-attention")
        self.assertEqual(self.tree(), before)
        self.assertFalse(self.engine.active_path.exists())

    def test_symlink_parent_is_rejected_before_creating_outside_directory(self):
        outside = self.base / "outside"
        outside.mkdir()
        (self.base / "redirect").symlink_to(outside, target_is_directory=True)
        engine = na.NativeActivation(self.base / "redirect" / "new-project", self.host, self.stock,
            self.patched, self.hops, stock_sha256=self.stock_sha, patched_sha256=self.patched_sha)
        with self.assertRaisesRegex(na.ActivationError, "unsafe-path"):
            engine.begin(profile(), secret=self.secret)
        self.assertEqual(list(outside.iterdir()), [])

    def test_lock_excludes_another_activation_and_resume_uses_persistent_job(self):
        with self.engine._lock(), self.assertRaisesRegex(na.ActivationError, "activation-locked"):
            self.engine.begin(profile(), secret=self.secret)
        self.engine.begin(profile(), secret=self.secret)
        resumed = na.NativeActivation(self.root, self.host, self.stock, self.patched, self.hops,
            stock_sha256=self.stock_sha, patched_sha256=self.patched_sha)
        self.assertEqual(resumed.progress()["status"], "pending")
        self.host.consume()
        self.assertTrue(resumed.progress()["verified"])


if __name__ == "__main__":
    unittest.main()
