#!/usr/bin/env python3
"""Deterministic, version-fenced Grok Bot 0.30 direct-executor patcher.

Injects the BeefAPI wire and session sources, then wraps createHostInference.
Never edits the stock bundle in place. Output is always a separate file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Mapping, Optional


STOCK_SHA256 = "3c3f986e614aaf8fbec642269da40dd20f1dbd9912bdf8f2390bafd61ec684ef"
STOCK_BUNDLE_PATH = Path("/Users/sunny/Work/CODEX/grok_home/research/current-0.30/host-main.cjs")

MARKER_BEGIN = "// GROK_HOME_BEEFAPI_DIRECT_EXECUTOR_BEGIN"
MARKER_END = "// GROK_HOME_BEEFAPI_DIRECT_EXECUTOR_END"

INJECTION_ANCHOR = (
    "// src/host/extensions/inference/cursor-session.ts\n"
    "function resolveSandRequestedModel(inputs) {"
)

CREATE_CURSOR_SAND_ANCHOR = "function createCursorSandInference(options2) {"

WRAP_FN_DEF_ANCHOR = "function wrapHostInferenceWithBeefApiDirect"

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
  return wrapHostInferenceWithBeefApiDirect(cursorInference, { settings, experiments, auth: auth2 });
}"""

SOURCEMAP_ANCHOR = "//# sourceMappingURL=host-main.cjs.map"


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


def build_injection_block(wire_source: str, session_source: str) -> str:
    return f"{MARKER_BEGIN}\n{wire_source}{session_source}{MARKER_END}\n"


def anchor_counts(text: str) -> Dict[str, int]:
    return {
        "injection_anchor": text.count(INJECTION_ANCHOR),
        "create_host_stock": text.count(STOCK_CREATE_HOST_INFERENCE),
        "create_host_patched": text.count(PATCHED_CREATE_HOST_INFERENCE),
        "marker_begin": text.count(MARKER_BEGIN),
        "marker_end": text.count(MARKER_END),
        "create_cursor_sand": text.count(CREATE_CURSOR_SAND_ANCHOR),
        "sourcemap": text.count(SOURCEMAP_ANCHOR),
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


def _validate_injected_sources(wire_source: str, session_source: str) -> None:
    combined = wire_source + session_source
    for needle, name in (
        (MARKER_BEGIN, "marker begin"),
        (MARKER_END, "marker end"),
        (INJECTION_ANCHOR, "injection anchor"),
        (STOCK_CREATE_HOST_INFERENCE, "stock createHostInference"),
        (PATCHED_CREATE_HOST_INFERENCE, "patched createHostInference"),
    ):
        if needle in combined:
            raise PatchError(f"injected sources must not contain the {name}")
    if "module.exports" in combined:
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

    if begin == 0 and end == 0:
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
            "injection marker is present but payload does not match the current wire/session sources"
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
    return "patched"


def apply_patch(source: str, wire_source: str, session_source: str) -> str:
    """Return the patched host bundle text. Idempotent for a correctly patched input."""
    wire = normalize_injected_source(wire_source, "wire source")
    session = normalize_injected_source(session_source, "session source")
    _validate_injected_sources(wire, session)
    expected_injection = build_injection_block(wire, session)

    state = classify_bundle(source, expected_injection)
    if state == "patched":
        return source

    patched = source.replace(INJECTION_ANCHOR, expected_injection + INJECTION_ANCHOR, 1)
    patched = patched.replace(
        STOCK_CREATE_HOST_INFERENCE, PATCHED_CREATE_HOST_INFERENCE, 1
    )
    if classify_bundle(patched, expected_injection) != "patched":
        raise PatchError("patched output failed postcondition classification")
    if SOURCEMAP_ANCHOR in source and SOURCEMAP_ANCHOR not in patched:
        raise PatchError("source-map comment was not preserved")
    return patched


def write_rollback_artifacts(
    backup_dir: Path,
    *,
    input_path: Path,
    output_path: Path,
    input_raw: bytes,
    patched_text: str,
    wire_path: Path,
    session_path: Path,
    wire_raw: bytes,
    session_raw: bytes,
    idempotent: bool,
    input_counts: Mapping[str, int],
    output_counts: Mapping[str, int],
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
    manifest = {
        "schemaVersion": 1,
        "kind": "grok-host-direct-executor-backup",
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stockSha256Expected": STOCK_SHA256,
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
            "wire": {
                "path": str(wire_path.resolve()),
                "sha256": sha256_hex(wire_raw),
                "size": len(wire_raw),
            },
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
    wire_path: Path,
    session_path: Path,
    output_path: Path,
    backup_dir: Path,
) -> Dict[str, object]:
    stock_path = Path(stock_path)
    wire_path = Path(wire_path)
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
    wire_raw = _read_bytes(wire_path, "wire source")
    session_raw = _read_bytes(session_path, "session source")
    wire_text = _decode_utf8(wire_raw, "wire source")
    session_text = _decode_utf8(session_raw, "session source")

    if MARKER_BEGIN not in source and MARKER_END not in source:
        if input_sha != STOCK_SHA256:
            raise PatchError(
                f"stock SHA-256 mismatch: got {input_sha}, expected {STOCK_SHA256}"
            )

    input_counts = anchor_counts(source)
    patched = apply_patch(source, wire_text, session_text)
    output_counts = anchor_counts(patched)
    idempotent = patched == source
    patched_bytes = patched.encode("utf-8")

    manifest_path = write_rollback_artifacts(
        backup_dir,
        input_path=stock_path,
        output_path=output_path,
        input_raw=input_raw,
        patched_text=patched,
        wire_path=wire_path,
        session_path=session_path,
        wire_raw=wire_raw,
        session_raw=session_raw,
        idempotent=idempotent,
        input_counts=input_counts,
        output_counts=output_counts,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(output_path.name + ".patch-tmp")
    tmp_path.write_bytes(patched_bytes)
    tmp_path.replace(output_path)

    return {
        "changed": not idempotent,
        "idempotent": idempotent,
        "inputSha256": input_sha,
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
        description="Patch the pinned Grok Bot 0.30 host bundle with the BeefAPI direct executor."
    )
    parser.add_argument("--stock", type=Path, required=True, help="stock host-main.cjs path")
    parser.add_argument("--wire", type=Path, required=True, help="beefapi-openai-wire.cjs path")
    parser.add_argument(
        "--session", type=Path, required=True, help="beefapi-direct-session.cjs path"
    )
    parser.add_argument("--output", type=Path, required=True, help="patched output path")
    parser.add_argument(
        "--backup-dir", type=Path, required=True, help="hash-named backup directory"
    )
    args = parser.parse_args(argv)
    try:
        report = patch_host_bundle(
            stock_path=args.stock,
            wire_path=args.wire,
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
