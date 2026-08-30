#!/usr/bin/env python3
"""CLI tests for grokctl using a synthetic GROKCTL_HOME."""

from __future__ import annotations

import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.request
import signal
import select
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from grokctl.cli import main  # noqa: E402


def sample_profile(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "id": "custom-openai",
        "displayName": "Custom OpenAI",
        "protocol": "openai-chat",
        "baseUrl": "https://api.example.com/v1",
        "model": "model-name",
        "auth": {"type": "bearer"},
        "headers": {},
        "parameters": {"reasoningEffort": "high", "maxTokens": 8192},
        "fallbackPolicy": "never",
        "enabled": True,
    }
    payload.update(overrides)
    return payload


class CliRun:
    def __init__(self, code: int, stdout: str, stderr: str) -> None:
        self.code = code
        self.stdout = stdout
        self.stderr = stderr

    def json(self) -> object:
        return json.loads(self.stdout)


class CliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir()
        os.chmod(self.home, 0o700)
        self.secret = b"local-test-credential-aaaaaaaa"

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
        code = main(argv, stdin=stream, stdout=stdout, stderr=stderr, env={"GROKCTL_HOME": str(self.home)})
        return CliRun(code, stdout.getvalue(), stderr.getvalue())

    def write_profile(self, name: str = "profile.json", **overrides: object) -> Path:
        path = Path(self.tmp.name) / name
        path.write_text(json.dumps(sample_profile(**overrides)), encoding="utf-8")
        return path

    def add_profile(self, **overrides: object) -> CliRun:
        path = self.write_profile(**overrides)
        return self.run_cli(["providers", "add", "--file", str(path)], json_mode=True)

    def test_status_json_and_human(self) -> None:
        human = self.run_cli(["status"])
        self.assertEqual(human.code, 0)
        self.assertIn("official", human.stdout)
        self.assertIn("未接入", human.stdout)
        self.assertNotIn("BeefAPI", human.stdout)
        data = self.run_cli(["status"], json_mode=True).json()
        self.assertEqual(data["desiredProfile"], "official")
        self.assertEqual(data["host"]["wired"], False)
        self.assertEqual(data["home"], str(self.home))

    def test_providers_list_add_show_remove(self) -> None:
        listed = self.run_cli(["providers", "list"], json_mode=True).json()
        self.assertEqual(listed["providers"][0]["id"], "official")
        added = self.add_profile()
        self.assertEqual(added.code, 0)
        self.assertEqual(added.json()["id"], "custom-openai")
        self.assertEqual(
            added.json()["resolvedEndpoint"],
            "https://api.example.com/v1/chat/completions",
        )
        shown = self.run_cli(["providers", "show", "custom-openai"], json_mode=True)
        self.assertEqual(shown.json()["model"], "model-name")
        self.assertNotIn("local-test-credential", shown.stdout)
        human_list = self.run_cli(["providers", "list"])
        self.assertIn("custom-openai", human_list.stdout)
        self.assertIn("官方 Grok", human_list.stdout)
        removed = self.run_cli(["providers", "remove", "custom-openai"], json_mode=True)
        self.assertEqual(removed.json()["removed"], True)
        after = self.run_cli(["providers", "list"], json_mode=True).json()
        self.assertEqual([item["id"] for item in after["providers"]], ["official"])

    def test_official_protected_via_cli(self) -> None:
        path = self.write_profile(id="official", displayName="官方 Grok")
        result = self.run_cli(["providers", "add", "--file", str(path)])
        self.assertNotEqual(result.code, 0)
        self.assertIn("官方", result.stderr)
        removed = self.run_cli(["providers", "remove", "official"])
        self.assertNotEqual(removed.code, 0)
        self.assertIn("官方", removed.stderr)

    def test_secret_set_stdin_json_and_no_secret_output(self) -> None:
        self.assertEqual(self.add_profile().code, 0)
        result = self.run_cli(
            ["secret", "set", "custom-openai", "--stdin"],
            stdin=self.secret,
            json_mode=True,
        )
        self.assertEqual(result.code, 0)
        payload = result.json()
        self.assertTrue(payload["secret"]["installed"])
        self.assertEqual(payload["secret"]["byteCount"], len(self.secret))
        self.assertNotIn(self.secret.decode("ascii"), result.stdout)
        self.assertNotIn(self.secret.decode("ascii"), result.stderr)
        human = self.run_cli(["providers", "show", "custom-openai"])
        self.assertIn("fingerprint=", human.stdout)
        self.assertNotIn(self.secret.decode("ascii"), human.stdout)
        removed = self.run_cli(["secret", "remove", "custom-openai"], json_mode=True)
        self.assertEqual(removed.code, 0)

    def test_secret_rejected_from_argv(self) -> None:
        self.add_profile()
        leaked = "local-test-credential-aaaaaaaa"
        result = self.run_cli(["secret", "set", "custom-openai", leaked])
        self.assertNotEqual(result.code, 0)
        self.assertNotIn(leaked, result.stdout)
        self.assertNotIn(leaked, result.stderr)
        self.assertIn("密钥", result.stderr)

    def test_invalid_profile_and_secret_field_rejected(self) -> None:
        path = self.write_profile(apiKey="should-not-leak")
        result = self.run_cli(["providers", "add", "--file", str(path)])
        self.assertNotEqual(result.code, 0)
        self.assertNotIn("should-not-leak", result.stdout)
        self.assertNotIn("should-not-leak", result.stderr)

    def test_test_plan_use_verify_rollback_activity(self) -> None:
        self.add_profile()
        tested = self.run_cli(["test", "custom-openai"], json_mode=True)
        self.assertEqual(tested.code, 0)
        self.assertFalse(tested.json()["ok"])
        live = self.run_cli(["test", "custom-openai", "--live"], json_mode=True)
        self.assertEqual(live.code, 3)
        self.assertEqual(live.json()["error"]["code"], "not-wired")
        plan = self.run_cli(["plan", "custom-openai"], json_mode=True)
        self.assertTrue(plan.json()["dryRun"])
        use = self.run_cli(["use", "custom-openai"], json_mode=True)
        self.assertTrue(use.json()["dryRun"])
        apply = self.run_cli(["use", "custom-openai", "--apply"], json_mode=True)
        self.assertEqual(apply.code, 3)
        verify = self.run_cli(["verify", "--live"], json_mode=True)
        self.assertEqual(verify.code, 3)
        rollback = self.run_cli(["rollback"], json_mode=True)
        self.assertTrue(rollback.json()["dryRun"])
        rollback_apply = self.run_cli(["rollback", "--apply"], json_mode=True)
        self.assertEqual(rollback_apply.code, 3)
        activity = self.run_cli(["activity", "--limit", "10"], json_mode=True)
        types = [item["type"] for item in activity.json()["events"]]
        self.assertIn("provider.added", types)
        blob = json.dumps(activity.json())
        self.assertNotIn(self.secret.decode("ascii"), blob)
        ui = self.run_cli(["ui", "--port", "-1"], json_mode=True)
        self.assertEqual(ui.code, 2)

    def test_json_flag_after_command(self) -> None:
        result = self.run_cli(["status", "--json"])
        self.assertEqual(result.code, 0)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["desiredProfile"], "official")

    def test_ui_cli_serves_loopback_and_stops_cleanly(self) -> None:
        process = subprocess.Popen(
            [sys.executable, "-m", "grokctl", "--home", str(self.home), "ui", "--port", "0"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], "UI did not start")
            line = process.stdout.readline()
            self.assertTrue(line.startswith("本地面板 http://127.0.0.1:"), line)
            url = line.strip().split(" ")[-1]
            with urllib.request.urlopen(url + "/api/status", timeout=5) as response:
                status = json.load(response)
            self.assertFalse(status["host"]["wired"])
            process.send_signal(signal.SIGINT)
            process.communicate(timeout=5)
            self.assertEqual(process.returncode, 0)
        finally:
            if process.poll() is None:
                process.terminate()
            process.communicate(timeout=5)

    def test_human_output_is_chinese_first(self) -> None:
        self.add_profile()
        status = self.run_cli(["status"])
        self.assertIn("状态", status.stdout)
        plan = self.run_cli(["plan", "official"])
        self.assertIn("计划", plan.stdout)
        self.assertIn("不会改主机", plan.stdout)

    def test_launcher_subprocess_uses_synthetic_home(self) -> None:
        env = os.environ.copy()
        env["GROKCTL_HOME"] = str(self.home)
        env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
        completed = subprocess.run(
            [sys.executable, str(ROOT / "grokctl.py"), "--json", "status"],
            check=False,
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload["home"], str(self.home))
        self.assertTrue((self.home / "profiles.json").exists() or payload["providers"] >= 1)

    def test_owner_only_files_from_cli(self) -> None:
        self.add_profile()
        self.run_cli(["secret", "set", "custom-openai", "--stdin"], stdin=self.secret)
        profiles = self.home / "profiles.json"
        secret = self.home / "secrets" / "profile" / "custom-openai"
        self.assertEqual(stat.S_IMODE(profiles.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.home.stat().st_mode), 0o700)

    def test_all_protocol_files_via_cli(self) -> None:
        mapping = {
            "chat-one": ("openai-chat", "/chat/completions"),
            "resp-one": ("openai-responses", "/responses"),
            "msg-one": ("anthropic-messages", "/messages"),
        }
        for profile_id, (protocol, suffix) in mapping.items():
            extra = {}
            if protocol == "anthropic-messages":
                extra["parameters"] = {"maxTokens": 128}
            result = self.add_profile(id=profile_id, protocol=protocol, displayName=profile_id, **extra)
            self.assertEqual(result.code, 0, result.stdout + result.stderr)
            self.assertTrue(result.json()["resolvedEndpoint"].endswith(suffix))


if __name__ == "__main__":
    unittest.main()
