#!/usr/bin/env python3
"""Credential-free tests for the Grok Bot 0.30 direct-executor patcher."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATCHER_PATH = ROOT / "ops" / "patch_grok_host_direct_executor.py"
EXAMPLE_CONFIG_PATH = ROOT / "config" / "direct-external-only.example.json"
STOCK_BUNDLE_PATH = Path(
    "/Users/sunny/Work/CODEX/grok_home/research/current-0.30/host-main.cjs"
)
CANONICAL_CONFIG = {
    "schemaVersion": 1,
    "enabled": True,
    "mode": "external-only",
    "nativeFallback": False,
    "provider": "beefapi",
    "group": "grok",
    "modelId": "grok-4.6",
    "baseUrl": "http://127.0.0.1:18779/v1",
}
FORBIDDEN_CONFIG_KEYS = {
    "apikey",
    "api_key",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "key",
    "keyfile",
    "oauth",
    "password",
    "secret",
    "token",
    "accesstoken",
    "refreshtoken",
}


def load_patcher():
    spec = importlib.util.spec_from_file_location(
        "patch_grok_host_direct_executor", PATCHER_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load patcher module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PATCHER = load_patcher()

WIRE_SOURCE = """function parseBeefApiDirectConfig(raw) {
  return raw == null ? null : raw;
}
"""

SESSION_SOURCE = """function wrapHostInferenceWithBeefApiDirect(cursorInference, options) {
  void options;
  return cursorInference;
}
"""


def mini_bundle():
    return (
        '"use strict";\n'
        "function createCursorSandInference(options2) {\n"
        "  const uniqueStockCursorSand = options2;\n"
        "  return uniqueStockCursorSand;\n"
        "}\n\n"
        + PATCHER.INJECTION_ANCHOR
        + "\n"
        "  const { sessionOptions, envModelOverride, storedDefaultModel } = inputs;\n"
        "  return sessionOptions;\n"
        "}\n\n"
        "// src/host/extensions/inference/inference-service.ts\n"
        + PATCHER.STOCK_CREATE_HOST_INFERENCE
        + "\n\n"
        "//# sourceMappingURL=host-main.cjs.map\n"
    )


def collect_keys(value):
    keys = []
    if isinstance(value, dict):
        for key, child in value.items():
            keys.append(str(key))
            keys.extend(collect_keys(child))
    elif isinstance(value, list):
        for child in value:
            keys.extend(collect_keys(child))
    return keys


def node_check(path: Path) -> None:
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not available")
    completed = subprocess.run(
        [node, "--check", str(path)],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "node --check failed:\n"
            + completed.stdout
            + completed.stderr
        )


class ApplyPatchTests(unittest.TestCase):
    def test_injects_wire_then_session_and_wraps_create_host_inference(self):
        source = mini_bundle()
        patched = PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)
        begin = patched.index(PATCHER.MARKER_BEGIN)
        wire_at = patched.index("function parseBeefApiDirectConfig")
        session_at = patched.index("function wrapHostInferenceWithBeefApiDirect")
        end = patched.index(PATCHER.MARKER_END)
        anchor_at = patched.index(PATCHER.INJECTION_ANCHOR)
        wrap_return = (
            "return wrapHostInferenceWithBeefApiDirect("
            "cursorInference, { settings, experiments, auth: auth2 });"
        )
        self.assertLess(begin, wire_at)
        self.assertLess(wire_at, session_at)
        self.assertLess(session_at, end)
        self.assertLess(end, anchor_at)
        self.assertIn(PATCHER.PATCHED_CREATE_HOST_INFERENCE, patched)
        self.assertNotIn(PATCHER.STOCK_CREATE_HOST_INFERENCE, patched)
        self.assertIn(wrap_return, patched)
        self.assertIn("const uniqueStockCursorSand = options2;", patched)
        self.assertEqual(patched.count("function createCursorSandInference(options2) {"), 1)
        self.assertTrue(patched.endswith("//# sourceMappingURL=host-main.cjs.map\n"))
        self.assertEqual(source.count(PATCHER.INJECTION_ANCHOR), 1)
        self.assertEqual(patched.count(PATCHER.INJECTION_ANCHOR), 1)

    def test_idempotent_on_correctly_patched_output(self):
        source = mini_bundle()
        patched = PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)
        again = PATCHER.apply_patch(patched, WIRE_SOURCE, SESSION_SOURCE)
        self.assertEqual(patched, again)

    def test_normalizes_crlf_and_missing_trailing_newline_deterministically(self):
        source = mini_bundle()
        wire = WIRE_SOURCE.replace("\n", "\r\n").rstrip()
        session = SESSION_SOURCE.replace("\n", "\r\n").rstrip()
        patched = PATCHER.apply_patch(source, wire, session)
        again = PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)
        self.assertEqual(patched, again)
        self.assertNotIn("\r", patched)

    def test_missing_injection_anchor_fails(self):
        source = mini_bundle().replace(PATCHER.INJECTION_ANCHOR, "// missing\nfunction resolveSandRequestedModel(inputs) {")
        with self.assertRaisesRegex(PATCHER.PatchError, "injection anchor count=0"):
            PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)

    def test_duplicate_injection_anchor_fails(self):
        source = mini_bundle() + "\n" + PATCHER.INJECTION_ANCHOR + "\n"
        with self.assertRaisesRegex(PATCHER.PatchError, "injection anchor count=2"):
            PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)

    def test_missing_create_host_inference_fails(self):
        source = mini_bundle().replace(PATCHER.STOCK_CREATE_HOST_INFERENCE, "function createHostInference(options2) { return null; }")
        with self.assertRaisesRegex(PATCHER.PatchError, "stock createHostInference count=0"):
            PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)

    def test_partial_marker_begin_without_end_fails(self):
        source = PATCHER.MARKER_BEGIN + "\n" + mini_bundle()
        with self.assertRaisesRegex(PATCHER.PatchError, "partial/ambiguous injection marker"):
            PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)

    def test_partial_wrap_without_marker_fails(self):
        source = mini_bundle().replace(
            PATCHER.STOCK_CREATE_HOST_INFERENCE,
            PATCHER.PATCHED_CREATE_HOST_INFERENCE,
        )
        with self.assertRaisesRegex(PATCHER.PatchError, "wrap present without injection marker"):
            PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)

    def test_marker_with_mismatched_payload_fails(self):
        patched = PATCHER.apply_patch(mini_bundle(), WIRE_SOURCE, SESSION_SOURCE)
        other_session = (
            "function wrapHostInferenceWithBeefApiDirect(cursorInference, options) {\n"
            "  return cursorInference;\n"
            "}\n"
            "function extraDirectHelper() { return null; }\n"
        )
        with self.assertRaisesRegex(PATCHER.PatchError, "payload does not match"):
            PATCHER.apply_patch(patched, WIRE_SOURCE, other_session)

    def test_injected_marker_without_wrap_fails(self):
        block = PATCHER.build_injection_block(
            PATCHER.normalize_injected_source(WIRE_SOURCE, "wire source"),
            PATCHER.normalize_injected_source(SESSION_SOURCE, "session source"),
        )
        source = mini_bundle().replace(
            PATCHER.INJECTION_ANCHOR, block + PATCHER.INJECTION_ANCHOR, 1
        )
        with self.assertRaisesRegex(PATCHER.PatchError, "partial/ambiguous createHostInference wrap"):
            PATCHER.apply_patch(source, WIRE_SOURCE, SESSION_SOURCE)

    def test_session_source_must_define_wrap_function_once(self):
        with self.assertRaisesRegex(PATCHER.PatchError, "wrapHostInferenceWithBeefApiDirect count=0"):
            PATCHER.apply_patch(mini_bundle(), WIRE_SOURCE, "function other() { return null; }\n")

    def test_module_exports_rejected(self):
        bad_wire = WIRE_SOURCE + "module.exports = { parseBeefApiDirectConfig };\n"
        with self.assertRaisesRegex(PATCHER.PatchError, "module.exports"):
            PATCHER.apply_patch(mini_bundle(), bad_wire, SESSION_SOURCE)

    def test_empty_source_rejected(self):
        with self.assertRaisesRegex(PATCHER.PatchError, "wire source is empty"):
            PATCHER.apply_patch(mini_bundle(), "   \n", SESSION_SOURCE)

    def test_synthetic_output_is_valid_javascript(self):
        patched = PATCHER.apply_patch(mini_bundle(), WIRE_SOURCE, SESSION_SOURCE)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "patched.cjs"
            path.write_text(patched, encoding="utf-8")
            node_check(path)


class BackupAndFenceTests(unittest.TestCase):
    def test_sha_fence_rejects_unpatched_non_stock_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stock = root / "stock.cjs"
            wire = root / "wire.cjs"
            session = root / "session.cjs"
            output = root / "out.cjs"
            stock.write_text(mini_bundle(), encoding="utf-8")
            wire.write_text(WIRE_SOURCE, encoding="utf-8")
            session.write_text(SESSION_SOURCE, encoding="utf-8")
            with self.assertRaisesRegex(PATCHER.PatchError, "stock SHA-256 mismatch"):
                PATCHER.patch_host_bundle(stock, wire, session, output, root / "backup")
            self.assertFalse(output.exists())

    def test_refuses_in_place_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bundle.cjs"
            path.write_text(mini_bundle(), encoding="utf-8")
            with self.assertRaisesRegex(PATCHER.PatchError, "in-place"):
                PATCHER.patch_host_bundle(
                    path,
                    path,
                    path,
                    path,
                    Path(tmp) / "backup",
                )

    def test_backup_manifest_contains_required_fields_and_no_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            input_path = root / "input.cjs"
            output_path = root / "output.cjs"
            wire_path = root / "wire.cjs"
            session_path = root / "session.cjs"
            original = b"original-bytes\n"
            patched = mini_bundle()
            input_path.write_bytes(original)
            wire_path.write_text(WIRE_SOURCE, encoding="utf-8")
            session_path.write_text(SESSION_SOURCE, encoding="utf-8")
            counts = PATCHER.anchor_counts(patched)
            manifest_path = PATCHER.write_rollback_artifacts(
                root / "backup",
                input_path=input_path,
                output_path=output_path,
                input_raw=original,
                patched_text=patched,
                wire_path=wire_path,
                session_path=session_path,
                wire_raw=WIRE_SOURCE.encode("utf-8"),
                session_raw=SESSION_SOURCE.encode("utf-8"),
                idempotent=False,
                input_counts=counts,
                output_counts=counts,
            )
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            original_sha = hashlib.sha256(original).hexdigest()
            self.assertEqual(payload["kind"], "grok-host-direct-executor-backup")
            self.assertEqual(payload["stockSha256Expected"], PATCHER.STOCK_SHA256)
            self.assertEqual(payload["input"]["sha256"], original_sha)
            self.assertEqual(payload["input"]["size"], len(original))
            self.assertEqual(payload["output"]["size"], len(patched.encode("utf-8")))
            self.assertIn("wire", payload["sources"])
            self.assertIn("session", payload["sources"])
            self.assertIn("anchors", payload)
            self.assertIn("injection_anchor", payload["anchors"])
            artifact = Path(payload["rollbackArtifact"])
            self.assertEqual(artifact.read_bytes(), original)
            self.assertEqual(artifact.name, original_sha + ".cjs")
            self.assertEqual(manifest_path.name, original_sha + ".manifest.json")
            serialized = json.dumps(payload)
            for needle in ("sk-", "Authorization", "apiKey", "keyFile", "cookie"):
                self.assertNotIn(needle, serialized)
            for key in collect_keys(payload):
                self.assertNotIn(key.lower().replace("_", ""), FORBIDDEN_CONFIG_KEYS)

    def test_cli_reports_sha_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stock = root / "stock.cjs"
            wire = root / "wire.cjs"
            session = root / "session.cjs"
            output = root / "out.cjs"
            stock.write_text(mini_bundle(), encoding="utf-8")
            wire.write_text(WIRE_SOURCE, encoding="utf-8")
            session.write_text(SESSION_SOURCE, encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    str(PATCHER_PATH),
                    "--stock",
                    str(stock),
                    "--wire",
                    str(wire),
                    "--session",
                    str(session),
                    "--output",
                    str(output),
                    "--backup-dir",
                    str(root / "backup"),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 1)
            self.assertIn("stock SHA-256 mismatch", completed.stderr)
            self.assertFalse(output.exists())


class CanonicalConfigTests(unittest.TestCase):
    def test_example_matches_canonical_contract_and_has_no_secrets(self):
        raw = EXAMPLE_CONFIG_PATH.read_text(encoding="utf-8")
        payload = json.loads(raw)
        self.assertEqual(payload, CANONICAL_CONFIG)
        self.assertEqual(set(payload.keys()), set(CANONICAL_CONFIG.keys()))
        for key in collect_keys(payload):
            normalized = key.lower().replace("_", "")
            self.assertNotIn(normalized, FORBIDDEN_CONFIG_KEYS)
        lowered = raw.lower()
        for needle in ("sk-", "apikey", "keyfile", "authorization", "cookie", "token"):
            self.assertNotIn(needle, lowered)


@unittest.skipUnless(STOCK_BUNDLE_PATH.is_file(), "stock bundle absent")
class RealBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = STOCK_BUNDLE_PATH.read_bytes()
        cls.sha = hashlib.sha256(cls.raw).hexdigest()
        cls.text = cls.raw.decode("utf-8")

    def test_patcher_constants_match_stock_bundle(self):
        self.assertEqual(self.sha, PATCHER.STOCK_SHA256)
        self.assertEqual(self.text.count(PATCHER.INJECTION_ANCHOR), 1)
        self.assertEqual(self.text.count(PATCHER.STOCK_CREATE_HOST_INFERENCE), 1)
        self.assertEqual(self.text.count(PATCHER.CREATE_CURSOR_SAND_ANCHOR), 1)
        self.assertEqual(self.text.count(PATCHER.MARKER_BEGIN), 0)
        self.assertEqual(
            self.text.count("// src/host/extensions/inference/cursor-session.ts\ninit_dist9();"),
            1,
        )

    def test_real_bundle_patch_backup_idempotence_and_syntax(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wire = root / "beefapi-openai-wire.cjs"
            session = root / "beefapi-direct-session.cjs"
            output = root / "host-main.direct.cjs"
            second = root / "host-main.direct.second.cjs"
            backup_dir = root / "backup"
            wire.write_text(WIRE_SOURCE, encoding="utf-8")
            session.write_text(SESSION_SOURCE, encoding="utf-8")
            report = PATCHER.patch_host_bundle(
                STOCK_BUNDLE_PATH, wire, session, output, backup_dir
            )
            patched = output.read_bytes()
            patched_text = patched.decode("utf-8")
            self.assertTrue(report["changed"])
            self.assertFalse(report["idempotent"])
            self.assertEqual(report["inputSha256"], PATCHER.STOCK_SHA256)
            self.assertEqual(hashlib.sha256(patched).hexdigest(), report["outputSha256"])
            self.assertIn(PATCHER.MARKER_BEGIN, patched_text)
            self.assertIn(PATCHER.MARKER_END, patched_text)
            self.assertIn(
                PATCHER.build_injection_block(
                    PATCHER.normalize_injected_source(WIRE_SOURCE, "wire source"),
                    PATCHER.normalize_injected_source(SESSION_SOURCE, "session source"),
                )
                + PATCHER.INJECTION_ANCHOR,
                patched_text,
            )
            self.assertIn(PATCHER.PATCHED_CREATE_HOST_INFERENCE, patched_text)
            self.assertNotIn(PATCHER.STOCK_CREATE_HOST_INFERENCE, patched_text)
            self.assertEqual(patched_text.count(PATCHER.CREATE_CURSOR_SAND_ANCHOR), 1)
            self.assertEqual(
                patched_text.count("// src/host/extensions/inference/cursor-session.ts\ninit_dist9();"),
                1,
            )
            self.assertTrue(patched_text.endswith("//# sourceMappingURL=host-main.cjs.map\n"))
            self.assertEqual(
                hashlib.sha256(STOCK_BUNDLE_PATH.read_bytes()).hexdigest(),
                PATCHER.STOCK_SHA256,
            )
            manifest_path = Path(report["backupManifest"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["input"]["sha256"], PATCHER.STOCK_SHA256)
            self.assertEqual(manifest["output"]["sha256"], report["outputSha256"])
            artifact = Path(manifest["rollbackArtifact"])
            self.assertEqual(hashlib.sha256(artifact.read_bytes()).hexdigest(), PATCHER.STOCK_SHA256)
            node_check(output)
            second_report = PATCHER.patch_host_bundle(
                output, wire, session, second, backup_dir
            )
            self.assertTrue(second_report["idempotent"])
            self.assertFalse(second_report["changed"])
            self.assertEqual(second.read_bytes(), patched)


if __name__ == "__main__":
    unittest.main()
