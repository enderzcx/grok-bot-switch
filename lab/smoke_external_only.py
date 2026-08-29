#!/usr/bin/env python3
"""Run a credential-free external-only routing smoke and emit an audit report."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"
SANDBOX_HOME = ROOT / "sandbox-home"
UPSTREAM_SCRIPT = ROOT / "lab" / "fake_upstream.py"
HOP_SCRIPT = ROOT / "vendor" / "opengrok" / "tools" / "hop-server.py"
CONTRACT_PATH = ROOT / "config" / "external-only-contract.json"
BINDING_TEMPLATE = ROOT / "config" / "model-bindings.lab.json"
APP_ASAR = Path("/Applications/Grok Bot.app/Contents/Resources/app.asar")
LANES = ("main", "summary", "compaction", "label", "review")
FAKE_KEY = "grok-home-fake-key-not-a-real-credential"


def sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(url: str, *, data: dict[str, object] | None = None, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method="GET" if body is None else "POST")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def wait_ready(url: str, attempts: int = 50) -> None:
    for _ in range(attempts):
        try:
            status, _ = request(url)
            if status == 200:
                return
        except Exception:
            pass
        time.sleep(0.1)
    raise RuntimeError(f"service did not become ready: {url}")


def start(script: Path, env: dict[str, str], log_name: str) -> subprocess.Popen[bytes]:
    log_path = RUNTIME / log_name
    log_handle = log_path.open("wb")
    child_env = os.environ.copy()
    child_env.update(env)
    child_env["HOME"] = str(SANDBOX_HOME)
    return subprocess.Popen([sys.executable, str(script)], cwd=ROOT, env=child_env, stdout=log_handle, stderr=subprocess.STDOUT)


def main() -> int:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    SANDBOX_HOME.mkdir(parents=True, exist_ok=True)
    receipt_log = RUNTIME / "fake-upstream-receipts.jsonl"
    receipt_log.unlink(missing_ok=True)
    before_asar = sha256(APP_ASAR)
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    assert contract["mode"] == "external-only"
    assert contract["nativeFallback"] is False
    assert tuple(contract["requiredLanes"]) == LANES

    upstream_port, hop_port, dead_port, dead_hop_port = (free_port() for _ in range(4))
    binding = json.loads(BINDING_TEMPLATE.read_text(encoding="utf-8"))
    binding["agents"]["external-only-lab"]["hopBaseUrl"] = f"http://127.0.0.1:{hop_port}/v1"
    runtime_binding = RUNTIME / "model-bindings.smoke.json"
    runtime_binding.write_text(json.dumps(binding, indent=2) + "\n", encoding="utf-8")

    children: list[subprocess.Popen[bytes]] = []
    checks: dict[str, object] = {}
    try:
        children.append(start(UPSTREAM_SCRIPT, {
            "FAKE_UPSTREAM_PORT": str(upstream_port),
            "FAKE_UPSTREAM_KEY": FAKE_KEY,
            "FAKE_UPSTREAM_LOG": str(receipt_log),
        }, "fake-upstream.log"))
        wait_ready(f"http://127.0.0.1:{upstream_port}/health")

        children.append(start(HOP_SCRIPT, {
            "HERMES_HOP_PORT": str(hop_port),
            "HERMES_HOP_UPSTREAM": f"http://127.0.0.1:{upstream_port}",
            "API_SERVER_KEY": FAKE_KEY,
        }, "hop.log"))
        wait_ready(f"http://127.0.0.1:{hop_port}/healthz")

        status, _ = request(f"http://127.0.0.1:{upstream_port}/v1/models")
        checks["direct_without_identity_rejected"] = status == 401

        status, body = request(f"http://127.0.0.1:{hop_port}/v1/models")
        checks["hop_injects_identity"] = status == 200 and b"external-test-model" in body

        lane_results: dict[str, bool] = {}
        for lane in LANES:
            status, body = request(
                f"http://127.0.0.1:{hop_port}/v1/chat/completions",
                data={"model": "external-test-model", "messages": [{"role": "user", "content": "ping"}], "stream": lane == "main"},
                headers={"X-Grok-Request-Kind": lane},
            )
            lane_results[lane] = status == 200 and f"external:{lane}".encode() in body and (lane != "main" or b"[DONE]" in body)
        checks["all_required_lanes_route_external"] = all(lane_results.values())
        checks["lane_results"] = lane_results

        children.append(start(HOP_SCRIPT, {
            "HERMES_HOP_PORT": str(dead_hop_port),
            "HERMES_HOP_UPSTREAM": f"http://127.0.0.1:{dead_port}",
            "API_SERVER_KEY": FAKE_KEY,
        }, "dead-hop.log"))
        wait_ready(f"http://127.0.0.1:{dead_hop_port}/healthz")
        status, body = request(
            f"http://127.0.0.1:{dead_hop_port}/v1/chat/completions",
            data={"model": "external-test-model", "messages": [{"role": "user", "content": "must fail"}]},
        )
        checks["upstream_failure_is_fail_closed"] = status == 502 and b"unreachable" in body and b"fallback" not in body.lower()

        receipts = [json.loads(line) for line in receipt_log.read_text(encoding="utf-8").splitlines() if line.strip()]
        receipt_lanes = {str(item["request_kind"]) for item in receipts}
        checks["receipts_cover_required_lanes"] = set(LANES).issubset(receipt_lanes)
        checks["receipt_log_is_redacted"] = FAKE_KEY not in receipt_log.read_text(encoding="utf-8")
        binding_text = runtime_binding.read_text(encoding="utf-8")
        checks["bindings_contain_no_credential"] = FAKE_KEY not in binding_text and "oauth" not in binding_text.lower() and "bearer" not in binding_text.lower()
    finally:
        for child in reversed(children):
            child.terminate()
        for child in reversed(children):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

    after_asar = sha256(APP_ASAR)
    checks["installed_grok_bot_bundle_unchanged"] = before_asar == after_asar
    passed = all(value is True or isinstance(value, dict) and all(value.values()) for value in checks.values())
    report = {
        "status": "CONFIRMED" if passed else "FAILED",
        "scope": "credential-free isolated routing components; not a normal Grok Bot turn",
        "root": str(ROOT),
        "contract": str(CONTRACT_PATH),
        "binding": str(runtime_binding),
        "installed_grok_bot_app_asar_sha256_before": before_asar,
        "installed_grok_bot_app_asar_sha256_after": after_asar,
        "checks": checks,
    }
    report_path = RUNTIME / "smoke-report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())

