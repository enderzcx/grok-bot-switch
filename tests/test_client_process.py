"""Native ownership decisions with injected API data, never real processes."""
import socket
import struct
import json
import os
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

from grokctl.client_process import ReceiverError, verified_receiver, _owns_tcp_table


class ClientProcessTests(unittest.TestCase):
    def setUp(self):
        self.exe = r"C:\Apps\Grok Bot\Grok Bot.exe"
        self.api = Mock()
        self.api.open.return_value = 100
        self.api.wait.return_value = 0x102
        self.api.image.return_value = self.exe
        self.api.owns_listener.return_value = True

    def test_supported_receiver_holds_identity_and_rechecks(self):
        with patch("grokctl.client_process.sys.platform", "win32"), patch("grokctl.client_process._WindowsAPI", return_value=self.api):
            with verified_receiver(123, self.exe, 3456) as receiver:
                receiver.recheck()
        self.assertEqual(self.api.owns_listener.call_count, 2)
        self.api.owns_listener.assert_called_with(123, 3456)
        self.api.close.assert_called_once_with(100)

    def test_non_windows_never_silently_bypasses_proof(self):
        with patch("grokctl.client_process.sys.platform", "darwin"), patch("grokctl.client_process._WindowsAPI") as api:
            with self.assertRaises(ReceiverError), verified_receiver(123, self.exe, 3456):
                self.fail("unsupported platform entered")
            api.assert_not_called()

    def test_dead_unreadable_wrong_executable_and_wrong_port_owner_fail_closed(self):
        for field, value in (("open", 0), ("wait", 0), ("image", r"C:\Other\Grok Bot.exe"), ("owns_listener", False)):
            api = Mock()
            api.open.return_value = 100
            api.wait.return_value = 0x102
            api.image.return_value = self.exe
            api.owns_listener.return_value = True
            getattr(api, field).return_value = value
            with self.subTest(field=field), patch("grokctl.client_process.sys.platform", "win32"), patch("grokctl.client_process._WindowsAPI", return_value=api):
                with self.assertRaises(ReceiverError), verified_receiver(123, self.exe, 3456):
                    self.fail("unverified receiver entered")

    def test_process_exiting_after_preflight_is_rejected(self):
        self.api.wait.side_effect = [0x102, 0]
        with patch("grokctl.client_process.sys.platform", "win32"), patch("grokctl.client_process._WindowsAPI", return_value=self.api):
            with verified_receiver(123, self.exe, 3456) as receiver:
                with self.assertRaises(ReceiverError):
                    receiver.recheck()
        self.api.close.assert_called_once_with(100)

    def test_tcp_table_requires_exact_loopback_port_and_pid(self):
        def table(*rows):
            return struct.pack("<I", len(rows)) + b"".join(struct.pack("<6I", *row) for row in rows)
        good = (2, 0x0100007f, socket.htons(3456), 0, 0, 123)
        self.assertTrue(_owns_tcp_table(table(good), 123, 3456))
        self.assertFalse(_owns_tcp_table(table(good), 124, 3456))
        self.assertFalse(_owns_tcp_table(table(good), 123, 3457))
        self.assertFalse(_owns_tcp_table(table((2, 0, socket.htons(3456), 0, 0, 123)), 123, 3456))
        self.assertFalse(_owns_tcp_table(table(good, (*good[:-1], 124)), 123, 3456))
        with self.assertRaises(ReceiverError):
            _owns_tcp_table(struct.pack("<I", 1), 123, 3456)

    @unittest.skipUnless(sys.platform == "win32", "native Windows receiver validation")
    def test_real_windows_loopback_child_and_wrong_owner(self):
        script = (
            "import socket,sys,json,os; listener=socket.socket(); "
            "listener.bind(('127.0.0.1',0)); listener.listen(); "
            "print(json.dumps({'pid':os.getpid(),'port':listener.getsockname()[1]}),flush=True); "
            "sys.stdin.read(1); listener.close()"
        )
        # A Windows venv python.exe is a launcher that may create a second PID.
        # Launch the real interpreter to test the listener owner's actual image.
        executable = getattr(sys, "_base_executable", sys.executable)
        child = subprocess.Popen([executable, "-I", "-c", script], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            ready = json.loads(child.stdout.readline(1024))
            self.assertEqual(ready["pid"], child.pid)
            with verified_receiver(child.pid, executable, ready["port"]) as receiver:
                receiver.recheck()
            with self.assertRaises(ReceiverError), verified_receiver(os.getpid(), executable, ready["port"]):
                self.fail("foreign listener accepted")
            wrong_port = ready["port"] + 1 if ready["port"] < 65535 else 1
            with self.assertRaises(ReceiverError), verified_receiver(child.pid, executable, wrong_port):
                self.fail("wrong port accepted")
        finally:
            child.stdin.close()  # EOF cleanly ends only this fixture child.
            child.wait(timeout=5)
            child.stdout.close()


if __name__ == "__main__":
    unittest.main()
