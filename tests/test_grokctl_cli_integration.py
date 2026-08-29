#!/usr/bin/env python3
"""CLI integration tests for grokctl local-root host wiring."""

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

from grokctl.cli import main  # noqa: E402
from grokctl.remote import sha256_file  # noqa: E402


FIXTURES = ROOT / "tests" / "fixtures" / "switching"
HOST_FIXTURE = ROOT / "tests" / "fixtures" / "host-roots" / "local-root" / "host-main.cjs"
SECRET_A = "sk-custom-openai-fixture"
SECRET_B = "sk-other-profile-fixture"


class CliRun:
    def __init__(self, code: int, stdout: str, stderr: str) -> None:
        self.code = code
        self.stdout = stdout
        self.stderr = stderr

    def json(self) -> object:
        return json.loads(self.stdout)


class CliIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.home = self.base / "home"
        self.home.mkdir()
        os.chmod(self.home, 0o700)
        self.host_root = self.base / "host-root"
        self.host_root.mkdir()
        self.artifacts = self.base / "artifacts"
        self.artifacts.mkdir()
        self.stock = self.artifacts / "stock.cjs"
        self.patched = self.artifacts / "patched.cjs"
        shutil.copyfile(FIXTURES / "stock-bundle.cjs", self.stock)
        shutil.copyfile(FIXTURES / "patched-bundle.cjs", self.patched)
        shutil.copyfile(HOST_FIXTURE, self.host_root / "host-main.cjs")
        self.stock_digest = sha256_file(self.stock)
        self.patched_digest = sha256_file(self.patched)
        self.sentinel = self.base / "sentinel-home"
        self.sentinel.mkdir()
        self.env = {
            "GROKCTL_HOME": str(self.home),
            "HOME": str(self.sentinel),
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_cli(
        self,
        args: list[str],
        *,
        stdin: bytes | str | None = None,
        json_mode: bool = False,
    ) -> CliRun:
        argv = ["--home", str(self.home), *args]
        if json_mode:
            argv.append("--json")
        stdout = io.StringIO()
        stderr = io.StringIO()
        if stdin is None:
            stream: object = io.BytesIO(b"")
        elif isinstance(stdin, bytes):
            stream = io.BytesIO(stdin)
        else:
            stream = io.StringIO(stdin)
        code = main(argv, stdin=stream, stdout=stdout, stderr=stderr, env=self.env)
        return CliRun(code, stdout.getvalue(), stderr.getvalue())

    def configure(self) -> CliRun:
        path = self.base / "host.json"
        path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "mode": "local-root",
                    "hostRoot": str(self.host_root),
                    "stockBundle": str(self.stock),
                    "patchedBundle": str(self.patched),
                    "knownStockDigests": [self.stock_digest],
                    "knownPatchedDigests": [self.patched_digest],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return self.run_cli(["host", "configure", "--file", str(path)], json_mode=True)

    def add_profile(self, fixture: str) -> CliRun:
        src = FIXTURES / fixture
        dest = self.base / fixture
        shutil.copyfile(src, dest)
        return self.run_cli(["providers", "add", "--file", str(dest)], json_mode=True)

    def set_secret(self, profile_id: str, secret: str) -> CliRun:
        return self.run_cli(
            ["secret", "set", profile_id, "--stdin"],
            stdin=secret.encode("ascii"),
            json_mode=True,
        )

    def test_host_configure_show_and_chinese_status(self) -> None:
        configured = self.configure()
        self.assertEqual(configured.code, 0)
        self.assertEqual(configured.json()["mode"], "local-root")
        shown = self.run_cli(["host", "show"])
        self.assertEqual(shown.code, 0)
        self.assertIn("本机根目录", shown.stdout)
        self.assertIn("local-root", shown.stdout)
        self.assertNotIn(SECRET_A, shown.stdout)
        json_show = self.run_cli(["host", "show"], json_mode=True).json()
        self.assertEqual(json_show["hostRoot"], str(self.host_root))
        status = self.run_cli(["status"])
        self.assertIn("状态", status.stdout)
        self.assertNotIn("未接入", status.stdout)
        self.assertIn("official", status.stdout)
        self.assertFalse((self.sentinel / ".grokctl").exists())
        self.assertEqual(stat.S_IMODE((self.home / "host.json").stat().st_mode), 0o600)

    def test_cli_round_trip_and_rollback(self) -> None:
        self.assertEqual(self.configure().code, 0)
        self.assertEqual(self.add_profile("profile-custom-openai.json").code, 0)
        self.assertEqual(self.add_profile("profile-other.json").code, 0)
        self.assertEqual(self.set_secret("custom-openai", SECRET_A).code, 0)
        self.assertEqual(self.set_secret("other-profile", SECRET_B).code, 0)

        plan = self.run_cli(["plan", "custom-openai"])
        self.assertEqual(plan.code, 0)
        self.assertIn("不会改主机", plan.stdout)
        self.assertIn("POST https://api.example.com/v1/chat/completions", plan.stdout)
        self.assertIn("openai-chat", plan.stdout)
        self.assertIn("model-name", plan.stdout)
        self.assertIn("never", plan.stdout)
        self.assertNotIn(SECRET_A, plan.stdout)

        applied = self.run_cli(["use", "custom-openai", "--apply"], json_mode=True)
        self.assertEqual(applied.code, 0, applied.stderr)
        payload = applied.json()
        self.assertTrue(payload["apply"])
        self.assertEqual(payload["target"], "custom-openai")
        self.assertNotIn(SECRET_A, applied.stdout)

        human_use = self.run_cli(["use", "other-profile", "--apply"])
        self.assertEqual(human_use.code, 0, human_use.stderr)
        self.assertIn("已应用", human_use.stdout)
        self.assertIn("POST https://api.example.com/v1/chat/completions", human_use.stdout)
        self.assertIn("other-model", human_use.stdout)

        status = self.run_cli(["status"], json_mode=True).json()
        self.assertEqual(status["desiredProfile"], "other-profile")
        self.assertEqual(status["observedProfile"], "other-profile")
        self.assertEqual(status["activeProfile"], "other-profile")
        self.assertFalse(status["drift"])
        self.assertNotIn(SECRET_A, json.dumps(status))
        self.assertNotIn(SECRET_B, json.dumps(status))

        rollback_plan = self.run_cli(["rollback"])
        self.assertIn("custom-openai", rollback_plan.stdout)
        self.assertIn("不会改主机", rollback_plan.stdout)
        rolled = self.run_cli(["rollback", "--apply"], json_mode=True)
        self.assertEqual(rolled.code, 0, rolled.stderr)
        self.assertEqual(rolled.json()["target"], "custom-openai")

        official = self.run_cli(["use", "official", "--apply"], json_mode=True)
        self.assertEqual(official.code, 0, official.stderr)
        after = self.run_cli(["status"], json_mode=True).json()
        self.assertEqual(after["desiredProfile"], "official")
        self.assertEqual(after["observedProfile"], "official")
        self.assertEqual(after["host"]["hopHealth"], "stopped")

        live = self.run_cli(["verify", "--live"], json_mode=True)
        self.assertEqual(live.code, 3)
        self.assertEqual(live.json()["error"]["code"], "not-wired")
        self.assertFalse((self.sentinel / ".grokctl").exists())

    def test_cli_busy_lock_and_unknown_hash(self) -> None:
        self.assertEqual(self.configure().code, 0)
        self.assertEqual(self.add_profile("profile-custom-openai.json").code, 0)
        self.assertEqual(self.set_secret("custom-openai", SECRET_A).code, 0)
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
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            line = holder.stdout.readline() if holder.stdout is not None else ""
            self.assertEqual(line.strip(), "held")
            busy = self.run_cli(["use", "custom-openai", "--apply"], json_mode=True)
            self.assertEqual(busy.code, 2)
            self.assertEqual(busy.json()["error"]["code"], "busy")
            self.assertIn("忙", busy.json()["error"]["message"])
            self.assertNotIn(SECRET_A, busy.stdout)
        finally:
            holder.terminate()
            holder.wait(timeout=5)
            if holder.stdout is not None:
                holder.stdout.close()
            if holder.stderr is not None:
                holder.stderr.close()

        (self.host_root / "host-main.cjs").write_text("UNKNOWN_BUNDLE\n", encoding="utf-8")
        blocked = self.run_cli(["use", "custom-openai", "--apply"], json_mode=True)
        self.assertNotEqual(blocked.code, 0)
        self.assertNotIn(SECRET_A, blocked.stdout)
        self.assertNotIn(SECRET_A, blocked.stderr)


if __name__ == "__main__":
    unittest.main()
