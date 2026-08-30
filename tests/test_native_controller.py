"""No native processes or network: synthetic proc, HTTP and supervisor files."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.request
import uuid

from ops import native_controller as nc
from ops import native_hop


class Response:
    def __init__(self, body, url="http://127.0.0.1:18880/health", status=200):
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.url, self.status = url, status
        self.limits = []

    def read(self, limit):
        self.limits.append(limit)
        return self.body[:limit]

    def geturl(self):
        return self.url

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class Opener:
    def __init__(self):
        self.response = Response({"isBusy": False, "token": "HEALTH_SECRET"})
        self.calls = []
        self.on_open = None

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        if self.on_open:
            self.on_open()
        return self.response


class NativeControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.host = self.base / "sand-host" / "host-main.cjs"
        self.host.parent.mkdir()
        self.host.write_bytes(b"synthetic host")
        (self.host.parent / "version").write_text("v0.28.0\n")
        self.gateway = self.base / "gateway.json"
        self.supervisor = self.base / "supervisor"
        (self.supervisor / "acks").mkdir(parents=True)
        self.proc = self.base / "proc"
        self.source = self.base / "supervisor.mjs"
        self.source.write_bytes(b"synthetic pinned supervisor")
        self.pin = patch.object(nc, "SUPERVISOR_SHA256", hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.pin.start()
        self.addCleanup(self.pin.stop)
        self.opener = Opener()
        self.native = nc.NativeHost(root=self.base / "project", host_entry=self.host,
            gateway_path=self.gateway, supervisor_dir=self.supervisor, opener=self.opener,
            proc_root=self.proc, supervisor_source=self.source, listener_owner=self.owns_listener)
        self.request_id = "gbs-" + str(uuid.uuid4())
        self.set_gateway()
        self.status(None, None)

    def set_gateway(self, pid=123, started=100, **extra):
        self.gateway.write_text(json.dumps({"port": 18880, "pid": pid, "startedAt": started,
            "token": "GATEWAY_SECRET", "extra": "PRIVATE_BODY", **extra}))
        proc = self.proc / str(pid)
        proc.mkdir(parents=True, exist_ok=True)
        (proc / "cmdline").write_bytes(b"/usr/bin/node\0" + str(self.host).encode() + b"\0")
        (proc / "fd").mkdir(exist_ok=True)
        (proc / "net").mkdir(exist_ok=True)
        socket_fd = proc / "fd" / "5"
        if socket_fd.is_symlink():
            socket_fd.unlink()
        socket_fd.symlink_to(f"socket:[{pid}001]")
        (proc / "net" / "tcp").write_text(f"0: 0100007F:49C0 00000000:0000 0A 0:0 0:0 0 1000 0 {pid}001\n")

    def owns_listener(self, pid, port):
        # Exercise the actual shared parser against a synthetic proc tree.
        with patch.object(native_hop, "Path", side_effect=lambda value: self.proc if str(value) == "/proc" else Path(value)):
            return native_hop.owns_listener(pid, port)

    def status(self, id, kind):
        (self.supervisor / "status.json").write_text(json.dumps({"lastCommandId": id,
            "lastCommandKind": kind, "rawToken": "STATUS_SECRET"}))

    def finish(self, pid=124, started=200):
        self.native.command_path.unlink()
        self.status(self.request_id, "restart")
        (self.supervisor / "acks" / self.request_id).write_text("123456789")
        self.set_gateway(pid, started)

    def test_observation_allowlist_and_local_unauthenticated_health(self):
        got = self.native.read_observation()
        self.assertEqual(set(got), {"pid", "startedAt", "hostBundleSha256", "hostVersion", "isBusy",
                                   "pendingCommand", "supervisorLastCommand", "health"})
        self.assertEqual(got["pid"], 123)
        self.assertEqual(got["startedAt"], 100)
        self.assertEqual(got["hostVersion"], "v0.28.0")
        self.assertEqual(got["hostBundleSha256"], hashlib.sha256(b"synthetic host").hexdigest())
        self.assertIs(got["health"], True)
        self.assertIs(got["isBusy"], False)
        self.assertNotIn("SECRET", json.dumps(got))
        self.assertNotIn("PRIVATE_BODY", json.dumps(got))
        request, timeout = self.opener.calls[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:18880/health")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.header_items(), [])
        self.assertEqual(timeout, 2)
        self.assertEqual(self.opener.response.limits, [nc.MAX_READ + 1])

    def test_default_transport_disables_proxies_and_redirects(self):
        with patch.object(nc.urllib.request, "build_opener", return_value=self.opener) as build:
            nc.NativeHost()
        proxy, redirect = build.call_args.args
        self.assertIsInstance(proxy, urllib.request.ProxyHandler)
        self.assertEqual(proxy.proxies, {})
        self.assertIsNone(redirect.redirect_request(None, None, 302, "", {}, "https://example.invalid"))

    def test_busy_missing_nonboolean_or_unhealthy_blocks_restart(self):
        expected = self.native.read_observation()
        for body in ({"isBusy": True}, {}, {"isBusy": 0}, {"isBusy": "false"}, {"isBusy": None}, [], b"not json", b"x" * (nc.MAX_READ + 1)):
            self.opener.response = Response(body)
            with self.subTest(body=str(body)[:40]), self.assertRaisesRegex(nc.NativeControllerError, "host-not-healthy-idle"):
                self.native.issue_restart(self.request_id, expected)
        for response in (Response({"isBusy": False}, status=302), Response({"isBusy": False}, url="http://elsewhere/health")):
            self.opener.response = response
            self.assertFalse(self.native.read_observation()["health"])
        self.assertFalse(self.native.command_path.exists())

    def test_gateway_validation_and_exact_cmdline(self):
        for updates in ({"pid": True}, {"pid": 0}, {"port": 0}, {"port": "18880"}, {"port": 65536},
                        {"startedAt": 0}, {"startedAt": -1}, {"startedAt": float("nan")}, {"startedAt": float("inf")}, {"startedAt": True}):
            raw = {"pid": 123, "port": 18880, "startedAt": 100, **updates}
            self.gateway.write_text(json.dumps(raw))
            with self.subTest(updates=updates):
                self.assertFalse(self.native.read_observation()["health"])
        self.set_gateway()
        (self.proc / "123" / "cmdline").write_bytes(b"node\0prefix-" + str(self.host).encode() + b"-suffix\0")
        self.assertFalse(self.native.read_observation()["health"])
        self.gateway.write_bytes(b"x" * (nc.MAX_READ + 1))
        self.assertFalse(self.native.read_observation()["health"])

    def test_gateway_change_during_health_is_not_healthy(self):
        self.opener.on_open = lambda: self.set_gateway(124, 200)
        self.assertFalse(self.native.read_observation()["health"])

    def test_health_listener_requires_matching_pid_socket_inode_port_and_state(self):
        tcp = self.proc / "123" / "net" / "tcp"
        original = tcp.read_text()
        for line in (original.replace("123001", "999999"), original.replace("49C0", "49C1"),
                     original.replace("0100007F", "00000000"), original.replace(" 0A ", " 01 ")):
            with self.subTest(line=line):
                tcp.write_text(line)
                self.opener.calls.clear()
                self.assertFalse(self.native.read_observation()["health"])
                self.assertEqual(self.opener.calls, [])
        tcp.write_text(original)
        self.assertTrue(self.native.read_observation()["health"])
        self.opener.on_open = lambda: (self.proc / "123" / "fd" / "5").unlink()
        self.assertFalse(self.native.read_observation()["health"], "ownership loss during HTTP must invalidate its body")

    def test_health_requires_a_real_busy_boolean_even_for_receipts(self):
        old = self.native.read_observation()
        self.native.issue_restart(self.request_id, old)
        self.finish()
        for value in ({}, {"isBusy": None}, {"isBusy": 0}, {"isBusy": "false"}):
            self.opener.response = Response(value)
            self.assertFalse(self.native.read_observation()["health"])
            self.assertFalse(self.native.restart_receipt(self.request_id, old)["verified"])

    def test_pending_and_last_command_are_sanitized_to_two_fields(self):
        self.native.command_path.write_text(json.dumps({"id": "foreign", "kind": "upgrade",
            "forceNow": True, "reason": "PRIVATE_SECRET", "token": "COMMAND_SECRET"}))
        self.status("previous", "ping")
        got = self.native.read_observation()
        self.assertEqual(got["pendingCommand"], {"id": "foreign", "kind": "upgrade"})
        self.assertEqual(got["supervisorLastCommand"], {"id": "previous", "kind": "ping"})
        self.assertNotIn("SECRET", json.dumps(got))

    def test_restart_command_exact_exclusive_and_only_supervisor_consumes(self):
        old = self.native.read_observation()
        got = self.native.issue_restart(self.request_id, old)
        command = json.loads(self.native.command_path.read_text())
        self.assertEqual(set(command), {"id", "kind", "issuedAtMs", "reason"})
        self.assertEqual(command["id"], self.request_id)
        self.assertEqual(command["kind"], "restart")
        self.assertEqual(command["reason"], "grok-bot-switch")
        self.assertGreater(command["issuedAtMs"], 0)
        self.assertEqual(got["status"], "pending")
        pending = self.native.restart_receipt(self.request_id, old)
        self.assertFalse(pending["verified"])
        self.assertEqual(pending["status"], "pending")
        self.assertTrue(self.native.command_path.exists())
        self.assertFalse(list(self.supervisor.glob(".gbs-command-*")))
        self.finish()
        done = self.native.restart_receipt(self.request_id, old)
        self.assertTrue(done["verified"])
        self.assertEqual(done["status"], "consumed")

    def test_hash_pin_and_observation_fences(self):
        old = self.native.read_observation()
        self.source.write_bytes(b"unknown supervisor")
        with self.assertRaisesRegex(nc.NativeControllerError, "supervisor-source-mismatch"):
            self.native.issue_restart(self.request_id, old)
        self.source.write_bytes(b"synthetic pinned supervisor")
        for key, value in (("pid", 999), ("startedAt", 999), ("hostBundleSha256", "0" * 64)):
            with self.subTest(key=key), self.assertRaisesRegex(nc.NativeControllerError, "host-observation-changed"):
                self.native.issue_restart(self.request_id, {**old, key: value})
        self.assertFalse(self.native.command_path.exists())

    def test_foreign_command_malformed_or_symlink_never_overwritten(self):
        old = self.native.read_observation()
        for content in (b"malformed", b'{"id":"foreign","kind":"upgrade","token":"SECRET"}'):
            self.native.command_path.write_bytes(content)
            with self.assertRaisesRegex(nc.NativeControllerError, "supervisor-command-pending"):
                self.native.issue_restart(self.request_id, old)
            self.assertEqual(self.native.command_path.read_bytes(), content)
        self.native.command_path.unlink()
        self.native.command_path.symlink_to(self.base / "missing")
        with self.assertRaises(nc.NativeControllerError):
            self.native.issue_restart(self.request_id, old)
        self.assertTrue(self.native.command_path.is_symlink())

    def test_command_publish_race_preserves_foreign_file(self):
        old = self.native.read_observation()
        real_link = nc.os.link
        def race(source, target, **kwargs):
            self.native.command_path.write_bytes(b"FOREIGN_WINNER")
            return real_link(source, target, **kwargs)
        with patch.object(nc.os, "link", side_effect=race), self.assertRaisesRegex(nc.NativeControllerError, "supervisor-command-pending"):
            self.native.issue_restart(self.request_id, old)
        self.assertEqual(self.native.command_path.read_bytes(), b"FOREIGN_WINNER")
        self.assertFalse(list(self.supervisor.glob(".gbs-command-*")))

    def test_receipt_requires_matching_ack_kind_and_new_pid_and_start(self):
        old = self.native.read_observation()
        self.native.issue_restart(self.request_id, old)
        self.finish()
        for pid, started in ((123, 200), (124, 100), (124, 90)):
            self.set_gateway(pid, started)
            self.assertFalse(self.native.restart_receipt(self.request_id, old)["verified"])
        self.set_gateway(124, 200)
        for id, kind in (("foreign", "restart"), (self.request_id, "upgrade")):
            self.status(id, kind)
            self.assertFalse(self.native.restart_receipt(self.request_id, old)["verified"])
        self.status(self.request_id, "restart")
        ack = self.supervisor / "acks" / self.request_id
        for value in ("", "NaN", "0", "SECRET"):
            ack.write_text(value)
            self.assertFalse(self.native.restart_receipt(self.request_id, old)["verified"])
        ack.unlink()
        ack.with_suffix(".json").write_text("123456789")
        self.assertFalse(self.native.restart_receipt(self.request_id, old)["verified"])

    def test_receipt_is_read_only_and_rejects_unhealthy_or_changed_bundle(self):
        old = self.native.read_observation()
        self.native.issue_restart(self.request_id, old)
        self.finish()
        def files():
            return {str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob("*") if p.is_file()}
        before = files()
        self.assertTrue(self.native.restart_receipt(self.request_id, old)["verified"])
        self.assertEqual(files(), before)
        self.opener.response = Response({}, status=503)
        self.assertFalse(self.native.restart_receipt(self.request_id, old)["verified"])
        self.opener.response = Response({"isBusy": False})
        self.host.write_bytes(b"competing bundle mutation")
        self.assertFalse(self.native.restart_receipt(self.request_id, old)["verified"])

    def test_receipt_exposes_only_validated_ack_timestamp_even_before_health(self):
        old = self.native.read_observation()
        self.assertIsNone(self.native.restart_receipt(self.request_id, old)["acknowledgedAtMs"])
        self.native.issue_restart(self.request_id, old)
        self.finish()
        self.opener.response = Response({}, status=503)
        receipt = self.native.restart_receipt(self.request_id, old)
        self.assertEqual(receipt["acknowledgedAtMs"], 123456789)
        self.assertFalse(receipt["verified"])
        ack = self.supervisor / "acks" / self.request_id
        for value in ("", "NaN", "Infinity", "0", "-1", "PRIVATE_SECRET"):
            ack.write_text(value)
            result = self.native.restart_receipt(self.request_id, old)
            self.assertIsNone(result["acknowledgedAtMs"])
            self.assertTrue(result["acknowledgementPresent"])
            self.assertNotIn("PRIVATE_SECRET", json.dumps(result))
    def test_failed_publish_reports_fixed_error_and_removes_only_own_temp(self):
        old = self.native.read_observation()
        unrelated = self.supervisor / "unrelated"
        unrelated.write_bytes(b"KEEP")
        with patch.object(nc.os, "link", side_effect=OSError("PRIVATE_SECRET")):
            with self.assertRaisesRegex(nc.NativeControllerError, "^command-publish-failed$"):
                self.native.issue_restart(self.request_id, old)
        self.assertFalse(self.native.command_path.exists())
        self.assertFalse(list(self.supervisor.glob(".gbs-command-*")))
        self.assertEqual(unrelated.read_bytes(), b"KEEP")

    def test_error_publication_proof_distinguishes_preflight_staging_and_link(self):
        old = self.native.read_observation()
        self.opener.response = Response({"isBusy": True})
        with self.assertRaises(nc.NativeControllerError) as caught:
            self.native.issue_restart(self.request_id, old)
        self.assertEqual(caught.exception.publication, "unpublished")
        self.opener.response = Response({"isBusy": False})
        with patch.object(nc.tempfile, "mkstemp", side_effect=OSError("PRIVATE_SECRET")):
            with self.assertRaises(nc.NativeControllerError) as caught:
                self.native.issue_restart(self.request_id, old)
        self.assertEqual(caught.exception.publication, "unpublished")
        real_link = nc.os.link
        def publish_then_error(*args, **kwargs):
            real_link(*args, **kwargs)
            raise OSError("uncertain remote filesystem result")
        with patch.object(nc.os, "link", side_effect=publish_then_error):
            with self.assertRaises(nc.NativeControllerError) as caught:
                self.native.issue_restart(self.request_id, old)
        self.assertEqual(caught.exception.publication, "uncertain")
        self.assertEqual(json.loads(self.native.command_path.read_text())["id"], self.request_id)

    def test_id_validation_reuse_and_errors_do_not_leak(self):
        old = self.native.read_observation()
        for id in ("upgrade-123", "gbs-../../secret", "gbs-not-a-uuid", "SECRET", None):
            with self.subTest(id=id), self.assertRaisesRegex(nc.NativeControllerError, "^invalid-request-id$"):
                self.native.issue_restart(id, old)
        (self.supervisor / "acks" / self.request_id).write_text("1")
        with self.assertRaisesRegex(nc.NativeControllerError, "request-id-already-used"):
            self.native.issue_restart(self.request_id, old)
        with patch.object(self.opener, "open", side_effect=RuntimeError("TOKEN_SECRET")):
            with self.assertRaisesRegex(nc.NativeControllerError, "^host-not-healthy-idle$"):
                self.native.issue_restart("gbs-" + str(uuid.uuid4()), old)


if __name__ == "__main__":
    unittest.main()
