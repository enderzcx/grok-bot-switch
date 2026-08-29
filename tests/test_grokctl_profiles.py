#!/usr/bin/env python3
"""Credential-free tests for grokctl profiles, secrets, and canonical contracts."""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from grokctl.models import (  # noqa: E402
    AuthType,
    Protocol,
    ValidationError,
    canonical_dumps,
    official_profile,
    parse_profile,
)
from grokctl.profiles import ProfileRegistry  # noqa: E402
from grokctl.secrets import SecretStore  # noqa: E402
from grokctl.service import GrokctlService  # noqa: E402


def fake_key_value() -> str:
    return "".join(("s", "k", "-")) + ("a" * 24)


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


class CanonicalContractTests(unittest.TestCase):
    def test_official_serialization_is_deterministic(self) -> None:
        first = official_profile().to_canonical_dict()
        second = official_profile().to_canonical_dict()
        self.assertEqual(canonical_dumps(first), canonical_dumps(second))
        self.assertEqual(official_profile().digest(), official_profile().digest())
        self.assertIn("\\u5b98\\u65b9 Grok", canonical_dumps(first))

    def test_external_serialization_round_trip(self) -> None:
        parsed = parse_profile(sample_profile())
        again = parse_profile(parsed.to_canonical_dict(), allow_official=False)
        self.assertEqual(parsed.digest(), again.digest())
        self.assertEqual(parsed.resolved_endpoint(), "https://api.example.com/v1/chat/completions")
        self.assertEqual(parsed.resolved_method(), "POST")
        self.assertEqual(canonical_dumps(parsed.to_canonical_dict()), canonical_dumps(again.to_canonical_dict()))


class ProfileValidationTests(IsolatedHomeTest):
    def test_all_protocols_default_paths(self) -> None:
        expected = {
            "openai-chat": "/chat/completions",
            "openai-responses": "/responses",
            "anthropic-messages": "/messages",
        }
        for protocol, path in expected.items():
            profile = parse_profile(
                sample_profile(
                    id=protocol.replace("openai-", "p-").replace("anthropic-", "p-"),
                    protocol=protocol,
                )
            )
            self.assertEqual(profile.protocol, Protocol(protocol))
            self.assertEqual(profile.endpoint_path, path)
            self.assertTrue(str(profile.resolved_endpoint()).endswith(path))

    def test_path_override_and_arbitrary_https_model(self) -> None:
        profile = parse_profile(
            sample_profile(
                id="gateway-a",
                baseUrl="https://gateway.other.example/prefix/v1",
                endpointPath="/custom/chat",
                model="org/custom-model.v2",
            )
        )
        self.assertEqual(
            profile.resolved_endpoint(),
            "https://gateway.other.example/prefix/v1/custom/chat",
        )
        self.assertEqual(profile.model, "org/custom-model.v2")

    def test_query_is_kept_on_resolved_endpoint(self) -> None:
        profile = parse_profile(
            sample_profile(baseUrl="https://api.example.com/v1?api-version=2024-01-01")
        )
        self.assertEqual(
            profile.resolved_endpoint(),
            "https://api.example.com/v1/chat/completions?api-version=2024-01-01",
        )

    def test_all_auth_types(self) -> None:
        cases = [
            ("none-auth", {"type": "none"}, AuthType.NONE, False),
            ("bearer-auth", {"type": "bearer"}, AuthType.BEARER, True),
            ("xai-auth", {"type": "x-api-key"}, AuthType.X_API_KEY, True),
            (
                "oauth-auth",
                {"type": "oauth-adapter", "adapter": "demo-adapter"},
                AuthType.OAUTH_ADAPTER,
                False,
            ),
        ]
        for profile_id, auth, expected, required in cases:
            profile = parse_profile(sample_profile(id=profile_id, auth=auth))
            self.assertEqual(profile.auth.type, expected)
            self.assertEqual(profile.requires_secret(), required)
            if required:
                self.assertEqual(profile.auth.secret_ref, "profile/" + profile_id)

    def test_loopback_http_allowed_remote_http_rejected(self) -> None:
        loopback = parse_profile(sample_profile(baseUrl="http://127.0.0.1:18779/v1"))
        self.assertEqual(loopback.resolved_endpoint(), "http://127.0.0.1:18779/v1/chat/completions")
        localhost = parse_profile(sample_profile(id="local-host", baseUrl="http://localhost:8080/v1"))
        self.assertTrue(str(localhost.resolved_endpoint()).startswith("http://localhost:8080/"))
        ipv6 = parse_profile(sample_profile(id="local-v6", baseUrl="http://[::1]/v1"))
        self.assertEqual(ipv6.resolved_endpoint(), "http://[::1]/v1/chat/completions")
        with self.assertRaises(ValidationError):
            parse_profile(sample_profile(baseUrl="http://api.example.com/v1"))

    def test_userinfo_and_fragment_rejected_without_echo(self) -> None:
        password = "pw-not-for-output"
        url = "https://alice:" + password + "@api.example.com/v1"
        with self.assertRaises(ValidationError) as raised:
            parse_profile(sample_profile(baseUrl=url))
        self.assertNotIn(password, str(raised.exception))
        with self.assertRaises(ValidationError):
            parse_profile(sample_profile(baseUrl="https://api.example.com/v1#frag"))

    def test_unsafe_headers_crlf_and_duplicates_rejected(self) -> None:
        for headers in (
            {"Authorization": "Bearer x"},
            {"Cookie": "a=b"},
            {"Host": "example.com"},
            {"Content-Length": "1"},
            {"Connection": "close"},
            {"X-Forwarded-For": "1.1.1.1"},
            {"X-Api-Key": "nope"},
        ):
            with self.assertRaises(ValidationError):
                parse_profile(sample_profile(headers=headers))
        with self.assertRaises(ValidationError):
            parse_profile(sample_profile(displayName="bad\r\nname"))
        with self.assertRaises(ValidationError):
            parse_profile(sample_profile(headers={"X-Trace": "ok", "x-trace": "dup"}))
        with self.assertRaises(ValidationError):
            parse_profile(sample_profile(headers={"X-Trace": "bad\nvalue"}))

    def test_secret_bearing_fields_and_values_rejected(self) -> None:
        with self.assertRaises(ValidationError) as raised:
            parse_profile(sample_profile(apiKey="not-used"))
        self.assertNotIn("not-used", str(raised.exception))
        secret_value = fake_key_value()
        with self.assertRaises(ValidationError) as raised:
            parse_profile(sample_profile(model=secret_value))
        self.assertNotIn(secret_value, str(raised.exception))
        with self.assertRaises(ValidationError):
            parse_profile(sample_profile(auth={"type": "bearer", "token": "abc"}))

    def test_invalid_ids_rejected(self) -> None:
        for bad in ("Custom", "a_b", "-abc", "abc-", "", "a" * 80):
            with self.assertRaises(ValidationError):
                parse_profile(sample_profile(id=bad))

    def test_official_cannot_be_created_from_input(self) -> None:
        with self.assertRaises(ValidationError):
            parse_profile({"schemaVersion": 1, "id": "official", "displayName": "官方 Grok"})

    def test_fallback_must_be_never(self) -> None:
        with self.assertRaises(ValidationError):
            parse_profile(sample_profile(fallbackPolicy="native"))

    def test_unsafe_endpoint_paths_rejected(self) -> None:
        for path in ("chat/completions", "/../etc/passwd", "/chat?", "/chat#x", "/chat//x", "/chat/%2f"):
            with self.assertRaises(ValidationError):
                parse_profile(sample_profile(endpointPath=path))


class RegistryTests(IsolatedHomeTest):
    def test_official_is_built_in_and_protected(self) -> None:
        registry = self.registry()
        profiles = registry.list_profiles()
        self.assertEqual(profiles[0].id, "official")
        self.assertTrue(profiles[0].built_in)
        with self.assertRaises(Exception):
            registry.remove("official")
        with self.assertRaises(Exception):
            registry.add({"schemaVersion": 1, "id": "official", "displayName": "官方 Grok"})
        self.assertEqual(registry.get("official").digest(), official_profile().digest())

    def test_add_show_remove_and_duplicate(self) -> None:
        registry = self.registry()
        added = registry.add(sample_profile())
        self.assertEqual(added.id, "custom-openai")
        self.assertEqual(registry.get("custom-openai").model, "model-name")
        with self.assertRaises(Exception):
            registry.add(sample_profile())
        registry.remove("custom-openai")
        with self.assertRaises(Exception):
            registry.get("custom-openai")
        self.assertEqual([item.id for item in registry.list_profiles()], ["official"])

    def test_atomic_replacement_leaves_previous_state(self) -> None:
        registry = self.registry()
        registry.add(sample_profile())
        before = registry.path.read_bytes()
        with self.assertRaises(ValidationError):
            registry.add(sample_profile(id="bad id"))
        self.assertEqual(registry.path.read_bytes(), before)
        leftover = list(self.home.glob(".profiles.*"))
        self.assertEqual(leftover, [])
        registry.add(sample_profile(id="second-ok", displayName="Second"))
        ids = [item.id for item in registry.list_profiles()]
        self.assertEqual(ids, ["official", "custom-openai", "second-ok"])

    def test_home_and_profiles_are_owner_only(self) -> None:
        registry = self.registry()
        registry.add(sample_profile())
        self.assertEqual(stat.S_IMODE(os.stat(self.home).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(registry.path).st_mode), 0o600)

    def test_symlink_profiles_file_rejected(self) -> None:
        registry = self.registry()
        registry.save(registry.load())
        target = Path(self.tmp.name) / "outside.json"
        target.write_text("{}", encoding="utf-8")
        registry.path.unlink()
        os.symlink(target, registry.path)
        with self.assertRaises(ValidationError):
            registry.load()

    def test_disk_official_is_replaced_by_builtin(self) -> None:
        registry = self.registry()
        registry.add(sample_profile())
        document = json.loads(registry.path.read_text(encoding="utf-8"))
        document["profiles"]["official"]["displayName"] = "tampered"
        registry.path.write_text(json.dumps(document), encoding="utf-8")
        os.chmod(registry.path, 0o600)
        loaded = registry.get("official")
        self.assertEqual(loaded.display_name, "官方 Grok")
        self.assertTrue(loaded.built_in)


class SecretStoreTests(IsolatedHomeTest):
    def setUp(self) -> None:
        super().setUp()
        self.registry().add(sample_profile())
        self.store = SecretStore(self.home)
        self.secret = b"local-test-credential-aaaaaaaa"

    def test_set_status_remove_and_no_secret_return(self) -> None:
        status = self.store.set_from_stream("custom-openai", _Bytes(self.secret))
        self.assertTrue(status.installed)
        self.assertEqual(status.byte_count, len(self.secret))
        self.assertEqual(len(status.fingerprint_prefix or ""), 12)
        self.assertNotIn(self.secret.decode("ascii"), json.dumps(status.to_public_dict()))
        path = self.store.path_for("custom-openai")
        self.assertTrue(path.is_file())
        self.assertFalse(path.is_symlink())
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.store.remove("custom-openai")
        self.assertFalse(path.exists())

    def test_empty_whitespace_and_control_rejected(self) -> None:
        for payload in (b"", b"abc def", b"abc\n", b"abc\x00", b" abc"):
            with self.assertRaises(Exception):
                self.store.set_from_stream("custom-openai", _Bytes(payload))
        self.assertFalse(self.store.path_for("custom-openai").exists())

    def test_symlink_rejected_on_set_and_status(self) -> None:
        path = self.store.path_for("custom-openai")
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        outside = Path(self.tmp.name) / "outside-secret"
        outside.write_bytes(self.secret)
        os.symlink(outside, path)
        with self.assertRaises(Exception):
            self.store.set_from_stream("custom-openai", _Bytes(self.secret))
        status = self.store.status("custom-openai", required=True)
        self.assertTrue(status.rejected)
        self.assertFalse(status.installed)
        self.assertIsNone(status.fingerprint_prefix)

    def test_group_world_permissions_rejected(self) -> None:
        self.store.set_from_stream("custom-openai", _Bytes(self.secret))
        path = self.store.path_for("custom-openai")
        os.chmod(path, 0o644)
        status = self.store.status("custom-openai", required=True)
        self.assertTrue(status.rejected)
        self.assertFalse(status.installed)

    def test_official_has_no_secret(self) -> None:
        with self.assertRaises(Exception):
            self.store.set_from_stream("official", _Bytes(self.secret))


class ServiceIsolationTests(IsolatedHomeTest):
    def test_synthetic_home_does_not_touch_default(self) -> None:
        service = self.service()
        service.add_provider(sample_profile())
        default_home = Path.home() / ".grokctl"
        self.assertTrue((self.home / "profiles.json").exists())
        if default_home.exists():
            self.assertNotEqual(default_home.resolve(), self.home.resolve())

    def test_test_and_plan_are_credential_free(self) -> None:
        service = self.service()
        service.add_provider(sample_profile())
        result = service.test_profile("custom-openai")
        self.assertFalse(result["ok"])
        self.assertEqual(result["state"], "needs-key")
        plan = service.plan("custom-openai")
        self.assertTrue(plan["dryRun"])
        self.assertFalse(plan["hostMutation"])
        self.assertIn("needs-key", plan["blocking"])
        with self.assertRaises(Exception):
            service.use("custom-openai", apply=True)
        with self.assertRaises(Exception):
            service.test_profile("custom-openai", live=True)


class _Bytes:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data


if __name__ == "__main__":
    unittest.main()
