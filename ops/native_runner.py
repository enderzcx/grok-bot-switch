"""Fixed native-bridge entrypoint. No arbitrary shell or credential output."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

PACKAGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE))

from grokctl.profiles import atomic_replace, ensure_private_dir, _file_is_private_regular
from ops.native_controller import NativeHost
from ops.patch_grok_host_provider_switcher import (
    SUPPORTED_STOCK_SHA256, apply_patch,
    load_protocol_sources,
)

ROOT = Path("/workspace/grok-home")
MAX_REQUEST = 64 * 1024


def artifacts(host: NativeHost) -> dict:
    """Create only separate immutable artifacts; never install or restart."""
    host._assert_supervisor()
    entry = host.host_entry
    if entry.is_symlink() or not entry.is_file() or entry.stat().st_size > 64 * 1024 * 1024:
        raise ValueError("invalid-host-bundle")
    raw = entry.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    artifacts_dir = ensure_private_dir(ROOT / "product-artifacts")
    protocols = load_protocol_sources(PACKAGE / "src/provider_protocols")
    session = (PACKAGE / "src/provider-direct-session.cjs").read_text()
    # A previous activation may already have installed this exact source set.
    for stock_sha in sorted(SUPPORTED_STOCK_SHA256):
        stock = artifacts_dir / (stock_sha + ".stock.cjs")
        if digest == stock_sha:
            if stock.exists() and hashlib.sha256(stock.read_bytes()).hexdigest() != stock_sha:
                raise ValueError("artifact-conflict")
            if not stock.exists():
                atomic_replace(stock, raw)
        elif not stock.exists():
            continue
        original = stock.read_bytes()
        if hashlib.sha256(original).hexdigest() != stock_sha:
            raise ValueError("artifact-conflict")
        patched = apply_patch(original.decode(), protocols, session).encode()
        patched_sha = hashlib.sha256(patched).hexdigest()
        if digest not in (stock_sha, patched_sha):
            continue
        target = artifacts_dir / (patched_sha + ".patched.cjs")
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() != patched_sha:
            raise ValueError("artifact-conflict")
        if not target.exists():
            atomic_replace(target, patched)
        subprocess.run(["node", "--check", str(target)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        return {"stock_bundle": stock, "patched_bundle": target,
                "stock_sha256": stock_sha, "patched_sha256": patched_sha}
    raise ValueError("unknown-host-bundle")


def _private_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    _file_is_private_regular(path)
    if path.stat().st_size > 256 * 1024:
        raise ValueError("invalid-state")
    result = json.loads(path.read_bytes())
    if not isinstance(result, dict):
        raise ValueError("invalid-state")
    return result


def inspect(host: NativeHost) -> dict:
    """Fresh readback only: this never advances a pending transaction."""
    observation = host.read_observation()
    active = _private_json(ROOT / "native-active.json")
    job = _private_json(ROOT / "native-job.json")
    config_path = ROOT / "config/external.json"
    config = _private_json(config_path)
    config_hash = hashlib.sha256(config_path.read_bytes()).hexdigest() if config is not None else None
    blocking = []
    try:
        host._assert_supervisor()
    except Exception:
        blocking.append("unsupported-supervisor")
    current = None
    if observation["health"] is not True:
        blocking.append("host-unreachable")
    elif active is None and observation["hostBundleSha256"] in SUPPORTED_STOCK_SHA256 and config is None:
        current = "official"
    elif active is not None and active.get("verified") is True:
        matches = all(observation.get(key) == active.get(key) for key in ("pid", "startedAt", "hostBundleSha256"))
        matches = matches and config_hash == active.get("configDigest")
        if matches and active.get("hop") is not None:
            try:
                from ops.native_hop import HopManager
                health = HopManager(PACKAGE).health(active["hop"])
                matches = health["profileId"] == active["target"] and health["profileDigest"] == active["profileDigest"] and health["generation"] == active["generation"]
            except Exception:
                matches = False
        if matches:
            current = active["target"]
        else:
            blocking.append("active-state-drift")
    else:
        blocking.append("unknown-host-state")
    if observation["isBusy"] is not False:
        blocking.append("busy-agent")
    if observation["pendingCommand"] is not None:
        blocking.append("pending-command")
    if job and job.get("status") not in ("verified", "failed"):
        blocking.append("activation-in-progress")
    return {"ok": True, "providerSwitchReady": not blocking,
            "runtimeKind": "native-host", "activeProfile": current,
            "desiredProfile": (job or {}).get("target") or current or "official",
            "previousProfile": ((job or {}).get("previousActive") or {}).get("target", "official") if job and job.get("status") == "verified" else None,
            "profileDigest": (active or {}).get("profileDigest"), "blocking": blocking,
            "observation": observation,
            "activation": {key: job.get(key) for key in ("id", "status", "phase", "error", "target", "generation")} if job else None}


def dispatch(request: dict) -> dict:
    host = NativeHost()
    action = request.get("action")
    if action == "inspect":
        return inspect(host)
    if action == "setup":
        ready = artifacts(host)
        return {"ok": True, "stockSha256": ready["stock_sha256"],
                "patchedSha256": ready["patched_sha256"], "providerSwitchReady": False}
    if action not in ("plan", "begin", "progress"):
        raise ValueError("unknown-action")
    from ops.native_activation import NativeActivation
    from ops.native_hop import HopManager
    ready = artifacts(host)
    activation = NativeActivation(ROOT, host, ready["stock_bundle"], ready["patched_bundle"],
                                  HopManager(PACKAGE), stock_sha256=ready["stock_sha256"],
                                  patched_sha256=ready["patched_sha256"])
    if action == "plan":
        return activation.plan(request.get("profile"))
    if action == "begin":
        return activation.begin(request.get("profile"), secret=request.get("secret"))
    return activation.progress()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    args = parser.parse_args()
    request_path = args.request
    # Native bridge creates a fresh UUID directory for this single request.
    requests = ROOT / "product-requests"
    if request_path.name != "request.json" or request_path.parent.parent != requests:
        raise ValueError("invalid-request-path")
    _file_is_private_regular(request_path)
    if request_path.stat().st_size > MAX_REQUEST:
        raise ValueError("request-too-large")
    try:
        request = json.loads(request_path.read_bytes())
        if not isinstance(request, dict):
            raise ValueError("invalid-request")
        result = dispatch(request)
    except Exception:
        # Never print exception text: provider validation can involve secret input.
        result = {"ok": False, "error": "native-operation-failed"}
    finally:
        request_path.unlink(missing_ok=True)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
