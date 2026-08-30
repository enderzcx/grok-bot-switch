#!/usr/bin/env python3
"""Credential-free tests for the Grok Bot 0.30 provider-switcher patcher."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATCHER_PATH = ROOT / "ops" / "patch_grok_host_provider_switcher.py"
EXAMPLE_CONFIG_PATH = ROOT / "config" / "provider-switcher.example.json"
REAL_PROTOCOLS_DIR = ROOT / "src" / "provider_protocols"
REAL_SESSION_PATH = ROOT / "src" / "provider-direct-session.cjs"
STOCK_BUNDLE_PATH = Path(
    "/Users/sunny/Work/CODEX/grok_home/research/current-0.30/host-main.cjs"
)
CURRENT_HOST_PATH = Path(
    "/Users/sunny/Work/CODEX/grok-bot-switch/runtime/windows-028-audit/host-main-17184bb.cjs"
)
CANONICAL_CONFIG = {
    "schemaVersion": 1,
    "enabled": True,
    "mode": "external-only",
    "nativeFallback": False,
    "fallbackPolicy": "never",
    "profileId": "custom-openai",
    "protocol": "openai-chat",
    "model": "model-name",
    "baseUrl": "http://127.0.0.1:18779",
    "endpointPath": "/chat/completions",
    "generation": 1,
    "profileDigest": "06b100f3190f0af653876625d97fbff1edc903662cc172e02d8eb62ce6789773",
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
        "patch_grok_host_provider_switcher", PATCHER_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load patcher module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PATCHER = load_patcher()

SESSION_SOURCE = """function wrapHostInferenceWithProviderSwitcher(cursorInference, options) {
  void options;
  return cursorInference;
}
"""


def mini_protocol_sources() -> dict[str, str]:
    return {
        "contract.cjs": "module.exports = { id: \"contract\" };\n",
        "sse.cjs": "module.exports = { id: \"sse\" };\n",
        "tools.cjs": "module.exports = { id: \"tools\" };\n",
        "openai-chat.cjs": "module.exports = { id: \"openai-chat\" };\n",
        "openai-responses.cjs": "module.exports = { id: \"openai-responses\" };\n",
        "anthropic-messages.cjs": "module.exports = { id: \"anthropic-messages\" };\n",
        "index.cjs": (
            'var contract = require("./contract.cjs");\n'
            "module.exports = { id: \"index\", contractId: contract.id };\n"
        ),
    }


def write_protocol_dir(root: Path, sources: dict[str, str] | None = None) -> Path:
    directory = root / "provider_protocols"
    directory.mkdir(parents=True, exist_ok=True)
    payload = sources if sources is not None else mini_protocol_sources()
    for name, text in payload.items():
        (directory / name).write_text(text, encoding="utf-8")
    return directory


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


def node_eval(script: str) -> str:
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not available")
    completed = subprocess.run(
        [node, "--input-type=commonjs", "-e", script],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "node eval failed:\n"
            + completed.stdout
            + completed.stderr
        )
    return completed.stdout


class ApplyPatchTests(unittest.TestCase):
    def test_injects_protocol_modules_then_session_and_wraps_create_host_inference(self):
        source = mini_bundle()
        protocols = mini_protocol_sources()
        patched = PATCHER.apply_patch(source, protocols, SESSION_SOURCE)
        begin = patched.index(PATCHER.MARKER_BEGIN)
        runtime_at = patched.index("function __grokProviderRequire")
        contract_at = patched.index('__grokProviderRegister("./contract.cjs"')
        index_at = patched.index('__grokProviderRegister("./index.cjs"')
        session_at = patched.index("function wrapHostInferenceWithProviderSwitcher")
        end = patched.index(PATCHER.MARKER_END)
        anchor_at = patched.index(PATCHER.INJECTION_ANCHOR)
        wrap_return = (
            "return wrapHostInferenceWithProviderSwitcher("
            "cursorInference, { settings, experiments, auth: auth2 });"
        )
        self.assertLess(begin, runtime_at)
        self.assertLess(runtime_at, contract_at)
        self.assertLess(contract_at, index_at)
        self.assertLess(index_at, session_at)
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
        self.assertNotIn("sk-", patched)
        self.assertNotIn("apiKey", patched)

    def test_injected_protocol_registry_executes_without_node_require(self):
        patched = PATCHER.apply_patch(mini_bundle(), mini_protocol_sources(), SESSION_SOURCE)
        block = PATCHER._extract_injection_block(patched)
        script = (
            block
            + "console.log(JSON.stringify({"
            + "ids: Object.keys(__grokProviderModules).sort(),"
            + 'index: __grokProviderRequire("./index.cjs")'
            + "}));\n"
        )
        payload = json.loads(node_eval(script))
        self.assertEqual(
            payload["ids"],
            ["./anthropic-messages.cjs", "./contract.cjs", "./index.cjs", "./openai-chat.cjs", "./openai-responses.cjs", "./sse.cjs", "./tools.cjs"],
        )
        self.assertEqual(payload["index"]["contractId"], "contract")

    def test_idempotent_on_correctly_patched_output(self):
        source = mini_bundle()
        protocols = mini_protocol_sources()
        patched = PATCHER.apply_patch(source, protocols, SESSION_SOURCE)
        again = PATCHER.apply_patch(patched, protocols, SESSION_SOURCE)
        self.assertEqual(patched, again)

    def test_transcribe_guard_is_inside_dispatch_and_idempotent(self):
        source = mini_bundle() + PATCHER.STOCK_CREATE_SAND_TRANSCRIBE_AUDIO
        patched = PATCHER.apply_patch(source, mini_protocol_sources(), SESSION_SOURCE)
        self.assertEqual(patched.count(PATCHER.PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO), 1)
        self.assertEqual(patched.count(PATCHER.STOCK_CREATE_SAND_TRANSCRIBE_AUDIO), 0)
        self.assertIn("return async (request3) => {\n    assertProviderDirectNativeAudioAllowed();", patched)
        self.assertEqual(PATCHER.apply_patch(patched, mini_protocol_sources(), SESSION_SOURCE), patched)
        unguarded = patched.replace(PATCHER.PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO, PATCHER.STOCK_CREATE_SAND_TRANSCRIBE_AUDIO)
        with self.assertRaisesRegex(PATCHER.PatchError, "patched createSandTranscribeAudio anchor mismatch"):
            PATCHER.apply_patch(unguarded, mini_protocol_sources(), SESSION_SOURCE)

    def test_transcribe_anchor_mismatch_and_duplicates_fail_closed(self):
        for audio in (
            PATCHER.STOCK_CREATE_SAND_TRANSCRIBE_AUDIO.replace("const onRequestId", "let onRequestId"),
            PATCHER.STOCK_CREATE_SAND_TRANSCRIBE_AUDIO * 2,
            PATCHER.PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO,
        ):
            with self.assertRaisesRegex(PATCHER.PatchError, "createSandTranscribeAudio anchor"):
                PATCHER.apply_patch(mini_bundle() + audio, mini_protocol_sources(), SESSION_SOURCE)

    def test_normalizes_crlf_and_missing_trailing_newline_deterministically(self):
        source = mini_bundle()
        protocols = {
            name: text.replace("\n", "\r\n").rstrip()
            for name, text in mini_protocol_sources().items()
        }
        session = SESSION_SOURCE.replace("\n", "\r\n").rstrip()
        patched = PATCHER.apply_patch(source, protocols, session)
        again = PATCHER.apply_patch(source, mini_protocol_sources(), SESSION_SOURCE)
        self.assertEqual(patched, again)
        self.assertNotIn("\r", patched)

    def test_missing_injection_anchor_fails(self):
        source = mini_bundle().replace(PATCHER.INJECTION_ANCHOR, "// missing\nfunction resolveSandRequestedModel(inputs) {")
        with self.assertRaisesRegex(PATCHER.PatchError, "injection anchor count=0"):
            PATCHER.apply_patch(source, mini_protocol_sources(), SESSION_SOURCE)

    def test_duplicate_injection_anchor_fails(self):
        source = mini_bundle() + "\n" + PATCHER.INJECTION_ANCHOR + "\n"
        with self.assertRaisesRegex(PATCHER.PatchError, "injection anchor count=2"):
            PATCHER.apply_patch(source, mini_protocol_sources(), SESSION_SOURCE)

    def test_missing_create_host_inference_fails(self):
        source = mini_bundle().replace(PATCHER.STOCK_CREATE_HOST_INFERENCE, "function createHostInference(options2) { return null; }")
        with self.assertRaisesRegex(PATCHER.PatchError, "stock createHostInference count=0"):
            PATCHER.apply_patch(source, mini_protocol_sources(), SESSION_SOURCE)

    def test_partial_marker_begin_without_end_fails(self):
        source = PATCHER.MARKER_BEGIN + "\n" + mini_bundle()
        with self.assertRaisesRegex(PATCHER.PatchError, "partial/ambiguous injection marker"):
            PATCHER.apply_patch(source, mini_protocol_sources(), SESSION_SOURCE)

    def test_partial_wrap_without_marker_fails(self):
        source = mini_bundle().replace(
            PATCHER.STOCK_CREATE_HOST_INFERENCE,
            PATCHER.PATCHED_CREATE_HOST_INFERENCE,
        )
        with self.assertRaisesRegex(PATCHER.PatchError, "wrap present without injection marker"):
            PATCHER.apply_patch(source, mini_protocol_sources(), SESSION_SOURCE)

    def test_marker_with_mismatched_payload_fails(self):
        patched = PATCHER.apply_patch(mini_bundle(), mini_protocol_sources(), SESSION_SOURCE)
        other_session = (
            "function wrapHostInferenceWithProviderSwitcher(cursorInference, options) {\n"
            "  return cursorInference;\n"
            "}\n"
            "function extraProviderHelper() { return null; }\n"
        )
        with self.assertRaisesRegex(PATCHER.PatchError, "payload does not match"):
            PATCHER.apply_patch(patched, mini_protocol_sources(), other_session)

    def test_injected_marker_without_wrap_fails(self):
        block = PATCHER.build_injection_block(
            {
                name: PATCHER.normalize_injected_source(text, name)
                for name, text in mini_protocol_sources().items()
            },
            PATCHER.normalize_injected_source(SESSION_SOURCE, "session source"),
        )
        source = mini_bundle().replace(
            PATCHER.INJECTION_ANCHOR, block + PATCHER.INJECTION_ANCHOR, 1
        )
        with self.assertRaisesRegex(PATCHER.PatchError, "partial/ambiguous createHostInference wrap"):
            PATCHER.apply_patch(source, mini_protocol_sources(), SESSION_SOURCE)

    def test_session_source_must_define_wrap_function_once(self):
        with self.assertRaisesRegex(PATCHER.PatchError, "wrapHostInferenceWithProviderSwitcher count=0"):
            PATCHER.apply_patch(mini_bundle(), mini_protocol_sources(), "function other() { return null; }\n")

    def test_module_exports_rejected_in_session(self):
        bad_session = SESSION_SOURCE + "module.exports = { wrapHostInferenceWithProviderSwitcher };\n"
        with self.assertRaisesRegex(PATCHER.PatchError, "module.exports"):
            PATCHER.apply_patch(mini_bundle(), mini_protocol_sources(), bad_session)

    def test_protocol_source_must_assign_module_exports(self):
        protocols = mini_protocol_sources()
        protocols["contract.cjs"] = "var x = 1;\n"
        with self.assertRaisesRegex(PATCHER.PatchError, "module.exports"):
            PATCHER.apply_patch(mini_bundle(), protocols, SESSION_SOURCE)

    def test_empty_source_rejected(self):
        protocols = mini_protocol_sources()
        protocols["contract.cjs"] = "   \n"
        with self.assertRaisesRegex(PATCHER.PatchError, "protocol source contract.cjs is empty"):
            PATCHER.apply_patch(mini_bundle(), protocols, SESSION_SOURCE)

    def test_synthetic_output_is_valid_javascript(self):
        patched = PATCHER.apply_patch(mini_bundle(), mini_protocol_sources(), SESSION_SOURCE)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "patched.cjs"
            path.write_text(patched, encoding="utf-8")
            node_check(path)


class BackupAndFenceTests(unittest.TestCase):
    def test_sha_fence_rejects_unpatched_non_stock_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stock = root / "stock.cjs"
            session = root / "session.cjs"
            output = root / "out.cjs"
            stock.write_text(mini_bundle(), encoding="utf-8")
            session.write_text(SESSION_SOURCE, encoding="utf-8")
            protocols_dir = write_protocol_dir(root)
            with self.assertRaisesRegex(PATCHER.PatchError, "stock SHA-256 mismatch"):
                PATCHER.patch_host_bundle(stock, protocols_dir, session, output, root / "backup")
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
            session_path = root / "session.cjs"
            original = b"original-bytes\n"
            patched = mini_bundle()
            input_path.write_bytes(original)
            session_path.write_text(SESSION_SOURCE, encoding="utf-8")
            protocols_dir = write_protocol_dir(root)
            protocol_raws = {
                name: text.encode("utf-8") for name, text in mini_protocol_sources().items()
            }
            counts = PATCHER.anchor_counts(patched)
            manifest_path = PATCHER.write_rollback_artifacts(
                root / "backup",
                input_path=input_path,
                output_path=output_path,
                input_raw=original,
                patched_text=patched,
                protocols_dir=protocols_dir,
                session_path=session_path,
                protocol_raws=protocol_raws,
                session_raw=SESSION_SOURCE.encode("utf-8"),
                idempotent=False,
                input_counts=counts,
                output_counts=counts,
                recognized_stock_sha256=PATCHER.HOST_17184BB_SHA256,
            )
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            original_sha = hashlib.sha256(original).hexdigest()
            self.assertEqual(payload["kind"], "grok-host-provider-switcher-backup")
            self.assertEqual(payload["stockSha256Expected"], PATCHER.HOST_17184BB_SHA256)
            self.assertEqual(payload["input"]["sha256"], original_sha)
            self.assertEqual(payload["input"]["size"], len(original))
            self.assertEqual(payload["output"]["size"], len(patched.encode("utf-8")))
            self.assertIn("protocols", payload["sources"])
            self.assertIn("session", payload["sources"])
            self.assertIn("contract.cjs", payload["sources"]["protocols"])
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
            session = root / "session.cjs"
            output = root / "out.cjs"
            stock.write_text(mini_bundle(), encoding="utf-8")
            session.write_text(SESSION_SOURCE, encoding="utf-8")
            protocols_dir = write_protocol_dir(root)
            completed = subprocess.run(
                [
                    sys.executable,
                    str(PATCHER_PATH),
                    "--stock",
                    str(stock),
                    "--protocols-dir",
                    str(protocols_dir),
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

    def test_supported_stock_hashes_are_explicit(self):
        self.assertEqual(PATCHER.SUPPORTED_STOCK_SHA256, frozenset((
            "3c3f986e614aaf8fbec642269da40dd20f1dbd9912bdf8f2390bafd61ec684ef",
            "0035c31a74ac9d7fc9d93532cf37e217d6074143d46b1eeb3c5e79699df2f88f",
        )))

    def test_idempotent_manifest_retains_stock_identity_and_unknown_base_rejects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stock = root / "stock.cjs"
            session = root / "session.cjs"
            stock.write_text(mini_bundle(), encoding="utf-8")
            session.write_text(SESSION_SOURCE, encoding="utf-8")
            protocols_dir = write_protocol_dir(root)
            stock_sha = hashlib.sha256(stock.read_bytes()).hexdigest()
            output, second = root / "out.cjs", root / "second.cjs"
            with patch.object(PATCHER, "SUPPORTED_STOCK_SHA256", frozenset((stock_sha,))):
                first = PATCHER.patch_host_bundle(stock, protocols_dir, session, output, root / "backup")
                again = PATCHER.patch_host_bundle(output, protocols_dir, session, second, root / "backup")
                self.assertTrue(again["idempotent"])
                self.assertEqual(output.read_bytes(), second.read_bytes())
                for report in (first, again):
                    manifest = json.loads(Path(report["backupManifest"]).read_text())
                    self.assertEqual(report["recognizedStockSha256"], stock_sha)
                    self.assertEqual(manifest["stockSha256Expected"], stock_sha)
                altered = root / "altered.cjs"
                altered.write_bytes(output.read_bytes() + b"\n// unknown stock change\n")
                with self.assertRaisesRegex(PATCHER.PatchError, "stock SHA-256 mismatch"):
                    PATCHER.patch_host_bundle(altered, protocols_dir, session, root / "rejected.cjs", root / "rejected-backup")
                self.assertFalse((root / "rejected.cjs").exists())
                self.assertFalse((root / "rejected-backup").exists())

    def test_marker_bearing_unknown_stock_cannot_bypass_hash_fence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stock, session = root / "stock.cjs", root / "session.cjs"
            stock.write_text(PATCHER.apply_patch(mini_bundle(), mini_protocol_sources(), SESSION_SOURCE), encoding="utf-8")
            session.write_text(SESSION_SOURCE, encoding="utf-8")
            with self.assertRaisesRegex(PATCHER.PatchError, "stock SHA-256 mismatch"):
                PATCHER.patch_host_bundle(stock, write_protocol_dir(root), session, root / "out.cjs", root / "backup")
            self.assertFalse((root / "out.cjs").exists())


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
        self.assertRegex(payload["profileDigest"], r"^[a-f0-9]{64}$")
        self.assertEqual(payload["nativeFallback"], False)
        self.assertEqual(payload["fallbackPolicy"], "never")
        self.assertTrue(payload["baseUrl"].startswith("http://127.0.0.1"))


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
        self.assertEqual(self.text.count(PATCHER.TRANSCRIBE_FN_ANCHOR), 0)
        self.assertEqual(
            self.text.count("// src/host/extensions/inference/cursor-session.ts\ninit_dist9();"),
            1,
        )

    def test_real_bundle_patch_backup_idempotence_and_syntax(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output = root / "host-main.provider.cjs"
            second = root / "host-main.provider.second.cjs"
            backup_dir = root / "backup"
            report = PATCHER.patch_host_bundle(
                STOCK_BUNDLE_PATH,
                REAL_PROTOCOLS_DIR,
                REAL_SESSION_PATH,
                output,
                backup_dir,
            )
            patched = output.read_bytes()
            patched_text = patched.decode("utf-8")
            self.assertTrue(report["changed"])
            self.assertFalse(report["idempotent"])
            self.assertEqual(report["inputSha256"], PATCHER.STOCK_SHA256)
            self.assertEqual(hashlib.sha256(patched).hexdigest(), report["outputSha256"])
            self.assertIn(PATCHER.MARKER_BEGIN, patched_text)
            self.assertIn(PATCHER.MARKER_END, patched_text)
            self.assertIn("function wrapHostInferenceWithProviderSwitcher", patched_text)
            self.assertIn('__grokProviderRegister("./openai-chat.cjs"', patched_text)
            self.assertIn(PATCHER.PATCHED_CREATE_HOST_INFERENCE, patched_text)
            self.assertNotIn(PATCHER.STOCK_CREATE_HOST_INFERENCE, patched_text)
            self.assertEqual(patched_text.count(PATCHER.CREATE_CURSOR_SAND_ANCHOR), 1)
            self.assertEqual(
                patched_text.count("// src/host/extensions/inference/cursor-session.ts\ninit_dist9();"),
                1,
            )
            self.assertTrue(patched_text.endswith("//# sourceMappingURL=host-main.cjs.map\n"))
            injection = PATCHER._extract_injection_block(patched_text)
            self.assertNotIn("sk-", injection)
            self.assertNotIn("apiKey", injection)
            self.assertEqual(
                hashlib.sha256(STOCK_BUNDLE_PATH.read_bytes()).hexdigest(),
                PATCHER.STOCK_SHA256,
            )
            manifest_path = Path(report["backupManifest"])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["input"]["sha256"], PATCHER.STOCK_SHA256)
            self.assertEqual(manifest["stockSha256Expected"], PATCHER.STOCK_SHA256)
            self.assertEqual(manifest["anchors"]["transcribe_patched"]["expected"], 0)
            self.assertEqual(manifest["anchors"]["transcribe_patched"]["output"], 0)
            self.assertEqual(manifest["output"]["sha256"], report["outputSha256"])
            artifact = Path(manifest["rollbackArtifact"])
            self.assertEqual(hashlib.sha256(artifact.read_bytes()).hexdigest(), PATCHER.STOCK_SHA256)
            node_check(output)
            node_check(REAL_SESSION_PATH)
            for name in PATCHER.PROTOCOL_SOURCE_NAMES:
                node_check(REAL_PROTOCOLS_DIR / name)
            second_report = PATCHER.patch_host_bundle(
                output, REAL_PROTOCOLS_DIR, REAL_SESSION_PATH, second, backup_dir
            )
            self.assertTrue(second_report["idempotent"])
            self.assertFalse(second_report["changed"])
            self.assertEqual(second.read_bytes(), patched)
            self.assertEqual(second_report["recognizedStockSha256"], PATCHER.STOCK_SHA256)


@unittest.skipUnless(CURRENT_HOST_PATH.is_file(), "pinned 17184bb bundle absent")
class CurrentHostTests(unittest.TestCase):
    def test_current_host_patch_idempotence_manifest_and_syntax(self):
        raw = CURRENT_HOST_PATH.read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(), PATCHER.HOST_17184BB_SHA256)
        text = raw.decode("utf-8")
        self.assertEqual(text.count(PATCHER.INJECTION_ANCHOR), 1)
        self.assertEqual(text.count(PATCHER.STOCK_CREATE_HOST_INFERENCE), 1)
        self.assertEqual(text.count(PATCHER.CREATE_CURSOR_SAND_ANCHOR), 1)
        self.assertEqual(text.count(PATCHER.TRANSCRIBE_FN_ANCHOR), 1)
        self.assertEqual(text.count(PATCHER.STOCK_CREATE_SAND_TRANSCRIBE_AUDIO), 1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output, second = root / "patched.cjs", root / "second.cjs"
            first = PATCHER.patch_host_bundle(CURRENT_HOST_PATH, REAL_PROTOCOLS_DIR, REAL_SESSION_PATH, output, root / "backup")
            again = PATCHER.patch_host_bundle(output, REAL_PROTOCOLS_DIR, REAL_SESSION_PATH, second, root / "backup")
            self.assertTrue(first["changed"])
            self.assertTrue(again["idempotent"])
            self.assertEqual(output.read_bytes(), second.read_bytes())
            self.assertIn("recordFollowupLabeling: function (_args) {}", output.read_text())
            self.assertEqual(output.read_text().count(PATCHER.PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO), 1)
            for report in (first, again):
                manifest = json.loads(Path(report["backupManifest"]).read_text())
                self.assertEqual(report["recognizedStockSha256"], PATCHER.HOST_17184BB_SHA256)
                self.assertEqual(manifest["stockSha256Expected"], PATCHER.HOST_17184BB_SHA256)
                self.assertEqual(manifest["anchors"]["transcribe_patched"]["expected"], 1)
                self.assertEqual(manifest["anchors"]["transcribe_patched"]["output"], 1)
            self.assertEqual(CURRENT_HOST_PATH.read_bytes(), raw)
            node_check(output)
            unguarded = root / "unguarded.cjs"
            unguarded.write_text(output.read_text().replace(PATCHER.PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO, PATCHER.STOCK_CREATE_SAND_TRANSCRIBE_AUDIO))
            with self.assertRaisesRegex(PATCHER.PatchError, "patched createSandTranscribeAudio anchor mismatch"):
                PATCHER.patch_host_bundle(unguarded, REAL_PROTOCOLS_DIR, REAL_SESSION_PATH, root / "bad.cjs", root / "bad-backup")
            self.assertFalse((root / "bad.cjs").exists())


if __name__ == "__main__":
    unittest.main()
