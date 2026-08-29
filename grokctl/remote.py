#!/usr/bin/env python3
"""Injected host, supervisor, process, clock, and uuid adapters for grokctl.

This module never SSHes, never reads HOME, and never talks to a real Grok Bot
host. Tests and the switch engine supply roots, clocks, and process identity.
The production supervisor path is documented only as the default contract name;
callers must inject the actual command.json location.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterator, Mapping, Optional, Tuple


PRODUCTION_SUPERVISOR_COMMAND = Path("/tmp/sand-supervisor/command.json")
PINNED_STOCK_SHA256 = "3c3f986e614aaf8fbec642269da40dd20f1dbd9912bdf8f2390bafd61ec684ef"


class HostError(RuntimeError):
    """Fail-closed host adapter error. Messages must not contain credentials."""

    def __init__(self, message: str, code: str, evidence: Optional[Mapping[str, object]] = None):
        super().__init__(message)
        self.code = code
        self.evidence = dict(evidence or {})


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def isoformat_z(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def atomic_write_bytes(path: Path, data: bytes, mode: int = 0o644) -> None:
    path = Path(path)
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    tmp = parent / (".%s.%s.tmp" % (path.name, uuid.uuid4().hex))
    fd = None
    replaced = False
    try:
        fd = os.open(str(tmp), flags, 0o600)
        view = memoryview(data) if data else memoryview(b"")
        offset = 0
        while offset < len(data):
            written = os.write(fd, view[offset:])
            if written <= 0:
                raise OSError("short write")
            offset += written
        os.fsync(fd)
        if hasattr(os, "fchmod"):
            os.fchmod(fd, mode)
        os.close(fd)
        fd = None
        if not hasattr(os, "fchmod"):
            os.chmod(str(tmp), mode)
        os.replace(str(tmp), str(path))
        replaced = True
        try:
            dirfd = os.open(str(parent), os.O_RDONLY)
            try:
                os.fsync(dirfd)
            finally:
                os.close(dirfd)
        except OSError:
            pass
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if not replaced:
            try:
                os.unlink(str(tmp))
            except OSError:
                pass


def atomic_write_text(path: Path, text: str, mode: int = 0o644) -> None:
    atomic_write_bytes(path, text.encode("utf-8"), mode=mode)


def atomic_write_json(path: Path, payload: object, mode: int = 0o644) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2, sort_keys=True) + "\n", mode=mode)


def load_json(path: Path) -> object:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def contained_secret_path(root: Path, secret_ref: str) -> Path:
    """Lexically join a secret ref under root. Never resolve the final path."""

    if not secret_ref or any(ch in secret_ref for ch in "\r\n\0"):
        raise HostError("invalid secret reference", "invalid_secret")
    rel = Path(secret_ref)
    if rel.is_absolute() or not rel.parts:
        raise HostError("invalid secret reference", "invalid_secret")
    root = Path(root)
    if root.exists() and root.is_symlink():
        raise HostError("secrets root must not be a symlink", "invalid_secret")
    current = root
    for index, part in enumerate(rel.parts):
        if part in ("", ".", "..") or "/" in part or "\\" in part:
            raise HostError("invalid secret reference", "invalid_secret")
        current = current / part
        try:
            current.relative_to(root)
        except ValueError as exc:
            raise HostError("invalid secret reference", "invalid_secret") from exc
        if current.is_symlink():
            raise HostError("secret path must not contain a symlink", "invalid_secret")
        if index < len(rel.parts) - 1 and current.exists() and not current.is_dir():
            raise HostError("invalid secret reference", "invalid_secret")
    return current


def iter_secret_files(root: Path) -> Iterator[Path]:
    root = Path(root)
    if not root.exists():
        return
    if root.is_symlink():
        raise HostError("secrets root must not be a symlink", "invalid_secret")
    for dirpath, dirnames, filenames in os.walk(str(root), followlinks=False):
        base = Path(dirpath)
        if base.is_symlink():
            raise HostError("secret snapshot contains a symlink", "invalid_secret")
        for name in dirnames:
            child = base / name
            if child.is_symlink():
                raise HostError("secret snapshot contains a symlink", "invalid_secret")
        for name in filenames:
            child = base / name
            if child.is_symlink():
                raise HostError("secret snapshot contains a symlink", "invalid_secret")
            try:
                info = child.lstat()
            except OSError as exc:
                raise HostError("secret snapshot is unreadable", "invalid_secret") from exc
            if not stat.S_ISREG(info.st_mode):
                raise HostError("secret snapshot contains a non-regular file", "invalid_secret")
            if stat.S_IMODE(info.st_mode) & 0o077:
                raise HostError("secret snapshot has unsafe permissions", "invalid_secret")
            yield child


def read_regular_nofollow(path: Path, max_bytes: int = 64 * 1024) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(str(path), flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise HostError("secret must be a direct regular file", "invalid_secret")
        if info.st_size > max_bytes:
            raise HostError("secret exceeds size limit", "invalid_secret")
        chunks = []
        remaining = int(info.st_size)
        while remaining > 0:
            chunk = os.read(fd, min(8192, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


@dataclass
class Clock:
    """Injectable clock. FakeClock never sleeps on the wall."""

    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def now_ms(self) -> int:
        return int(self.now().timestamp() * 1000)

    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)


@dataclass
class FakeClock(Clock):
    current: datetime = field(default_factory=lambda: datetime(2026, 8, 30, 12, 0, 0, tzinfo=timezone.utc))
    mono: float = 0.0

    def now(self) -> datetime:
        return self.current

    def monotonic(self) -> float:
        return self.mono

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            self.mono += float(seconds)
            self.current = self.current.fromtimestamp(
                self.current.timestamp() + float(seconds), tz=timezone.utc
            )


@dataclass
class UuidSource:
    def new(self) -> str:
        return str(uuid.uuid4())


@dataclass
class SequenceUuid(UuidSource):
    prefix: str = "tx"
    n: int = 0

    def new(self) -> str:
        self.n += 1
        return "%s-%04d" % (self.prefix, self.n)


@dataclass(frozen=True)
class HostLayout:
    root: Path
    bundle_path: Path
    config_path: Path
    secrets_dir: Path
    hop_pid_path: Path
    hop_config_path: Path
    hop_receipt_path: Path
    grokctl_dir: Path
    receipts_dir: Path
    staging_dir: Path
    snapshots_dir: Path
    state_path: Path
    supervisor_command_path: Path
    busy_signal_path: Path
    hop_cmdline_token: str

    @classmethod
    def under(
        cls,
        root: Path,
        *,
        supervisor_command_path: Optional[Path] = None,
        hop_cmdline_token: str = "provider_hop.py",
    ) -> "HostLayout":
        root = Path(root)
        grokctl = root / "grokctl"
        supervisor = Path(supervisor_command_path) if supervisor_command_path else (root / "supervisor" / "command.json")
        return cls(
            root=root,
            bundle_path=root / "host-main.cjs",
            config_path=root / "config" / "external.json",
            secrets_dir=root / "secrets",
            hop_pid_path=root / "run" / "provider-hop.pid",
            hop_config_path=root / "run" / "provider-hop.json",
            hop_receipt_path=root / "logs" / "provider-hop-receipts.jsonl",
            grokctl_dir=grokctl,
            receipts_dir=grokctl / "receipts",
            staging_dir=grokctl / "staging",
            snapshots_dir=grokctl / "snapshots",
            state_path=grokctl / "state.json",
            supervisor_command_path=supervisor,
            busy_signal_path=supervisor.parent / "agent.busy",
            hop_cmdline_token=str(hop_cmdline_token),
        )


@dataclass
class HostObservation:
    pid: int
    started_at: str
    bundle_digest: str
    profile_id: str
    generation: int
    hop_pid: Optional[int]
    hop_health: str


@dataclass
class SyntheticProcessGateway:
    """In-process PID/cmdline/hop identity. No /proc and no ssh."""

    host_pid: int = 1000
    host_started_at: str = "2026-08-30T12:00:00Z"
    next_pid: int = 5000
    cmdlines: Dict[int, str] = field(default_factory=dict)
    killed: list = field(default_factory=list)
    running_hops: Dict[int, Dict[str, object]] = field(default_factory=dict)
    fail_hop_start: bool = False
    fail_hop_health: bool = False
    inconsistent_health: bool = False
    start_seq: int = 0

    def bump_host(self, started_at: str) -> Tuple[int, str]:
        self.host_pid += 1
        self.host_started_at = started_at
        self.start_seq += 1
        return self.host_pid, self.host_started_at

    def observe_host(self) -> Tuple[int, str]:
        return self.host_pid, self.host_started_at

    def cmdline_of(self, pid: int) -> Optional[str]:
        return self.cmdlines.get(int(pid))

    def owns_pid(self, pid: int, expected_token: str) -> bool:
        cmdline = self.cmdline_of(pid)
        if cmdline is None:
            return False
        return cmdline == expected_token

    def kill(self, pid: int) -> None:
        pid = int(pid)
        self.killed.append(pid)
        self.cmdlines.pop(pid, None)
        self.running_hops.pop(pid, None)

    def start_hop(self, config: Mapping[str, object], pid_path: Path, token: str) -> int:
        if self.fail_hop_start:
            raise HostError("hop start failed", "hop_start_failed")
        pid = self.next_pid
        self.next_pid += 1
        self.cmdlines[pid] = token
        self.running_hops[pid] = dict(config)
        atomic_write_text(pid_path, "%d\n" % pid, mode=0o644)
        return pid

    def hop_health(self, pid: int, config: Mapping[str, object]) -> Dict[str, object]:
        if pid not in self.running_hops:
            raise HostError("hop is not running", "hop_health")
        if self.fail_hop_health:
            raise HostError("hop health failed", "hop_health")
        payload = {
            "ok": True,
            "service": "grokctl-provider-hop",
            "profileId": config.get("profileId"),
            "protocol": config.get("protocol"),
            "model": config.get("model"),
            "resolvedEndpoint": config.get("resolvedEndpoint"),
            "authType": config.get("authType"),
            "credentialLoaded": config.get("authType") != "none",
            "listenHost": config.get("listenHost"),
            "listenPort": config.get("listenPort"),
        }
        if self.inconsistent_health:
            payload["protocol"] = "inconsistent-protocol"
            payload["ok"] = True
        return payload


@dataclass
class SupervisorBox:
    command_path: Path
    clock: Clock
    processes: SyntheticProcessGateway
    consume_on_wait: bool = True
    fail_next_wait: int = 0
    consume_timeout_sec: float = 5.0
    poll_interval_sec: float = 0.05
    issued: list = field(default_factory=list)

    def pending(self) -> Optional[Dict[str, object]]:
        path = self.command_path
        if not path.exists():
            return None
        try:
            payload = load_json(path)
        except (OSError, json.JSONDecodeError) as exc:
            raise HostError("supervisor command is unreadable", "pending_command") from exc
        if not isinstance(payload, dict):
            raise HostError("supervisor command is unreadable", "pending_command")
        return payload

    def clear_own_command(self, command_id: str) -> None:
        pending = self.pending()
        if pending is None:
            return
        if pending.get("id") != command_id:
            raise HostError("supervisor command is pending", "pending_command", {"commandId": pending.get("id")})
        self.command_path.unlink()

    def issue_restart(self, command_id: str, reason: str) -> Dict[str, object]:
        if self.pending() is not None:
            raise HostError("supervisor command is pending", "pending_command")
        payload = {
            "id": command_id,
            "kind": "restart",
            "issuedAtMs": self.clock.now_ms(),
            "reason": reason,
        }
        atomic_write_json(self.command_path, payload, mode=0o644)
        self.issued.append(dict(payload))
        return payload

    def wait_consumed(self, command_id: str) -> Tuple[int, str]:
        deadline = self.clock.monotonic() + float(self.consume_timeout_sec)
        while True:
            if self.fail_next_wait > 0:
                self.fail_next_wait -= 1
                raise HostError("supervisor restart failed", "restart_failed", {"commandId": command_id})
            pending = self.pending()
            if pending is None:
                return self.processes.observe_host()
            if pending.get("id") != command_id:
                raise HostError("supervisor command id mismatch", "restart_failed", {"commandId": command_id})
            if self.consume_on_wait:
                started_at = isoformat_z(self.clock.now())
                self.command_path.unlink()
                return self.processes.bump_host(started_at)
            if self.clock.monotonic() >= deadline:
                raise HostError("supervisor command not consumed", "restart_failed", {"commandId": command_id})
            self.clock.sleep(self.poll_interval_sec)


@dataclass
class HostRuntime:
    layout: HostLayout
    processes: SyntheticProcessGateway
    supervisor: SupervisorBox
    clock: Clock
    ids: UuidSource
    receipts_enabled: bool = True
    fail_restore: bool = False

    def is_busy(self) -> bool:
        return self.layout.busy_signal_path.exists()

    def pending_command(self) -> Optional[Dict[str, object]]:
        return self.supervisor.pending()

    def observe(self) -> HostObservation:
        pid, started_at = self.processes.observe_host()
        state = self.load_state()
        bundle_digest = sha256_file(self.layout.bundle_path) if self.layout.bundle_path.is_file() else ""
        hop_pid = self.read_hop_pid()
        hop_health = "stopped"
        if hop_pid is not None and hop_pid in self.processes.running_hops:
            hop_health = "healthy"
        return HostObservation(
            pid=pid,
            started_at=started_at,
            bundle_digest=bundle_digest,
            profile_id=str(state.get("activeProfile") or "official"),
            generation=int(state.get("generation") or 0),
            hop_pid=hop_pid,
            hop_health=hop_health,
        )

    def load_state(self) -> Dict[str, object]:
        if not self.layout.state_path.is_file():
            return {"schemaVersion": 1, "generation": 0, "activeProfile": "official"}
        payload = load_json(self.layout.state_path)
        if not isinstance(payload, dict):
            raise HostError("host state is invalid", "invalid_state")
        return payload

    def write_state(self, payload: Mapping[str, object]) -> None:
        atomic_write_json(self.layout.state_path, dict(payload), mode=0o644)

    def read_hop_pid(self) -> Optional[int]:
        path = self.layout.hop_pid_path
        if not path.is_file():
            return None
        raw = path.read_text(encoding="utf-8").strip()
        if not raw.isdigit():
            raise HostError("invalid hop pid file", "pid_ownership")
        return int(raw)

    def secret_path(self, secret_ref: str) -> Path:
        return contained_secret_path(self.layout.secrets_dir, secret_ref)

    def inspect_secret(self, secret_ref: str) -> Dict[str, object]:
        hop = load_provider_hop()
        path = self.secret_path(secret_ref)
        return hop.inspect_secret_metadata(path)

    def current_receipt(self) -> Optional[Dict[str, object]]:
        path = self.layout.receipts_dir / "current.json"
        if not path.is_file():
            return None
        payload = load_json(path)
        if not isinstance(payload, dict):
            raise HostError("current receipt is invalid", "missing_receipt")
        return payload

    def commit_receipt(self, receipt: Mapping[str, object], transaction_id: str) -> None:
        if not self.receipts_enabled:
            raise HostError("activation receipt could not be committed", "missing_receipt")
        named = self.layout.receipts_dir / ("%s.json" % transaction_id)
        current = self.layout.receipts_dir / "current.json"
        atomic_write_json(named, dict(receipt), mode=0o644)
        atomic_write_json(current, dict(receipt), mode=0o644)

    def staging_dir(self, generation: int) -> Path:
        return self.layout.staging_dir / str(int(generation))

    def snapshot_dir(self, generation: int) -> Path:
        return self.layout.snapshots_dir / str(int(generation))

    def write_snapshot(self, dest: Path) -> Path:
        target = Path(dest)
        if target.exists():
            raise HostError("snapshot path already exists", "staged_mismatch")
        target.mkdir(parents=True, exist_ok=True)
        os.chmod(str(target), 0o700)
        bundle = self.layout.bundle_path.read_bytes()
        atomic_write_bytes(target / "host-main.cjs", bundle, mode=0o644)
        if self.layout.config_path.exists():
            atomic_write_bytes(target / "external.json", self.layout.config_path.read_bytes(), mode=0o644)
        disabled = Path(str(self.layout.config_path) + ".disabled")
        if disabled.exists():
            atomic_write_bytes(target / "external.json.disabled", disabled.read_bytes(), mode=0o644)
        secrets_dir = target / "secrets"
        secrets_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(str(secrets_dir), 0o700)
        if self.layout.secrets_dir.exists():
            for path in sorted(iter_secret_files(self.layout.secrets_dir)):
                rel = path.relative_to(self.layout.secrets_dir)
                dest = secrets_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                data = read_regular_nofollow(path)
                atomic_write_bytes(dest, data, mode=0o600)
        hop_pid = self.read_hop_pid()
        hop_meta = {
            "hopPid": hop_pid,
            "hopCmdline": self.processes.cmdline_of(hop_pid) if hop_pid is not None else None,
            "state": self.load_state(),
            "hostPid": self.processes.host_pid,
            "startedAt": self.processes.host_started_at,
        }
        if hop_pid is not None and hop_pid in self.processes.running_hops:
            hop_meta["hopConfig"] = self.processes.running_hops[hop_pid]
        atomic_write_json(target / "meta.json", hop_meta, mode=0o600)
        if self.layout.hop_config_path.is_file():
            atomic_write_bytes(target / "provider-hop.json", self.layout.hop_config_path.read_bytes(), mode=0o600)
        if self.layout.hop_pid_path.is_file():
            atomic_write_text(target / "provider-hop.pid", self.layout.hop_pid_path.read_text(encoding="utf-8"))
        return target

    def restore_snapshot(self, snapshot: Path) -> None:
        if self.fail_restore:
            raise HostError("snapshot restore failed", "rollback_failed")
        snapshot = Path(snapshot)
        if not snapshot.is_dir():
            raise HostError("snapshot is missing", "rollback_failed")
        bundle = snapshot / "host-main.cjs"
        if not bundle.is_file():
            raise HostError("snapshot bundle is missing", "rollback_failed")
        self.install_bundle(bundle)
        config_src = snapshot / "external.json"
        if config_src.is_file():
            atomic_write_bytes(self.layout.config_path, config_src.read_bytes(), mode=0o644)
        elif self.layout.config_path.exists():
            self.layout.config_path.unlink()
        disabled_src = snapshot / "external.json.disabled"
        disabled = Path(str(self.layout.config_path) + ".disabled")
        if disabled_src.is_file():
            atomic_write_bytes(disabled, disabled_src.read_bytes(), mode=0o644)
        elif disabled.exists():
            disabled.unlink()
        if self.layout.secrets_dir.exists():
            for path in sorted(self.layout.secrets_dir.rglob("*")):
                if path.is_file() or path.is_symlink():
                    path.unlink()
        secrets_src = snapshot / "secrets"
        if secrets_src.is_dir():
            for path in sorted(secrets_src.rglob("*")):
                if not path.is_file():
                    continue
                rel = path.relative_to(secrets_src)
                dest = self.layout.secrets_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_bytes(dest, path.read_bytes(), mode=0o600)
                os.chmod(str(dest), 0o600)
        meta = load_json(snapshot / "meta.json")
        if not isinstance(meta, dict):
            raise HostError("snapshot metadata is invalid", "rollback_failed")
        hop_config_src = snapshot / "provider-hop.json"
        if hop_config_src.is_file():
            atomic_write_bytes(self.layout.hop_config_path, hop_config_src.read_bytes(), mode=0o600)
        elif self.layout.hop_config_path.exists():
            self.layout.hop_config_path.unlink()
        hop_pid = meta.get("hopPid")
        hop_cmdline = meta.get("hopCmdline")
        hop_config = meta.get("hopConfig")
        if hop_pid is not None and hop_cmdline:
            pid = int(hop_pid)
            self.processes.cmdlines[pid] = str(hop_cmdline)
            if isinstance(hop_config, dict):
                self.processes.running_hops[pid] = dict(hop_config)
            atomic_write_text(self.layout.hop_pid_path, "%d\n" % pid)
        else:
            if self.layout.hop_pid_path.exists():
                self.layout.hop_pid_path.unlink()
        if isinstance(meta.get("state"), dict):
            self.write_state(meta["state"])

    def remove_staging(self, generation: int) -> None:
        target = self.staging_dir(generation)
        if not target.exists():
            return
        for path in sorted(target.rglob("*"), reverse=True):
            if path.is_file() or path.is_symlink():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
        if target.exists():
            target.rmdir()

    def stage_file(self, dest: Path, data: bytes, mode: int = 0o644) -> str:
        atomic_write_bytes(dest, data, mode=mode)
        digest = sha256_bytes(data)
        if sha256_file(dest) != digest:
            raise HostError("staged artifact digest mismatch", "staged_mismatch")
        return digest

    def install_bundle(self, source: Path) -> str:
        data = Path(source).read_bytes()
        digest = sha256_bytes(data)
        atomic_write_bytes(self.layout.bundle_path, data, mode=0o644)
        if sha256_file(self.layout.bundle_path) != digest:
            raise HostError("installed bundle digest mismatch", "staged_mismatch")
        return digest

    def install_config(self, payload: Mapping[str, object]) -> str:
        serialized = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        atomic_write_text(self.layout.config_path, serialized, mode=0o644)
        disabled = Path(str(self.layout.config_path) + ".disabled")
        if disabled.exists():
            disabled.unlink()
        return sha256_bytes(serialized.encode("utf-8"))

    def disable_config(self) -> None:
        path = self.layout.config_path
        if path.is_file():
            disabled = Path(str(path) + ".disabled")
            os.replace(str(path), str(disabled))

    def remove_secret(self, secret_ref: str) -> None:
        path = self.secret_path(secret_ref)
        if path.exists() or path.is_symlink():
            path.unlink()

    def stop_hop_if_owner(self, expected_token: str) -> Optional[int]:
        pid = self.read_hop_pid()
        if pid is None:
            return None
        if not self.processes.owns_pid(pid, expected_token):
            raise HostError(
                "hop pid is not owned by the expected cmdline",
                "pid_ownership",
                {"pid": pid},
            )
        self.processes.kill(pid)
        if self.layout.hop_pid_path.exists():
            self.layout.hop_pid_path.unlink()
        return pid

    def start_hop(self, config: Mapping[str, object]) -> int:
        atomic_write_json(self.layout.hop_config_path, dict(config), mode=0o600)
        return self.processes.start_hop(config, self.layout.hop_pid_path, self.layout.hop_cmdline_token)

    def hop_health(self, pid: int, config: Mapping[str, object]) -> Dict[str, object]:
        return self.processes.hop_health(pid, config)

    def stop_pid(self, pid: int, expected_token: str) -> None:
        if not self.processes.owns_pid(pid, expected_token):
            raise HostError("pid is not owned by the expected cmdline", "pid_ownership", {"pid": pid})
        self.processes.kill(pid)

    def issue_restart(self, command_id: str, reason: str) -> Dict[str, object]:
        return self.supervisor.issue_restart(command_id, reason)

    def clear_own_command(self, command_id: str) -> None:
        self.supervisor.clear_own_command(command_id)

    def wait_consumed(self, command_id: str) -> Tuple[int, str]:
        return self.supervisor.wait_consumed(command_id)


def load_provider_hop():
    import importlib.util
    import sys

    path = Path(__file__).resolve().parents[1] / "ops" / "provider_hop.py"
    existing = sys.modules.get("grokctl_provider_hop")
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location("grokctl_provider_hop", path)
    if spec is None or spec.loader is None:
        raise HostError("unable to load provider hop module", "hop_start_failed")
    module = importlib.util.module_from_spec(spec)
    sys.modules["grokctl_provider_hop"] = module
    spec.loader.exec_module(module)
    return module


def build_runtime(
    root: Path,
    *,
    clock: Optional[Clock] = None,
    ids: Optional[UuidSource] = None,
    processes: Optional[SyntheticProcessGateway] = None,
    hop_cmdline_token: str = "provider_hop.py",
    supervisor_command_path: Optional[Path] = None,
) -> HostRuntime:
    layout = HostLayout.under(
        root,
        supervisor_command_path=supervisor_command_path,
        hop_cmdline_token=hop_cmdline_token,
    )
    clock = clock or FakeClock()
    ids = ids or SequenceUuid()
    processes = processes or SyntheticProcessGateway()
    supervisor = SupervisorBox(command_path=layout.supervisor_command_path, clock=clock, processes=processes)
    return HostRuntime(layout=layout, processes=processes, supervisor=supervisor, clock=clock, ids=ids)
