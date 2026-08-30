import hashlib
import io
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from desktop.build_independent_bundle import build, installation_prompt
from grokctl.independent_service import IndependentService
from grokctl.models import GrokctlError
from grokctl.ui import ProviderPanel
from ops.independent import install, InstallError, private_dir
from ops import independent
from grokctl.profiles import atomic_replace
from ops.native_controller import NativeControllerError

REPO = Path(__file__).resolve().parents[1]


class IndependentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.service = IndependentService(self.root / "state")
        self.state = {"ok": True, "activeProfile": "official", "desiredProfile": "official",
                      "profileDigest": None, "blocking": [], "previousProfile": None,
                      "observation": {"health": True}, "providerSwitchReady": True}

    def tearDown(self):
        self.temp.cleanup()

    def test_status_uses_only_local_inspect_and_no_pairing_or_client_discovery(self):
        with patch("ops.native_runner.dispatch", return_value=self.state) as dispatch, \
             patch("grokctl.installation.discover_installation", side_effect=AssertionError("desktop")), \
             patch("grokctl.client_bridge.call", side_effect=AssertionError("bridge")):
            result = self.service.status()
        dispatch.assert_called_once_with({"action": "inspect"})
        self.assertEqual(result["connectionMode"], "independent")
        self.assertEqual(result["client"]["transport"], "cloud-local")
        self.assertEqual(result["activeProfile"], "official")
        self.assertNotIn("pairing", result)

    def test_unavailable_cloud_does_not_prevent_panel_or_config_management(self):
        with patch("ops.native_runner.dispatch", side_effect=RuntimeError("SECRET")):
            result = self.service.status()
        self.assertFalse(result["client"]["hostReachable"])
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(len(self.service.list_providers()["providers"]), 1)

    def test_unknown_version_error_does_not_leak_detail_or_fallback(self):
        with patch("ops.native_runner.dispatch", side_effect=NativeControllerError("unknown-host-bundle")) as dispatch:
            with self.assertRaises(GrokctlError) as caught:
                self.service.connect_native()
        self.assertEqual(caught.exception.code, "unknown-host-bundle")
        dispatch.assert_called_once_with({"action": "setup"})

    def test_pairing_and_arbitrary_actions_are_not_available(self):
        for function in (lambda: self.service.pairing_start("https://example.com"),
                         self.service.pairing_revoke, lambda: self.service._native()._call("exec")):
            with self.assertRaises(GrokctlError):
                function()

    def test_health_is_readonly_and_matches_instance(self):
        import http.client
        self.service.panel_instance_id = "test-instance"
        with patch("ops.native_runner.dispatch", side_effect=AssertionError("host mutation")), ProviderPanel(self.service) as panel:
            conn = http.client.HTTPConnection("127.0.0.1", panel.port)
            conn.request("GET", "/api/health")
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"ok": True, "mode": "independent", "instanceId": "test-instance"})
            conn.close()

    def test_external_begin_and_official_use_same_transactions_no_bridge(self):
        profile = {"schemaVersion": 1, "id": "custom", "displayName": "Custom", "mode": "external",
                   "protocol": "openai-chat", "baseUrl": "https://api.example.com/v1", "model": "test",
                   "auth": {"type": "bearer"}, "headers": {}, "parameters": {}, "fallbackPolicy": "never", "enabled": True}
        calls = []
        def dispatch(request):
            calls.append(request)
            if request["action"] == "inspect":
                return self.state
            if request["action"] == "plan":
                return {"status": "planned", "target": request["profile"]["id"], "verified": False}
            if request["action"] == "begin":
                return {"status": "pending", "target": request["profile"]["id"], "verified": False}
            return {"status": "verified", "target": "official", "verified": True}
        with patch("ops.native_runner.dispatch", side_effect=dispatch):
            self.service.add_provider(profile)
            self.service.set_secret("custom", io.BytesIO(b"SYNTHETIC_TEST_KEY"))
            result = self.service.use("custom", apply=True)
            self.assertEqual(result["status"], "pending")
            begins = [r for r in calls if r["action"] == "begin"]
            self.assertEqual(begins[0]["secret"], "SYNTHETIC_TEST_KEY")
            self.assertNotIn("SYNTHETIC_TEST_KEY", json.dumps(result))
            self.assertTrue(self.service.native_progress()["verified"])
            self.service.use("official", apply=True)
        begins = [r for r in calls if r["action"] == "begin"]
        self.assertEqual(begins[-1]["profile"]["id"], "official")
        self.assertNotIn("SYNTHETIC_TEST_KEY", self.service.activity_path.read_text())

    def test_bundle_is_deterministic_offline_and_contains_no_relay(self):
        first = build(REPO, self.root / "one")
        second = build(REPO, self.root / "two")
        self.assertEqual(first["sha256"], second["sha256"])
        with zipfile.ZipFile(first["archive"]) as archive:
            self.assertFalse(any("relay" in n or "client_install" in n for n in archive.namelist()))
        prompt = installation_prompt(first["sha256"])
        self.assertIn("不得执行 ZIP 内任何代码", prompt)
        self.assertIn("不要点击", prompt)
        package = install(Path(first["archive"]), first["sha256"], private_dir(self.root / "installed"))
        completed = subprocess.run([sys.executable, "-I", str(package / "ops/independent.py"), "--help"], capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode())
        zipped = subprocess.run([sys.executable, "-I", first["archive"], "--help"], capture_output=True)
        self.assertEqual(zipped.returncode, 0, zipped.stderr.decode())

    def test_install_is_idempotent_rejects_checksum_and_modified_source(self):
        bundle = build(REPO, self.root / "dist")
        root = private_dir(self.root / "install")
        archive = Path(bundle["archive"])
        with self.assertRaises(InstallError):
            install(archive, "0" * 64, root)
        target = install(archive, bundle["sha256"], root)
        self.assertEqual(install(archive, bundle["sha256"], root), target)
        self.assertEqual(target.stat().st_mode & 0o777, 0o700)
        self.assertEqual((target / "ops/independent.py").stat().st_mode & 0o777, 0o600)
        (target / "ops/independent.py").write_text("changed")
        with self.assertRaises(InstallError):
            install(archive, bundle["sha256"], root)

    def test_traversal_and_symlink_are_rejected_before_extract(self):
        for name in ("../escape", "/escape", "a/../escape", "a\\escape"):
            archive = self.root / "bad.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr(name, b"bad")
            with self.assertRaises(InstallError):
                install(archive, hashlib.sha256(archive.read_bytes()).hexdigest(), self.root)
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(InstallError):
            private_dir(link / "child")

    def test_start_revalidates_sources_before_spawning(self):
        bundle = build(REPO, self.root / "dist")
        root = private_dir(self.root / "install")
        target = install(Path(bundle["archive"]), bundle["sha256"], root)
        (target / "ops/independent.py").write_text("changed")
        with patch.object(independent.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(InstallError, "installed-source-changed"):
                independent.start(root, target, 0)
        spawn.assert_not_called()

    def test_start_rejects_changed_archive_and_unhealthy_existing_process(self):
        bundle = build(REPO, self.root / "dist")
        root = private_dir(self.root / "install")
        target = install(Path(bundle["archive"]), bundle["sha256"], root)
        with patch.object(independent, "panel_process", return_value={"package": str(target)}), \
             patch.object(independent, "running", return_value=None), \
             patch.object(independent.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(InstallError, "panel-unhealthy"):
                independent.start(root, target, 0)
        spawn.assert_not_called()
        (root / "archives" / (target.name + ".zip")).write_bytes(b"corrupt")
        with self.assertRaisesRegex(InstallError, "checksum-mismatch"):
            independent.start(root, target, 0)

    def test_stop_uses_process_exit_not_http_failure(self):
        with patch.object(independent, "panel_process", side_effect=[{"pid": 123}, None]), \
             patch.object(independent, "running", side_effect=AssertionError("HTTP is not process evidence")), \
             patch.object(independent.os, "kill") as kill:
            self.assertEqual(independent.stop(self.root), {"running": False})
        kill.assert_called_once_with(123, signal.SIGTERM)
        with patch.object(independent, "panel_process", side_effect=InstallError("panel-process-mismatch")), \
             patch.object(independent.os, "kill") as kill:
            with self.assertRaises(InstallError):
                independent.stop(self.root)
        kill.assert_not_called()

    def test_process_identity_fences_pid_reuse_and_unrelated_commands(self):
        root = private_dir(self.root / "managed")
        private_dir(root / "state")
        proc = self.root / "proc" / "123"
        proc.mkdir(parents=True)
        package = root / "versions" / ("a" * 64)
        state = {"pid": 123, "package": str(package), "port": 18994, "startedTicks": 42}
        atomic_replace(root / "state/panel.json", json.dumps(state).encode())
        (proc / "stat").write_text("123 (python test) S " + "0 " * 18 + "42 0")
        argv = [sys.executable, "-I", str(package / "ops/independent.py"), "serve", "--root", str(root), "--port", "0"]
        (proc / "cmdline").write_bytes(b"\0".join(s.encode() for s in argv) + b"\0")
        self.assertEqual(independent.panel_process(root, proc_root=proc.parent), state)
        state["startedTicks"] = 41
        atomic_replace(root / "state/panel.json", json.dumps(state).encode())
        with self.assertRaisesRegex(InstallError, "panel-process-mismatch"):
            independent.panel_process(root, proc_root=proc.parent)
        del state["startedTicks"]  # beta.1 migration remains supported.
        atomic_replace(root / "state/panel.json", json.dumps(state).encode())
        self.assertEqual(independent.panel_process(root, proc_root=proc.parent), state)
        (proc / "cmdline").write_bytes(b"unrelated\0")
        with self.assertRaisesRegex(InstallError, "panel-process-mismatch"):
            independent.panel_process(root, proc_root=proc.parent)

    @unittest.skipUnless(sys.platform == "linux", "Linux process lifecycle")
    def test_linux_unresponsive_process_is_not_reported_stopped(self):
        bundle = build(REPO, self.root / "dist")
        root = self.root / "lifecycle"
        def cli(action, *extra):
            result = subprocess.run([sys.executable, "-I", bundle["archive"], action,
                                     "--root", str(root), "--port", "0", *extra],
                                    capture_output=True, text=True, timeout=15)
            return result.returncode, json.loads(result.stdout)
        code, state = cli("install", "--sha256", bundle["sha256"])
        self.assertEqual(code, 0, state)
        pid = state["pid"]
        try:
            os.kill(pid, signal.SIGSTOP)
            code, status = cli("status")
            self.assertEqual(code, 0)
            self.assertTrue(status["running"])
            self.assertFalse(status["healthy"])
            code, failure = cli("start")
            self.assertEqual(code, 1)
            self.assertEqual(failure["error"], "panel-unhealthy-stop-before-start")
            code, failure = cli("stop")
            self.assertEqual(code, 1)
            self.assertEqual(failure["error"], "panel-stop-unconfirmed")
        finally:
            os.kill(pid, signal.SIGCONT)
            code, stopped = cli("stop")
            self.assertEqual(code, 0, stopped)
        code, state = cli("start")
        self.assertEqual(code, 0, state)
        self.assertEqual(cli("stop"), (0, {"ok": True, "mode": "independent", "hostModified": False, "running": False}))


if __name__ == "__main__":
    unittest.main()
