#!/usr/bin/env python3
"""Deterministic, hash-fenced Grok Bot provider-switcher patcher.

Injects the generic protocol source modules plus provider-direct-session, then
wraps createHostInference. Never edits the stock bundle in place. Output is
always a separate file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Mapping, Optional, Sequence


STOCK_SHA256 = "3c3f986e614aaf8fbec642269da40dd20f1dbd9912bdf8f2390bafd61ec684ef"
HOST_17184BB_SHA256 = "0035c31a74ac9d7fc9d93532cf37e217d6074143d46b1eeb3c5e79699df2f88f"
HOST_DE429DC_SHA256 = "12df7a63cf7d0eb153697fbfc18494cf4f44eff4f0a1d086703a8c7e8043e1d0"
SUPPORTED_STOCK_SHA256 = frozenset((STOCK_SHA256, HOST_17184BB_SHA256, HOST_DE429DC_SHA256))
STOCK_BUNDLE_PATH = Path("/Users/sunny/Work/CODEX/grok_home/research/current-0.30/host-main.cjs")

MARKER_BEGIN = "// GROK_HOME_PROVIDER_SWITCHER_BEGIN"
MARKER_END = "// GROK_HOME_PROVIDER_SWITCHER_END"

INJECTION_ANCHOR = (
    "// src/host/extensions/inference/cursor-session.ts\n"
    "function resolveSandRequestedModel(inputs) {"
)

CREATE_CURSOR_SAND_ANCHOR = "function createCursorSandInference(options2) {"

WRAP_FN_DEF_ANCHOR = "function wrapHostInferenceWithProviderSwitcher"

PROTOCOL_SOURCE_NAMES: Sequence[str] = (
    "contract.cjs",
    "sse.cjs",
    "tools.cjs",
    "openai-chat.cjs",
    "openai-responses.cjs",
    "anthropic-messages.cjs",
    "index.cjs",
)

STOCK_CREATE_HOST_INFERENCE = """function createHostInference(options2) {
  const { auth: auth2, experiments, settings } = options2;
  return createCursorSandInference({
    getAccessToken: auth2.getAccessToken,
    getTeamId: auth2.getTeamId,
    getMachineId: auth2.getMachineId,
    isGeminiVideoDeveloperApiEnabled: () => experiments.checkFeatureGate("gemini_video_developer_api", { disableExposureLog: true }),
    getDefaultModel: () => settings.getAgentDefaultModel(),
    getComputerUseModel: () => resolveComputerUseModelSelection({
      storedModel: settings.getComputerUseModel(),
      overrideModel: experiments.getComputerUseModelOverride()
    }),
    getBrowserUseModel: () => experiments.getBrowserUseModelOverride(),
    getModelExperimentState: () => {
      const state = experiments.getSandModelExperimentState();
      if (experiments.hasHydratedStatsigUserId()) {
        options2.onModelExperimentApplied();
      }
      return state;
    },
    getConfiguredDefaultModel: () => experiments.getConfiguredDefaultModel(),
    getConfiguredAutomationsModel: () => experiments.getConfiguredAutomationsModel()
  });
}"""

PATCHED_CREATE_HOST_INFERENCE = """function createHostInference(options2) {
  const { auth: auth2, experiments, settings } = options2;
  const cursorInference = createCursorSandInference({
    getAccessToken: auth2.getAccessToken,
    getTeamId: auth2.getTeamId,
    getMachineId: auth2.getMachineId,
    isGeminiVideoDeveloperApiEnabled: () => experiments.checkFeatureGate("gemini_video_developer_api", { disableExposureLog: true }),
    getDefaultModel: () => settings.getAgentDefaultModel(),
    getComputerUseModel: () => resolveComputerUseModelSelection({
      storedModel: settings.getComputerUseModel(),
      overrideModel: experiments.getComputerUseModelOverride()
    }),
    getBrowserUseModel: () => experiments.getBrowserUseModelOverride(),
    getModelExperimentState: () => {
      const state = experiments.getSandModelExperimentState();
      if (experiments.hasHydratedStatsigUserId()) {
        options2.onModelExperimentApplied();
      }
      return state;
    },
    getConfiguredDefaultModel: () => experiments.getConfiguredDefaultModel(),
    getConfiguredAutomationsModel: () => experiments.getConfiguredAutomationsModel()
  });
  return wrapHostInferenceWithProviderSwitcher(cursorInference, { settings, experiments, auth: auth2 });
}"""

# Absent in the original pinned .30 bundle; present exactly once in 17184bb.
# Guard invocation belongs inside the returned function, never host boot.
TRANSCRIBE_FN_ANCHOR = "function createSandTranscribeAudio("
STOCK_CREATE_SAND_TRANSCRIBE_AUDIO = """function createSandTranscribeAudio(auth2, options2, createClient2 = createSandCursorBackendClient) {
  const onRequestId = options2?.onRequestId;
  let client;
  const getClient = () => {
    client ??= createClient2(AiService, {
      getAccessToken: auth2.getAccessToken,
      getTeamId: auth2.getTeamId,
      getMachineId: auth2.getMachineId,
      ...onRequestId == null ? {} : { onRequestId }
    });
    return client;
  };
  return async (request3) => {
    const language = request3.language != null && request3.language.length > 0 ? toWhisperLanguageHint(request3.language) : void 0;
    const response = await transcribeDeadline.run(
      (signal) => getClient().transcribeAudio(
        new TranscribeAudioRequest({
          audio: new Uint8Array(request3.audio),
          mimeType: stripMimeParameters(request3.mimeType),
          ...language == null ? {} : { language }
        }),
        { signal }
      )
    );
    return {
      text: response.text,
      transcriptionTimeMs: Number(response.transcriptionTimeMs)
    };
  };
}"""
PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO = STOCK_CREATE_SAND_TRANSCRIBE_AUDIO.replace(
    "  return async (request3) => {\n",
    "  return async (request3) => {\n    assertProviderDirectNativeAudioAllowed();\n",
    1,
)

SOURCEMAP_ANCHOR = "//# sourceMappingURL=host-main.cjs.map"

CJS_RUNTIME = """var __grokProviderModules = Object.create(null);
function __grokProviderRequire(id) {
  if (!Object.prototype.hasOwnProperty.call(__grokProviderModules, id)) {
    throw new Error("Unknown injected provider protocol module");
  }
  return __grokProviderModules[id];
}
function __grokProviderRegister(id, factory) {
  if (Object.prototype.hasOwnProperty.call(__grokProviderModules, id)) {
    throw new Error("Duplicate injected provider protocol module");
  }
  var module = { exports: {} };
  factory(module, module.exports, __grokProviderRequire);
  __grokProviderModules[id] = module.exports;
}
"""


class PatchError(RuntimeError):
    """Fail-closed patcher error. Messages must not contain credentials."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _read_bytes(path: Path, label: str) -> bytes:
    if not path.is_file():
        raise PatchError(f"{label} is not a file: {path}")
    return path.read_bytes()


def _decode_utf8(raw: bytes, label: str) -> str:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PatchError(f"{label} is not valid UTF-8: {exc}") from exc
    if text.encode("utf-8") != raw:
        raise PatchError(f"{label} is not a strict UTF-8 round trip")
    return text


def normalize_injected_source(text: str, label: str) -> str:
    if text.startswith("\ufeff"):
        text = text[1:]
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise PatchError(f"{label} is empty")
    if not text.endswith("\n"):
        text += "\n"
    return text


def protocol_module_id(filename: str) -> str:
    return "./" + filename


def wrap_protocol_source(filename: str, source: str) -> str:
    module_id = json.dumps(protocol_module_id(filename), ensure_ascii=True)
    return (
        "__grokProviderRegister("
        + module_id
        + ", function (module, exports, require) {\n"
        + source
        + "});\n"
    )


def build_injection_block(protocol_sources: Mapping[str, str], session_source: str) -> str:
    parts = [MARKER_BEGIN + "\n", CJS_RUNTIME]
    for name in PROTOCOL_SOURCE_NAMES:
        parts.append(wrap_protocol_source(name, protocol_sources[name]))
    parts.append(session_source)
    parts.append(MARKER_END + "\n")
    return "".join(parts)


def anchor_counts(text: str) -> Dict[str, int]:
    return {
        "injection_anchor": text.count(INJECTION_ANCHOR),
        "create_host_stock": text.count(STOCK_CREATE_HOST_INFERENCE),
        "create_host_patched": text.count(PATCHED_CREATE_HOST_INFERENCE),
        "marker_begin": text.count(MARKER_BEGIN),
        "marker_end": text.count(MARKER_END),
        "create_cursor_sand": text.count(CREATE_CURSOR_SAND_ANCHOR),
        "sourcemap": text.count(SOURCEMAP_ANCHOR),
        "transcribe_fn": text.count(TRANSCRIBE_FN_ANCHOR),
        "transcribe_stock": text.count(STOCK_CREATE_SAND_TRANSCRIBE_AUDIO),
        "transcribe_patched": text.count(PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO),
    }


def _extract_injection_block(text: str) -> str:
    begin = text.find(MARKER_BEGIN)
    end = text.find(MARKER_END)
    if begin < 0 or end < 0 or end < begin:
        raise PatchError("partial/ambiguous marker placement")
    if text.find(MARKER_BEGIN, begin + len(MARKER_BEGIN)) != -1:
        raise PatchError("injection marker begin count is ambiguous")
    if text.find(MARKER_END, end + len(MARKER_END)) != -1:
        raise PatchError("injection marker end count is ambiguous")
    end_pos = end + len(MARKER_END)
    if end_pos < len(text) and text[end_pos] == "\n":
        end_pos += 1
    return text[begin:end_pos]


def _validate_injected_sources(protocol_sources: Mapping[str, str], session_source: str) -> None:
    expected = set(PROTOCOL_SOURCE_NAMES)
    actual = set(protocol_sources)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise PatchError(
            "protocol sources mismatch missing="
            + ",".join(missing)
            + " extra="
            + ",".join(extra)
        )
    combined_protocols = "".join(protocol_sources[name] for name in PROTOCOL_SOURCE_NAMES)
    for needle, name in (
        (MARKER_BEGIN, "marker begin"),
        (MARKER_END, "marker end"),
        (INJECTION_ANCHOR, "injection anchor"),
        (STOCK_CREATE_HOST_INFERENCE, "stock createHostInference"),
        (PATCHED_CREATE_HOST_INFERENCE, "patched createHostInference"),
        (STOCK_CREATE_SAND_TRANSCRIBE_AUDIO, "stock createSandTranscribeAudio"),
        (PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO, "patched createSandTranscribeAudio"),
        (WRAP_FN_DEF_ANCHOR, "session wrap function"),
    ):
        if needle in combined_protocols:
            raise PatchError(f"protocol sources must not contain the {name}")
        if needle in session_source and needle not in (
            WRAP_FN_DEF_ANCHOR,
        ):
            if needle in (MARKER_BEGIN, MARKER_END, INJECTION_ANCHOR, STOCK_CREATE_HOST_INFERENCE, PATCHED_CREATE_HOST_INFERENCE, STOCK_CREATE_SAND_TRANSCRIBE_AUDIO, PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO):
                raise PatchError(f"injected sources must not contain the {name}")
    for name, source in protocol_sources.items():
        if "module.exports" not in source:
            raise PatchError(f"protocol source {name} must assign module.exports")
    if "module.exports" in session_source:
        raise PatchError("injected source must not assign module.exports")
    wrap_defs = session_source.count(WRAP_FN_DEF_ANCHOR)
    if wrap_defs != 1:
        raise PatchError(
            f"session source {WRAP_FN_DEF_ANCHOR} count={wrap_defs}, expected 1"
        )


def classify_bundle(text: str, expected_injection: str) -> str:
    counts = anchor_counts(text)
    begin = counts["marker_begin"]
    end = counts["marker_end"]
    if counts["transcribe_fn"] not in (0, 1):
        raise PatchError("createSandTranscribeAudio anchor count is ambiguous")
    expected_transcribe = counts["transcribe_fn"]

    if begin == 0 and end == 0:
        if counts["transcribe_stock"] != expected_transcribe or counts["transcribe_patched"] != 0:
            raise PatchError("stock createSandTranscribeAudio anchor mismatch")
        if counts["create_host_patched"] != 0:
            raise PatchError("createHostInference wrap present without injection marker")
        if counts["injection_anchor"] != 1:
            raise PatchError(
                f"injection anchor count={counts['injection_anchor']}, expected 1"
            )
        if counts["create_host_stock"] != 1:
            raise PatchError(
                f"stock createHostInference count={counts['create_host_stock']}, expected 1"
            )
        if counts["create_cursor_sand"] != 1:
            raise PatchError(
                f"createCursorSandInference count={counts['create_cursor_sand']}, expected 1"
            )
        return "unpatched"

    if begin != 1 or end != 1:
        raise PatchError(
            f"partial/ambiguous injection marker begin={begin} end={end}, expected 0 or 1"
        )

    payload = _extract_injection_block(text)
    if payload != expected_injection:
        raise PatchError(
            "injection marker is present but payload does not match the current protocol/session sources"
        )
    if expected_injection + INJECTION_ANCHOR not in text:
        raise PatchError(
            "injection is not immediately before the cursor-session.ts function area"
        )
    if counts["create_host_stock"] != 0 or counts["create_host_patched"] != 1:
        raise PatchError(
            "partial/ambiguous createHostInference wrap "
            f"stock={counts['create_host_stock']} patched={counts['create_host_patched']}"
        )
    if counts["injection_anchor"] != 1:
        raise PatchError(
            f"injection anchor count={counts['injection_anchor']}, expected 1 after patch"
        )
    if counts["create_cursor_sand"] != 1:
        raise PatchError(
            f"createCursorSandInference count={counts['create_cursor_sand']}, expected 1"
        )
    if counts["transcribe_patched"] != expected_transcribe or counts["transcribe_stock"] != 0:
        raise PatchError("patched createSandTranscribeAudio anchor mismatch")
    return "patched"


def apply_patch(
    source: str,
    protocol_sources: Mapping[str, str],
    session_source: str,
) -> str:
    """Return the patched host bundle text. Idempotent for a correctly patched input."""
    normalized_protocols = {}
    for name in PROTOCOL_SOURCE_NAMES:
        if name not in protocol_sources:
            raise PatchError(f"protocol source {name} is missing")
        normalized_protocols[name] = normalize_injected_source(
            protocol_sources[name], f"protocol source {name}"
        )
    session = normalize_injected_source(session_source, "session source")
    _validate_injected_sources(normalized_protocols, session)
    expected_injection = build_injection_block(normalized_protocols, session)

    state = classify_bundle(source, expected_injection)
    if state == "patched":
        return source

    patched = source.replace(INJECTION_ANCHOR, expected_injection + INJECTION_ANCHOR, 1)
    patched = patched.replace(
        STOCK_CREATE_HOST_INFERENCE, PATCHED_CREATE_HOST_INFERENCE, 1
    )
    patched = patched.replace(
        STOCK_CREATE_SAND_TRANSCRIBE_AUDIO, PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO, 1
    )
    if classify_bundle(patched, expected_injection) != "patched":
        raise PatchError("patched output failed postcondition classification")
    if SOURCEMAP_ANCHOR in source and SOURCEMAP_ANCHOR not in patched:
        raise PatchError("source-map comment was not preserved")
    return patched


def load_protocol_sources(protocols_dir: Path) -> Dict[str, str]:
    protocols_dir = Path(protocols_dir)
    if not protocols_dir.is_dir():
        raise PatchError(f"protocols directory is not a directory: {protocols_dir}")
    loaded: Dict[str, str] = {}
    for name in PROTOCOL_SOURCE_NAMES:
        path = protocols_dir / name
        raw = _read_bytes(path, f"protocol source {name}")
        loaded[name] = _decode_utf8(raw, f"protocol source {name}")
    return loaded


def write_rollback_artifacts(
    backup_dir: Path,
    *,
    input_path: Path,
    output_path: Path,
    input_raw: bytes,
    patched_text: str,
    protocols_dir: Path,
    session_path: Path,
    protocol_raws: Mapping[str, bytes],
    session_raw: bytes,
    idempotent: bool,
    input_counts: Mapping[str, int],
    output_counts: Mapping[str, int],
    recognized_stock_sha256: str,
) -> Path:
    """Write a hash-named original copy plus JSON manifest. No credential fields."""
    backup_dir.mkdir(parents=True, exist_ok=True)
    original_sha = sha256_hex(input_raw)
    patched_bytes = patched_text.encode("utf-8")
    patched_sha = sha256_hex(patched_bytes)
    artifact_path = backup_dir / f"{original_sha}.cjs"
    manifest_path = backup_dir / f"{original_sha}.manifest.json"
    artifact_path.write_bytes(input_raw)
    if sha256_hex(artifact_path.read_bytes()) != original_sha:
        raise PatchError("rollback artifact hash mismatch")
    protocol_sources_meta = {}
    for name in PROTOCOL_SOURCE_NAMES:
        raw = protocol_raws[name]
        protocol_sources_meta[name] = {
            "path": str((protocols_dir / name).resolve()),
            "sha256": sha256_hex(raw),
            "size": len(raw),
        }
    manifest = {
        "schemaVersion": 1,
        "kind": "grok-host-provider-switcher-backup",
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stockSha256Expected": recognized_stock_sha256,
        "idempotent": idempotent,
        "input": {
            "path": str(input_path.resolve()),
            "sha256": original_sha,
            "size": len(input_raw),
        },
        "output": {
            "path": str(output_path.resolve()),
            "sha256": patched_sha,
            "size": len(patched_bytes),
        },
        "sources": {
            "protocolsDir": str(Path(protocols_dir).resolve()),
            "protocols": protocol_sources_meta,
            "session": {
                "path": str(session_path.resolve()),
                "sha256": sha256_hex(session_raw),
                "size": len(session_raw),
            },
        },
        "anchors": {
            "injection_anchor": {
                "expected": 1,
                "input": input_counts["injection_anchor"],
                "output": output_counts["injection_anchor"],
            },
            "create_host_stock": {
                "expected": 1,
                "input": input_counts["create_host_stock"],
                "output": output_counts["create_host_stock"],
            },
            "create_host_patched": {
                "expected": 1,
                "input": input_counts["create_host_patched"],
                "output": output_counts["create_host_patched"],
            },
            "marker_begin": {
                "expected": 1,
                "input": input_counts["marker_begin"],
                "output": output_counts["marker_begin"],
            },
            "marker_end": {
                "expected": 1,
                "input": input_counts["marker_end"],
                "output": output_counts["marker_end"],
            },
            "create_cursor_sand": {
                "expected": 1,
                "input": input_counts["create_cursor_sand"],
                "output": output_counts["create_cursor_sand"],
            },
            "transcribe_patched": {
                "expected": input_counts["transcribe_fn"],
                "input": input_counts["transcribe_patched"],
                "output": output_counts["transcribe_patched"],
            },
        },
        "rollbackArtifact": str(artifact_path.resolve()),
        "backupManifest": str(manifest_path.resolve()),
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest_path


def patch_host_bundle(
    stock_path: Path,
    protocols_dir: Path,
    session_path: Path,
    output_path: Path,
    backup_dir: Path,
) -> Dict[str, object]:
    stock_path = Path(stock_path)
    protocols_dir = Path(protocols_dir)
    session_path = Path(session_path)
    output_path = Path(output_path)
    backup_dir = Path(backup_dir)

    if stock_path.resolve() == output_path.resolve():
        raise PatchError(
            "refusing in-place edit; output path must differ from the input bundle"
        )

    input_raw = _read_bytes(stock_path, "stock bundle")
    input_sha = sha256_hex(input_raw)
    source = _decode_utf8(input_raw, "stock bundle")
    protocol_raws: Dict[str, bytes] = {}
    protocol_texts: Dict[str, str] = {}
    for name in PROTOCOL_SOURCE_NAMES:
        raw = _read_bytes(protocols_dir / name, f"protocol source {name}")
        protocol_raws[name] = raw
        protocol_texts[name] = _decode_utf8(raw, f"protocol source {name}")
    session_raw = _read_bytes(session_path, "session source")
    session_text = _decode_utf8(session_raw, "session source")

    # Idempotence must not turn marker presence into an unknown-host bypass.
    # Reverse only our exact transformations, then fence the stock bytes;
    # apply_patch below separately validates the full current injection payload.
    stock_source = source
    if MARKER_BEGIN in source or MARKER_END in source:
        stock_source = stock_source.replace(_extract_injection_block(source), "", 1)
        stock_source = stock_source.replace(
            PATCHED_CREATE_HOST_INFERENCE, STOCK_CREATE_HOST_INFERENCE, 1
        )
        stock_source = stock_source.replace(
            PATCHED_CREATE_SAND_TRANSCRIBE_AUDIO, STOCK_CREATE_SAND_TRANSCRIBE_AUDIO, 1
        )
    recognized_stock_sha256 = sha256_hex(stock_source.encode("utf-8"))
    if recognized_stock_sha256 not in SUPPORTED_STOCK_SHA256:
        raise PatchError(
            f"stock SHA-256 mismatch: got {recognized_stock_sha256}, "
            + "expected one of " + ", ".join(sorted(SUPPORTED_STOCK_SHA256))
        )

    input_counts = anchor_counts(source)
    patched = apply_patch(source, protocol_texts, session_text)
    output_counts = anchor_counts(patched)
    idempotent = patched == source
    patched_bytes = patched.encode("utf-8")

    manifest_path = write_rollback_artifacts(
        backup_dir,
        input_path=stock_path,
        output_path=output_path,
        input_raw=input_raw,
        patched_text=patched,
        protocols_dir=protocols_dir,
        session_path=session_path,
        protocol_raws=protocol_raws,
        session_raw=session_raw,
        idempotent=idempotent,
        input_counts=input_counts,
        output_counts=output_counts,
        recognized_stock_sha256=recognized_stock_sha256,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(output_path.name + ".patch-tmp")
    tmp_path.write_bytes(patched_bytes)
    tmp_path.replace(output_path)

    return {
        "changed": not idempotent,
        "idempotent": idempotent,
        "inputSha256": input_sha,
        "recognizedStockSha256": recognized_stock_sha256,
        "outputSha256": sha256_hex(patched_bytes),
        "outputSize": len(patched_bytes),
        "backupManifest": str(manifest_path.resolve()),
        "anchors": output_counts,
    }


def _print_report(report: Mapping[str, object]) -> None:
    print("changed=" + str(report["changed"]).lower())
    print("idempotent=" + str(report["idempotent"]).lower())
    print("input_sha256=" + str(report["inputSha256"]))
    print("output_sha256=" + str(report["outputSha256"]))
    print("backup_manifest=" + str(report["backupManifest"]))


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Patch a recognized hash-pinned Grok Bot host bundle with the generic provider switcher."
    )
    parser.add_argument("--stock", type=Path, required=True, help="stock host-main.cjs path")
    parser.add_argument(
        "--protocols-dir",
        type=Path,
        required=True,
        help="directory containing provider_protocols/*.cjs sources",
    )
    parser.add_argument(
        "--session", type=Path, required=True, help="provider-direct-session.cjs path"
    )
    parser.add_argument("--output", type=Path, required=True, help="patched output path")
    parser.add_argument(
        "--backup-dir", type=Path, required=True, help="hash-named backup directory"
    )
    args = parser.parse_args(argv)
    try:
        report = patch_host_bundle(
            stock_path=args.stock,
            protocols_dir=args.protocols_dir,
            session_path=args.session,
            output_path=args.output,
            backup_dir=args.backup_dir,
        )
    except PatchError as exc:
        print("error=" + str(exc), file=sys.stderr)
        return 1
    _print_report(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
