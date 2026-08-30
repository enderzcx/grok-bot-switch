"""Build a credential-free, deterministic package for the native host bridge."""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import zlib

FILES = (
    "grokctl/__init__.py", "grokctl/models.py", "grokctl/platform_security.py", "grokctl/profiles.py",
    "ops/provider_hop.py", "ops/patch_grok_host_provider_switcher.py",
    "ops/native_controller.py", "ops/native_activation.py", "ops/native_hop.py",
    "ops/native_hop_worker.py", "ops/native_runner.py",
    "src/provider-direct-session.cjs",
    "src/provider_protocols/contract.cjs", "src/provider_protocols/sse.cjs",
    "src/provider_protocols/tools.cjs", "src/provider_protocols/openai-chat.cjs",
    "src/provider_protocols/openai-responses.cjs", "src/provider_protocols/anthropic-messages.cjs",
    "src/provider_protocols/index.cjs",
)


def build_host_package(root: Path) -> dict:
    files = {}
    for name in FILES:
        path = root / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("missing package source: " + name)
        data = path.read_bytes()
        if len(data) > 1024 * 1024:
            raise ValueError("package source too large")
        files[name] = {"sha256": hashlib.sha256(data).hexdigest(), "content": base64.b64encode(data).decode()}
    manifest = {"schemaVersion": 1, "files": files}
    raw = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    payload = base64.b64encode(zlib.compress(raw, level=9)).decode()
    if len(payload) > 1024 * 1024:
        raise ValueError("package payload too large")
    return {"schemaVersion": 1, "sha256": hashlib.sha256(raw).hexdigest(), "payload": payload,
            "files": {name: value["sha256"] for name, value in files.items()}}
