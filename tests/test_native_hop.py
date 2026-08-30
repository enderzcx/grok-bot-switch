"""Injected process ownership and local-only hop health tests. No worker spawn."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from grokctl.profiles import atomic_replace, ensure_private_dir
from ops.native_hop import HopManager, NativeHopError
from ops import native_hop_worker


class NativeHopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = ensure_private_dir(Path(self.temp.name) / "generation")
        self.manager = HopManager(Path(__file__).resolve().parents[1])
        self.config = {"schemaVersion": 1, "generation": 1, "profileDigest": "a" * 64,
                       "profileId": "fake", "protocol": "openai-chat", "model": "fixture-model",
                       "authType": "none", "resolvedEndpoint": "https://example.com/v1/chat/completions",
                       "endpointPath": "/v1/chat/completions", "headers": {}, "listenHost": "127.0.0.1", "listenPort": 0,
                       "receiptFile": str(self.directory / "provider-receipts.jsonl")}
        self.pid, self.ticks, self.port = 12345, 54321, 18080
        self.child = Mock(pid=self.pid)
        self.child.poll.return_value = None
        listener = patch("ops.native_hop.owns_listener", return_value=True)
        self.listener = listener.start()
        self.addCleanup(listener.stop)

    def tearDown(self):
        self.temp.cleanup()

    def identity(self, pid):
        self.assertEqual(pid, self.pid)
        return self.ticks, self.manager._argv(self.directory / "hop.json")

    def fake_spawn(self, argv, **kwargs):
        self.spawn_args = argv, kwargs
        raw = Path(argv[-1]).read_bytes()
        atomic_replace(self.directory / "hop-ready.json", json.dumps({"pid": self.pid, "port": self.port,
                       "startedTicks": self.ticks, "configDigest": hashlib.sha256(raw).hexdigest()}).encode())
        return self.child

    def start(self):
        with patch("ops.native_hop.sys.platform", "linux"), patch("ops.native_hop.subprocess.Popen", side_effect=self.fake_spawn), patch("ops.native_hop.process_identity", side_effect=self.identity), patch("ops.provider_hop._host_resolver", lambda _: ["1.1.1.1"]):
            return self.manager.start(self.config, self.directory)

    def expected_health(self):
        return {"ok": True, "service": "grokctl-provider-hop", "profileId": "fake",
                "protocol": "openai-chat", "model": "fixture-model", "authType": "none",
                "resolvedEndpoint": self.config["resolvedEndpoint"], "credentialLoaded": False,
                "listenHost": "127.0.0.1", "listenPort": self.port}

    def response(self, body=None):
        response = Mock(status=200)
        response.geturl.return_value = f"http://127.0.0.1:{self.port}/healthz"
        response.read.return_value = json.dumps(self.expected_health() if body is None else body).encode()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        return response

    def test_start_publishes_owned_handle_and_strips_environment(self):
        with patch.dict(os.environ, {"NATIVE_AUTH_TOKEN": "must-not-inherit"}):
            handle = self.start()
        self.assertEqual(handle["pid"], self.pid)
        self.assertEqual(handle["startedTicks"], self.ticks)
        self.assertEqual(handle["port"], self.port)
        argv, options = self.spawn_args
        self.assertEqual(argv, self.manager._argv(handle["configPath"]))
        self.assertTrue(options["start_new_session"])
        self.assertNotIn("NATIVE_AUTH_TOKEN", options["env"])
        for name in ("hop.json", "hop-ready.json", "hop.log"):
            self.assertEqual((self.directory / name).stat().st_mode & 0o777, 0o600)
        saved = json.loads(Path(handle["configPath"]).read_bytes())
        self.assertEqual(saved["listenPort"], 0)

    def test_health_is_bound_to_owned_pid_and_verified_config(self):
        handle = self.start()
        payload = {**self.expected_health(), "token": "do-not-export"}
        with patch("ops.native_hop.process_identity", side_effect=self.identity), patch("urllib.request.OpenerDirector.open", return_value=self.response(payload)) as opened:
            health = self.manager.health(handle)
        self.assertEqual(health["generation"], 1)
        self.assertEqual(health["profileDigest"], self.config["profileDigest"])
        self.assertNotIn("token", health)
        self.assertEqual(opened.call_args.kwargs["timeout"], 2)

    def test_stale_pid_or_foreign_cmdline_cannot_probe_or_kill(self):
        handle = self.start()
        for identity in ((self.ticks + 1, self.identity(self.pid)[1]), (self.ticks, ["native-host"])):
            with patch("ops.native_hop.process_identity", return_value=identity), patch("urllib.request.OpenerDirector.open") as opened, patch("ops.native_hop.os.kill") as kill:
                with self.assertRaises(NativeHopError):
                    self.manager.health(handle)
                stopped = self.manager.stop(handle)
                self.assertTrue(stopped["stopped"] or stopped["reason"] == "ownership-mismatch")
                opened.assert_not_called()
                kill.assert_not_called()

    def test_modified_config_or_foreign_readiness_port_prevents_probe(self):
        handle = self.start()
        with patch("ops.native_hop.process_identity", side_effect=self.identity), patch("urllib.request.OpenerDirector.open") as opened:
            with self.assertRaises(NativeHopError):
                self.manager.health({**handle, "port": self.port + 1})
            atomic_replace(Path(handle["configPath"]), b"{}")
            with self.assertRaises(NativeHopError):
                self.manager.health(handle)
            opened.assert_not_called()

    def test_wrong_health_contract_redirect_and_oversize_fail_closed(self):
        handle = self.start()
        bad = self.response({**self.expected_health(), "model": "foreign-model"})
        redirect = self.response()
        redirect.status = 302
        oversized = self.response()
        oversized.read.return_value = b" " * 65537
        for response in (bad, redirect, oversized):
            with patch("ops.native_hop.process_identity", side_effect=self.identity), patch("urllib.request.OpenerDirector.open", return_value=response):
                with self.assertRaises(NativeHopError) as error:
                    self.manager.health(handle)
                self.assertEqual(str(error.exception), "unhealthy")

    def test_stop_only_terms_owned_worker_and_reports_pending(self):
        handle = self.start()
        with patch("ops.native_hop.process_identity", side_effect=self.identity), patch("ops.native_hop.os.pidfd_open", return_value=999, create=True), patch("ops.native_hop.signal.pidfd_send_signal", create=True) as send, patch("ops.native_hop.os.close"), patch("ops.native_hop.time.monotonic", side_effect=[0, 3]):
            result = self.manager.stop(handle)
        self.assertEqual(result["reason"], "cleanup-pending")
        send.assert_called_once_with(999, __import__("signal").SIGTERM)

    def test_existing_canonical_config_is_reused_without_rewrite(self):
        from grokctl.models import canonical_dumps
        path = self.directory / "hop.json"
        raw = canonical_dumps(self.config).encode()
        atomic_replace(path, raw)
        before = path.stat().st_mtime_ns
        handle = self.start()
        self.assertEqual(path.stat().st_mtime_ns, before)
        self.assertEqual(handle["configDigest"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(handle["configPath"], str(path))

    def test_listener_socket_must_belong_to_child(self):
        handle = self.start()
        self.listener.return_value = False
        with patch("ops.native_hop.process_identity", side_effect=self.identity), patch("urllib.request.OpenerDirector.open") as opened:
            with self.assertRaises(NativeHopError):
                self.manager.health(handle)
            opened.assert_not_called()

    def test_start_failure_does_not_echo_sensitive_exception(self):
        with patch("ops.native_hop.sys.platform", "linux"), patch("ops.native_hop.subprocess.Popen", side_effect=RuntimeError("native-secret")), patch("ops.provider_hop._host_resolver", lambda _: ["1.1.1.1"]):
            with self.assertRaises(NativeHopError) as error:
                self.manager.start(self.config, self.directory)
        self.assertNotIn("native-secret", str(error.exception))

    def test_child_exit_rejects_ready_file_and_never_kills_foreign_pid(self):
        self.child.poll.return_value = 1
        with patch("ops.native_hop.sys.platform", "linux"), patch("ops.native_hop.subprocess.Popen", side_effect=self.fake_spawn), patch("ops.native_hop.process_identity", side_effect=self.identity), patch("ops.native_hop.os.kill") as kill, patch("ops.provider_hop._host_resolver", lambda _: ["1.1.1.1"]):
            with self.assertRaises(NativeHopError):
                self.manager.start(self.config, self.directory)
        # An already reaped child must not be signalled after PID reuse.
        self.assertFalse(kill.called)

    def test_worker_uses_existing_runtime_and_emits_private_readiness(self):
        config_path = self.directory / "hop.json"
        atomic_replace(config_path, json.dumps({**self.config, "listenHost": "127.0.0.1", "listenPort": 0}).encode())
        server = Mock(server_address=("127.0.0.1", self.port))
        with patch("ops.native_hop_worker.load_runtime") as load, patch("ops.native_hop_worker.bind_server", return_value=server), patch("ops.native_hop_worker.process_identity", return_value=(self.ticks, [])):
            self.assertEqual(native_hop_worker.main(["--config", str(config_path)]), 0)
        load.assert_called_once_with(config_path)
        server.serve_forever.assert_called_once()
        record = json.loads((self.directory / "hop-ready.json").read_bytes())
        self.assertEqual(record["startedTicks"], self.ticks)
        self.assertEqual(record["port"], self.port)


if __name__ == "__main__":
    unittest.main()
