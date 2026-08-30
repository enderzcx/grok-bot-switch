#!/usr/bin/env python3
"""Credential-free tests for inactive provider profile editing."""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from grokctl.cli import main  # noqa: E402
from grokctl.models import ConflictError, NotFoundError, ValidationError, sha256_hex  # noqa: E402
from grokctl.profiles import ProfileRegistry  # noqa: E402
from grokctl.remote import sha256_file  # noqa: E402
from grokctl.service import GrokctlService  # noqa: E402
from grokctl.ui import start_panel  # noqa: E402


FIXTURES = ROOT / "tests" / "fixtures" / "switching"
HOST_FIXTURE = ROOT / "tests" / "fixtures" / "host-roots" / "local-root" / "host-main.cjs"
SECRET_MARKER = "local-test-credential-aaaaaaaa"
SECRET_A = "sk-custom-openai-fixture"
SECRET_B = "sk-other-profile-fixture"
PUBLIC_BASE = "https://1.1.1.1/v1"
WEB_ROOT = ROOT / "grokctl" / "web"


def sample_profile(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "id": "custom-openai",
        "displayName": "Custom OpenAI",
        "protocol": "openai-chat",
        "baseUrl": "https://api.example.com/v1",
        "model": "model-name",
        "auth": {"type": "bearer"},
        "headers": {"x-trace": "keep-me"},
        "parameters": {"reasoningEffort": "high", "maxTokens": 8192},
        "fallbackPolicy": "never",
        "enabled": True,
    }
    payload.update(overrides)
    return payload


def load_fixture_profile(name: str, **overrides: object) -> dict[str, object]:
    payload = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    payload["baseUrl"] = PUBLIC_BASE
    payload.update(overrides)
    return payload


class _Bytes:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._offset = 0

    def read(self, size: int = -1) -> bytes:
        if self._offset >= len(self._data):
            return b""
        if size is None or size < 0:
            size = len(self._data) - self._offset
        chunk = self._data[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk


class IsolatedHomeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "grokctl-home"
        self.home.mkdir()
        os.chmod(self.home, 0o700)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def registry(self) -> ProfileRegistry:
        return ProfileRegistry(self.home)

    def service(self) -> GrokctlService:
        return GrokctlService(self.home)


class RegistryEditTests(IsolatedHomeTest):
    def test_typed_profile_still_validates_before_save(self) -> None:
        registry = self.registry()
        original = registry.add(sample_profile())
        before = registry.path.read_bytes()
        with self.assertRaises(ValidationError):
            registry.update(original.id, replace(original, model=""))
        self.assertEqual(registry.path.read_bytes(), before)

    def test_update_replaces_nonsecret_fields(self) -> None:
        registry = self.registry()
        registry.add(sample_profile())
        updated = registry.update(
            "custom-openai",
            sample_profile(displayName="Renamed", model="other-model"),
        )
        self.assertEqual(updated.id, "custom-openai")
        self.assertEqual(updated.display_name, "Renamed")
        self.assertEqual(updated.model, "other-model")
        self.assertEqual(dict(updated.headers), {"x-trace": "keep-me"})
        self.assertEqual(updated.parameters["reasoningEffort"], "high")

    def test_official_and_id_are_immutable(self) -> None:
        registry = self.registry()
        registry.add(sample_profile())
        with self.assertRaises(ConflictError) as official:
            registry.update("official", sample_profile(id="official", displayName="官方 Grok"))
        self.assertIn("官方", str(official.exception))
        with self.assertRaises(ConflictError) as changed:
            registry.update("custom-openai", sample_profile(id="other-id"))
        self.assertIn("编号", str(changed.exception))
        self.assertEqual(registry.get("custom-openai").id, "custom-openai")

    def test_missing_profile_and_failed_update_leave_store(self) -> None:
        registry = self.registry()
        registry.add(sample_profile())
        before = registry.path.read_bytes()
        with self.assertRaises(NotFoundError):
            registry.update("missing", sample_profile(id="missing"))
        with self.assertRaises(ConflictError):
            registry.update("custom-openai", sample_profile(id="other-id"))
        with self.assertRaises(ValidationError):
            registry.update("custom-openai", sample_profile(displayName="bad\nid"))
        self.assertEqual(registry.path.read_bytes(), before)
        self.assertEqual(list(self.home.glob(".profiles.*")), [])


class ServiceEditTests(IsolatedHomeTest):
    def test_unsafe_existing_secret_still_blocks_auth_type_change(self) -> None:
        service = self.service()
        service.add_provider(sample_profile())
        service.set_secret("custom-openai", _Bytes(SECRET_MARKER.encode("ascii")))
        os.chmod(service.secrets.path_for("custom-openai"), 0o644)
        with self.assertRaises(ConflictError):
            service.update_provider("custom-openai", sample_profile(auth={"type": "none"}))
        self.assertEqual(service.show_provider("custom-openai")["authType"], "bearer")

    def test_update_preserves_secret_fingerprint_headers_and_parameters(self) -> None:
        service = self.service()
        service.add_provider(sample_profile(enabled=False))
        secret = SECRET_MARKER.encode("ascii")
        service.set_secret("custom-openai", _Bytes(secret))
        path = service.secrets.path_for("custom-openai")
        before_bytes = path.read_bytes()
        before = service.show_provider("custom-openai")
        fingerprint = before["secret"]["fingerprintPrefix"]
        updated = service.update_provider(
            "custom-openai",
            sample_profile(displayName="Renamed OpenAI", model="model-b", enabled=False),
        )
        self.assertEqual(updated["id"], "custom-openai")
        self.assertEqual(updated["displayName"], "Renamed OpenAI")
        self.assertEqual(updated["model"], "model-b")
        self.assertEqual(updated["headers"]["x-trace"], "keep-me")
        self.assertEqual(updated["parameters"]["maxTokens"], 8192)
        self.assertFalse(updated["enabled"])
        self.assertTrue(updated["secret"]["installed"])
        self.assertEqual(updated["secret"]["fingerprintPrefix"], fingerprint)
        self.assertEqual(path.read_bytes(), before_bytes)
        blob = json.dumps(updated)
        self.assertNotIn(SECRET_MARKER, blob)
        events = service.activity()["events"]
        self.assertIn("provider.updated", [item["type"] for item in events])
        self.assertNotIn(SECRET_MARKER, json.dumps(events))

    def test_auth_type_change_requires_secret_removal(self) -> None:
        service = self.service()
        service.add_provider(sample_profile())
        secret = SECRET_MARKER.encode("ascii")
        service.set_secret("custom-openai", _Bytes(secret))
        before = service.show_provider("custom-openai")
        with self.assertRaises(ConflictError) as raised:
            service.update_provider("custom-openai", sample_profile(auth={"type": "x-api-key"}))
        self.assertIn("密钥", str(raised.exception))
        shown = service.show_provider("custom-openai")
        self.assertEqual(shown["authType"], "bearer")
        self.assertEqual(shown["secret"]["fingerprintPrefix"], before["secret"]["fingerprintPrefix"])
        self.assertTrue(shown["secret"]["installed"])
        service.remove_secret("custom-openai")
        changed = service.update_provider("custom-openai", sample_profile(auth={"type": "x-api-key"}))
        self.assertEqual(changed["authType"], "x-api-key")
        self.assertFalse(changed["secret"]["installed"])

    def test_official_id_and_missing_are_rejected(self) -> None:
        service = self.service()
        service.add_provider(sample_profile())
        with self.assertRaises(ConflictError) as official:
            service.update_provider("official", sample_profile(id="official"))
        self.assertIn("官方", str(official.exception))
        with self.assertRaises(ConflictError):
            service.update_provider("custom-openai", sample_profile(id="other-id"))
        with self.assertRaises(NotFoundError):
            service.update_provider("missing", sample_profile(id="missing"))
        self.assertEqual(service.show_provider("custom-openai")["displayName"], "Custom OpenAI")

    def test_referenced_runtime_profiles_are_blocked(self) -> None:
        service = self.service()
        service.add_provider(sample_profile())
        replacement = sample_profile(displayName="Should Not Save")
        with patch.object(service, "_host", return_value=(object(), object())):
            with patch("grokctl.service.referenced_profile_ids", return_value={"custom-openai"}):
                with self.assertRaises(ConflictError) as raised:
                    service.update_provider("custom-openai", replacement)
        self.assertIn("新建", str(raised.exception))
        self.assertEqual(service.show_provider("custom-openai")["displayName"], "Custom OpenAI")

    def test_same_auth_type_keeps_installed_secret(self) -> None:
        service = self.service()
        service.add_provider(sample_profile())
        service.set_secret("custom-openai", _Bytes(SECRET_MARKER.encode("ascii")))
        updated = service.update_provider(
            "custom-openai",
            sample_profile(baseUrl="https://api.example.com/v2"),
        )
        self.assertEqual(updated["baseUrl"], "https://api.example.com/v2")
        self.assertEqual(updated["authType"], "bearer")
        self.assertTrue(updated["secret"]["installed"])


class CliRun:
    def __init__(self, code: int, stdout: str, stderr: str) -> None:
        self.code = code
        self.stdout = stdout
        self.stderr = stderr

    def json(self) -> object:
        return json.loads(self.stdout)


class CliEditTests(IsolatedHomeTest):
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

    def test_cli_update_file_and_protections(self) -> None:
        added = self.run_cli(["providers", "add", "--file", str(self.write_profile())], json_mode=True)
        self.assertEqual(added.code, 0)
        secret = self.run_cli(
            ["secret", "set", "custom-openai", "--stdin"],
            stdin=SECRET_MARKER.encode("ascii"),
            json_mode=True,
        )
        self.assertEqual(secret.code, 0)
        fingerprint = secret.json()["secret"]["fingerprintPrefix"]
        updated = self.run_cli(
            ["providers", "update", "custom-openai", "--file", str(self.write_profile(displayName="CLI Renamed"))],
            json_mode=True,
        )
        self.assertEqual(updated.code, 0, updated.stdout + updated.stderr)
        payload = updated.json()
        self.assertEqual(payload["displayName"], "CLI Renamed")
        self.assertEqual(payload["headers"]["x-trace"], "keep-me")
        self.assertEqual(payload["parameters"]["reasoningEffort"], "high")
        self.assertEqual(payload["secret"]["fingerprintPrefix"], fingerprint)
        self.assertNotIn(SECRET_MARKER, updated.stdout)
        human = self.run_cli(["providers", "update", "custom-openai", "--file", str(self.write_profile(model="cli-model"))])
        self.assertEqual(human.code, 0)
        self.assertIn("已更新提供方 custom-openai", human.stdout)
        self.assertIn("cli-model", human.stdout)
        official = self.run_cli(["providers", "update", "official", "--file", str(self.write_profile(id="official"))])
        self.assertNotEqual(official.code, 0)
        self.assertIn("官方", official.stderr)
        mismatched = self.run_cli(
            ["providers", "update", "custom-openai", "--file", str(self.write_profile(id="other-id"))]
        )
        self.assertNotEqual(mismatched.code, 0)
        self.assertIn("编号", mismatched.stderr)
        shown = self.run_cli(["providers", "show", "custom-openai"], json_mode=True).json()
        self.assertEqual(shown["id"], "custom-openai")
        self.assertEqual(shown["secret"]["fingerprintPrefix"], fingerprint)


class UiApiEditTests(IsolatedHomeTest):
    def setUp(self) -> None:
        super().setUp()
        self.svc = self.service()
        self.panel = start_panel(self.svc)
        self._wait_ready()

    def tearDown(self) -> None:
        self.panel.stop()
        super().tearDown()

    def _wait_ready(self) -> None:
        deadline = time.time() + 2
        last: Exception | None = None
        while time.time() < deadline:
            try:
                self.request("GET", "/api/status", csrf=False, origin=False)
                return
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                last = exc
                time.sleep(0.02)
        self.fail(f"panel did not start: {last}")

    def request(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
        *,
        csrf: bool = True,
        origin: bool | str = True,
        extra_headers: Mapping[str, str] | None = None,
        raw: bytes | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        url = self.panel.url + path
        headers = {"Accept": "application/json"}
        if origin is True:
            headers["Origin"] = self.panel.url
        elif isinstance(origin, str):
            headers["Origin"] = origin
        if csrf and method not in {"GET", "HEAD"}:
            headers["X-CSRF-Token"] = self.panel.csrf_token
        if extra_headers:
            headers.update(extra_headers)
        data = raw
        if data is None and method == "POST":
            data = json.dumps({} if body is None else dict(body)).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return int(resp.status), dict(resp.headers), resp.read()
        except urllib.error.HTTPError as exc:
            return int(exc.code), dict(exc.headers), exc.read()

    def json(
        self,
        method: str,
        path: str,
        body: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> tuple[int, Any]:
        status, _headers, raw = self.request(method, path, body, **kwargs)
        text = raw.decode("utf-8")
        self.assertNotIn(SECRET_MARKER, text)
        return status, json.loads(text) if text else None

    def test_api_update_preserves_secret_and_unexposed_fields(self) -> None:
        add_status, added = self.json("POST", "/api/providers", sample_profile(enabled=False))
        self.assertEqual(add_status, 200)
        self.assertEqual(added["id"], "custom-openai")
        set_status, installed = self.json(
            "POST",
            "/api/providers/custom-openai/secret",
            {"secret": SECRET_MARKER},
        )
        self.assertEqual(set_status, 200)
        fingerprint = installed["secret"]["fingerprintPrefix"]
        denied, denied_body = self.json(
            "POST",
            "/api/providers/custom-openai/update",
            sample_profile(displayName="No CSRF"),
            csrf=False,
        )
        self.assertEqual(denied, 403)
        self.assertEqual(denied_body["error"]["code"], "forbidden")
        status, updated = self.json(
            "POST",
            "/api/providers/custom-openai/update",
            sample_profile(displayName="Panel Renamed", model="panel-model", enabled=False),
        )
        self.assertEqual(status, 200)
        self.assertEqual(updated["displayName"], "Panel Renamed")
        self.assertEqual(updated["model"], "panel-model")
        self.assertEqual(updated["headers"]["x-trace"], "keep-me")
        self.assertEqual(updated["parameters"]["reasoningEffort"], "high")
        self.assertFalse(updated["enabled"])
        self.assertEqual(updated["secret"]["fingerprintPrefix"], fingerprint)
        self.assertNotIn(SECRET_MARKER, json.dumps(updated))
        official, official_body = self.json(
            "POST",
            "/api/providers/official/update",
            sample_profile(id="official"),
        )
        self.assertEqual(official, 409)
        self.assertIn("官方", official_body["error"]["message"])
        auth, auth_body = self.json(
            "POST",
            "/api/providers/custom-openai/update",
            sample_profile(auth={"type": "none"}, enabled=False),
        )
        self.assertEqual(auth, 409)
        self.assertIn("密钥", auth_body["error"]["message"])
        shown_status, shown = self.json("GET", "/api/providers/custom-openai", csrf=False, origin=False)
        self.assertEqual(shown_status, 200)
        self.assertEqual(shown["authType"], "bearer")
        self.assertEqual(shown["secret"]["fingerprintPrefix"], fingerprint)

    def test_static_ui_reuses_add_dialog_for_edit(self) -> None:
        html_status, _headers, html_raw = self.request("GET", "/", csrf=False, origin=False)
        self.assertEqual(html_status, 200)
        html = html_raw.decode("utf-8")
        self.assertIn('id="root"', html)
        self.assertIn('name="csrf-token"', html)
        self.assertNotIn(SECRET_MARKER, html)
        js_status, _js_headers, js_raw = self.request("GET", "/app.js", csrf=False, origin=False)
        self.assertEqual(js_status, 200)
        js = js_raw.decode("utf-8")
        self.assertIn("/update", js)
        self.assertIn("编辑供应商", js)
        self.assertIn("readOnly", js)
        self.assertNotIn(SECRET_MARKER, js)
        self.assertNotIn(self.panel.csrf_token, js)


class StaticContractTests(unittest.TestCase):
    def test_web_files_hide_secret_and_preserve_unexposed_fields(self) -> None:
        html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")
        js = (WEB_ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="root"', html)
        self.assertIn("编辑供应商", js)
        self.assertIn("/api/providers/", js)
        # Behavioral form/secret/preservation assertions now run against React,
        # not source substrings of the retired vanilla-JS implementation.
        self.assertTrue((ROOT / 'frontend/src/ui.test.tsx').is_file())
        self.assertNotIn("BeefAPI", html)
        self.assertNotIn("BeefAPI", js)


class WiredRefEditTests(unittest.TestCase):
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
        self.service = GrokctlService(self.home)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _configure(self) -> None:
        self.service.configure_host(
            {
                "schemaVersion": 1,
                "mode": "lab-local-root",
                "hostRoot": str(self.host_root),
                "stockBundle": str(self.stock),
                "patchedBundle": str(self.patched),
                "knownStockDigests": [self.stock_digest],
                "knownPatchedDigests": [self.patched_digest],
                "allowSyntheticApply": True,
            }
        )

    def _add_and_key(self, name: str, secret: str) -> None:
        self.service.add_provider(load_fixture_profile(name))
        profile_id = load_fixture_profile(name)["id"]
        self.service.set_secret(profile_id, io.BytesIO(secret.encode("ascii")))

    def test_current_and_previous_profiles_cannot_be_edited(self) -> None:
        self._configure()
        self._add_and_key("profile-custom-openai.json", SECRET_A)
        self._add_and_key("profile-other.json", SECRET_B)
        self.service.add_provider(
            load_fixture_profile(
                "profile-other.json",
                id="unrelated-profile",
                displayName="Unrelated",
                auth={"type": "bearer"},
            )
        )
        self.service.set_secret("unrelated-profile", io.BytesIO(b"sk-unrelated-profile-key"))
        self.service.use("custom-openai", apply=True)
        with self.assertRaises(ConflictError):
            self.service.update_provider(
                "custom-openai",
                load_fixture_profile("profile-custom-openai.json", displayName="Active Rename"),
            )
        self.service.use("other-profile", apply=True)
        with self.assertRaises(ConflictError):
            self.service.update_provider(
                "other-profile",
                load_fixture_profile("profile-other.json", displayName="Current Rename"),
            )
        with self.assertRaises(ConflictError):
            self.service.update_provider(
                "custom-openai",
                load_fixture_profile("profile-custom-openai.json", displayName="Previous Rename"),
            )
        renamed = self.service.update_provider(
            "unrelated-profile",
            load_fixture_profile(
                "profile-other.json",
                id="unrelated-profile",
                displayName="Unrelated Edited",
                auth={"type": "bearer"},
            ),
        )
        self.assertEqual(renamed["displayName"], "Unrelated Edited")
        self.assertTrue(renamed["secret"]["installed"])
        listed = self.service.list_providers()
        names = {item["id"]: item["displayName"] for item in listed["providers"]}
        self.assertEqual(names["custom-openai"], "Custom OpenAI")
        self.assertEqual(names["other-profile"], "Other Provider")
        self.assertEqual(names["unrelated-profile"], "Unrelated Edited")
        self.assertNotIn(SECRET_A, json.dumps(listed))
        self.assertNotIn(SECRET_B, json.dumps(listed))


if __name__ == "__main__":
    unittest.main()
