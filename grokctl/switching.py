#!/usr/bin/env python3
"""Credential-free grokctl v0.1 switch transaction engine.

Plans are pure and the default result. Apply mutates a synthetic host only when
the caller passes an explicit True apply flag. Live verification is out of
scope: every plan and receipt sets liveVerified=false.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Mapping, Optional, Tuple

from grokctl.remote import (
    HostError,
    HostRuntime,
    atomic_write_bytes,
    canonical_json,
    isoformat_z,
    load_provider_hop,
    sha256_bytes,
    sha256_file,
)


OFFICIAL_ID = "official"
OFFICIAL_PROFILE = {
    "schemaVersion": 1,
    "id": OFFICIAL_ID,
    "displayName": "Official Grok",
    "protocol": "native",
    "fallbackPolicy": "never",
    "enabled": True,
}
FORBIDDEN_PROFILE_KEYS = frozenset(
    {
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
)
ALLOWED_KEY_EXCEPTIONS = frozenset({"secretref"})


class SwitchError(RuntimeError):
    """Fail-closed switch error. Messages must not contain credentials."""

    def __init__(self, message: str, code: str, evidence: Optional[Mapping[str, object]] = None):
        super().__init__(message)
        self.code = code
        self.evidence = dict(evidence or {})


def _wrap(exc: Exception) -> SwitchError:
    if isinstance(exc, SwitchError):
        return exc
    if isinstance(exc, HostError):
        return SwitchError(str(exc), exc.code, exc.evidence)
    return SwitchError(str(exc), "internal", {"type": type(exc).__name__})


def profile_digest(profile: Mapping[str, object]) -> str:
    return sha256_bytes(canonical_json(profile).encode("utf-8"))


def _assert_no_secret_material(value: object) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            lowered = str(key).lower().replace("-", "")
            if lowered in FORBIDDEN_PROFILE_KEYS and lowered not in ALLOWED_KEY_EXCEPTIONS:
                raise SwitchError("profile must not contain secret material", "invalid_profile")
            _assert_no_secret_material(child)
    elif isinstance(value, list):
        for child in value:
            _assert_no_secret_material(child)


def normalize_profile(profile: Mapping[str, object]) -> Dict[str, object]:
    if not isinstance(profile, Mapping):
        raise SwitchError("invalid profile", "invalid_profile")
    _assert_no_secret_material(profile)
    payload = json.loads(canonical_json(profile))
    profile_id = str(payload.get("id") or "")
    if not profile_id:
        raise SwitchError("profile id is required", "invalid_profile")
    if profile_id != OFFICIAL_ID:
        hop = load_provider_hop()
        protocol = str(payload.get("protocol") or "")
        if protocol not in hop.PROTOCOLS:
            raise SwitchError("unsupported protocol", "invalid_profile")
        if payload.get("fallbackPolicy") != "never":
            raise SwitchError("fallback must be never", "invalid_profile")
        if payload.get("enabled") is not True:
            raise SwitchError("profile is not enabled", "invalid_profile")
        auth = payload.get("auth") or {}
        if not isinstance(auth, dict):
            raise SwitchError("invalid auth block", "invalid_profile")
        auth_type = str(auth.get("type") or "")
        if auth_type not in hop.AUTH_TYPES:
            raise SwitchError("unsupported auth type", "invalid_profile")
        headers = payload.get("headers") or {}
        try:
            hop.validate_headers(headers)
            hop.resolve_endpoint(protocol, str(payload.get("baseUrl") or ""), payload.get("endpointPath"))
        except hop.HopError as exc:
            code = "unsafe_header" if "header" in str(exc) else "unsafe_endpoint"
            raise SwitchError(str(exc), code) from exc
    return payload


@dataclass(frozen=True)
class ArtifactSet:
    stock_bundle: Path
    patched_bundle: Path
    known_stock_digests: Tuple[str, ...]
    known_patched_digests: Tuple[str, ...]
    hop_listen_host: str = "127.0.0.1"
    hop_listen_port: int = 18779

    def known_bundle_digests(self) -> Tuple[str, ...]:
        return tuple(dict.fromkeys(list(self.known_stock_digests) + list(self.known_patched_digests)))


@dataclass(frozen=True)
class StagedPaths:
    bundle: str
    config: str
    hop_config: str
    snapshot: str
    receipt: str

    def to_dict(self) -> Dict[str, str]:
        return {
            "bundle": self.bundle,
            "config": self.config,
            "hopConfig": self.hop_config,
            "snapshot": self.snapshot,
            "receipt": self.receipt,
        }


@dataclass(frozen=True)
class PreviousSnapshot:
    generation: int
    profile_id: str
    profile_digest: str
    bundle_digest: str
    config_digest: Optional[str]
    secret_fingerprints: Tuple[Tuple[str, str], ...]
    hop_pid: Optional[int]
    hop_cmdline_token: Optional[str]
    snapshot_dir: str
    host_pid: Optional[int]
    started_at: Optional[str]
    hop_health: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "generation": self.generation,
            "profileId": self.profile_id,
            "profileDigest": self.profile_digest,
            "bundleDigest": self.bundle_digest,
            "configDigest": self.config_digest,
            "secretFingerprints": {key: value for key, value in self.secret_fingerprints},
            "hopPid": self.hop_pid,
            "hopCmdlineToken": self.hop_cmdline_token,
            "snapshotDir": self.snapshot_dir,
            "hostPid": self.host_pid,
            "startedAt": self.started_at,
            "hopHealth": self.hop_health,
        }


@dataclass(frozen=True)
class ActivationPlan:
    schema_version: int
    transaction_id: str
    target: str
    target_kind: str
    requested_profile: str
    previous_profile: str
    generation: int
    profile_digest: str
    bundle_digest: str
    staged_paths: StagedPaths
    supervisor_command_id: str
    observed_pid: Optional[int]
    observed_started_at: Optional[str]
    hop_health: str
    previous_snapshot: PreviousSnapshot
    live_verified: bool
    protocol: Optional[str]
    model: Optional[str]
    resolved_endpoint: Optional[str]
    auth_type: Optional[str]
    secret_ref: Optional[str]
    hop_config: Tuple[Tuple[str, object], ...]
    host_config: Tuple[Tuple[str, object], ...]

    def to_dict(self) -> Dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "transactionId": self.transaction_id,
            "target": self.target,
            "targetKind": self.target_kind,
            "requestedProfile": self.requested_profile,
            "previousProfile": self.previous_profile,
            "generation": self.generation,
            "profileDigest": self.profile_digest,
            "bundleDigest": self.bundle_digest,
            "stagedPaths": self.staged_paths.to_dict(),
            "supervisorCommandId": self.supervisor_command_id,
            "observedPid": self.observed_pid,
            "observedStartedAt": self.observed_started_at,
            "hopHealth": self.hop_health,
            "previousSnapshot": self.previous_snapshot.to_dict(),
            "liveVerified": False,
            "protocol": self.protocol,
            "model": self.model,
            "resolvedEndpoint": self.resolved_endpoint,
            "authType": self.auth_type,
            "secretRef": self.secret_ref,
        }


@dataclass(frozen=True)
class ActivationReceipt:
    schema_version: int
    transaction_id: str
    requested_profile: str
    previous_profile: str
    generation: int
    profile_digest: str
    bundle_digest: str
    host_pid: int
    started_at: str
    hop_health: str
    live_verified: bool
    committed_at: str
    supervisor_command_id: str
    staged_paths: StagedPaths
    previous_snapshot: PreviousSnapshot
    observed_pid: int
    observed_started_at: str
    target: str
    target_kind: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "transactionId": self.transaction_id,
            "requestedProfile": self.requested_profile,
            "previousProfile": self.previous_profile,
            "generation": self.generation,
            "profileDigest": self.profile_digest,
            "bundleDigest": self.bundle_digest,
            "hostPid": self.host_pid,
            "startedAt": self.started_at,
            "hopHealth": self.hop_health,
            "liveVerified": False,
            "committedAt": self.committed_at,
            "supervisorCommandId": self.supervisor_command_id,
            "stagedPaths": self.staged_paths.to_dict(),
            "previousSnapshot": self.previous_snapshot.to_dict(),
            "observedPid": self.observed_pid,
            "observedStartedAt": self.observed_started_at,
            "target": self.target,
            "targetKind": self.target_kind,
        }


@dataclass(frozen=True)
class ProfileCatalog:
    profiles: Tuple[Tuple[str, str], ...] = ()

    @classmethod
    def from_mapping(cls, profiles: Mapping[str, Mapping[str, object]]) -> "ProfileCatalog":
        items = []
        for key, value in profiles.items():
            normalized = normalize_profile(value)
            profile_id = str(normalized.get("id") or "")
            if str(key) != profile_id:
                raise SwitchError("profile mapping key must match id", "invalid_profile")
            items.append((profile_id, canonical_json(normalized)))
        return cls(tuple(items))

    def get(self, profile_id: str) -> Dict[str, object]:
        if profile_id == OFFICIAL_ID:
            return json.loads(canonical_json(OFFICIAL_PROFILE))
        for key, blob in self.profiles:
            if key == profile_id:
                return json.loads(blob)
        raise SwitchError("unknown profile", "invalid_profile", {"profileId": profile_id})


def _mapping(pairs: Tuple[Tuple[str, object], ...]) -> Dict[str, object]:
    return {key: value for key, value in pairs}


def _pairs(payload: Mapping[str, object]) -> Tuple[Tuple[str, object], ...]:
    return tuple(sorted(((str(key), value) for key, value in payload.items()), key=lambda item: item[0]))


class SwitchEngine:
    def __init__(
        self,
        host: HostRuntime,
        catalog: ProfileCatalog,
        artifacts: ArtifactSet,
    ) -> None:
        self.host = host
        self.catalog = catalog
        self.artifacts = artifacts
        self._hop = load_provider_hop()

    def plan(self, target: str) -> ActivationPlan:
        self._preflight_world()
        observed = self.host.observe()
        self._assert_known_bundle(observed.bundle_digest)
        target_id = str(target)
        target_kind = "official" if target_id == OFFICIAL_ID else "external"
        profile = normalize_profile(self.catalog.get(target_id))
        previous_profile = observed.profile_id
        previous_digest = profile_digest(normalize_profile(self.catalog.get(previous_profile)))
        generation = int(observed.generation) + 1
        transaction_id = self.host.ids.new()
        command_id = self.host.ids.new()
        hop_health = "stopped" if target_kind == "official" else "healthy"
        hop_config: Dict[str, object] = {}
        host_config: Dict[str, object] = {}
        secret_ref = None
        protocol = None
        model = None
        resolved = None
        auth_type = None
        if target_kind == "official":
            bundle_path = self.artifacts.stock_bundle
            bundle_digest = sha256_file(bundle_path)
            if bundle_digest not in self.artifacts.known_stock_digests:
                raise SwitchError("unknown bundle hash", "unknown_hash")
            digest = profile_digest(profile)
        else:
            bundle_path = self.artifacts.patched_bundle
            bundle_digest = sha256_file(bundle_path)
            if bundle_digest not in self.artifacts.known_patched_digests:
                raise SwitchError("unknown bundle hash", "unknown_hash")
            protocol = str(profile["protocol"])
            model = str(profile["model"])
            endpoint_path = profile.get("endpointPath")
            resolved = self._hop.resolve_endpoint(protocol, str(profile["baseUrl"]), endpoint_path)
            origin, resolved_path, _query = self._hop.validate_endpoint(resolved)
            auth = profile.get("auth") or {}
            auth_type = str(auth.get("type"))
            secret_ref = None if auth_type == "none" else str(auth.get("secretRef") or "")
            if auth_type != "none":
                self._require_secret(secret_ref)
            hop_config = {
                "schemaVersion": 1,
                "listenHost": self.artifacts.hop_listen_host,
                "listenPort": int(self.artifacts.hop_listen_port),
                "profileId": target_id,
                "protocol": protocol,
                "model": model,
                "resolvedEndpoint": resolved,
                "endpointPath": resolved_path,
                "authType": auth_type,
                "headers": dict(profile.get("headers") or {}),
                "timeoutSec": 5,
                "receiptFile": str(self.host.layout.hop_receipt_path),
            }
            if auth_type == "none":
                hop_config["secretFile"] = None
            else:
                hop_config["secretFile"] = str(self.host.secret_path(secret_ref))
            if protocol == "anthropic-messages" and "anthropic-version" not in {
                str(name).lower() for name in (profile.get("headers") or {})
            }:
                hop_config["anthropicVersion"] = "2023-06-01"
            self._validate_hop_config_payload(hop_config)
            host_config = {
                "schemaVersion": 1,
                "enabled": True,
                "mode": "external-only",
                "nativeFallback": False,
                "fallbackPolicy": "never",
                "profileId": target_id,
                "protocol": protocol,
                "model": model,
                "baseUrl": "http://%s:%d" % (self.artifacts.hop_listen_host, int(self.artifacts.hop_listen_port)),
                "endpointPath": resolved_path,
                "generation": generation,
                "profileDigest": profile_digest(profile),
            }
            digest = profile_digest(profile)
        staging = self.host.staging_dir(generation) / transaction_id
        snapshot = self.host.snapshot_dir(generation) / transaction_id
        staged = StagedPaths(
            bundle=str(staging / "host-main.cjs"),
            config=str(staging / "external.json"),
            hop_config=str(staging / "provider-hop.json"),
            snapshot=str(snapshot),
            receipt=str(self.host.layout.receipts_dir / ("%s.json" % transaction_id)),
        )
        previous = PreviousSnapshot(
            generation=int(observed.generation),
            profile_id=previous_profile,
            profile_digest=previous_digest,
            bundle_digest=observed.bundle_digest,
            config_digest=sha256_file(self.host.layout.config_path) if self.host.layout.config_path.is_file() else None,
            secret_fingerprints=self._secret_fingerprints(),
            hop_pid=observed.hop_pid,
            hop_cmdline_token=self.host.processes.cmdline_of(observed.hop_pid) if observed.hop_pid else None,
            snapshot_dir=str(snapshot),
            host_pid=observed.pid,
            started_at=observed.started_at,
            hop_health=observed.hop_health,
        )
        plan = ActivationPlan(
            schema_version=1,
            transaction_id=transaction_id,
            target=target_id,
            target_kind=target_kind,
            requested_profile=target_id,
            previous_profile=previous_profile,
            generation=generation,
            profile_digest=digest,
            bundle_digest=bundle_digest,
            staged_paths=staged,
            supervisor_command_id=command_id,
            observed_pid=observed.pid,
            observed_started_at=observed.started_at,
            hop_health=hop_health,
            previous_snapshot=previous,
            live_verified=False,
            protocol=protocol,
            model=model,
            resolved_endpoint=resolved,
            auth_type=auth_type,
            secret_ref=secret_ref,
            hop_config=_pairs(hop_config),
            host_config=_pairs(host_config),
        )
        return plan

    def apply(self, plan: ActivationPlan, apply: bool = False) -> ActivationReceipt:
        if apply is not True:
            raise SwitchError("apply requires explicit boolean authority", "apply_required")
        snapshot_written = False
        hop_started_pid = None
        restart_issued = False
        try:
            self._preflight_world()
            self._assert_plan_matches_world(plan)
            self.host.write_snapshot(Path(plan.staged_paths.snapshot))
            snapshot_written = True
            self._stage(plan)
            self._verify_staged(plan)
            if plan.target_kind == "external":
                hop_started_pid = self._start_and_health_hop(plan)
            self._install_active(plan, hop_started_pid)
            self.host.issue_restart(
                plan.supervisor_command_id,
                reason="grokctl switch %s -> %s" % (plan.previous_profile, plan.target),
            )
            restart_issued = True
            new_pid, started_at = self.host.wait_consumed(plan.supervisor_command_id)
            if new_pid == plan.observed_pid:
                raise SwitchError("host pid did not change after restart", "restart_failed")
            hop_health = self._read_hop_health(plan, hop_started_pid)
            receipt = ActivationReceipt(
                schema_version=1,
                transaction_id=plan.transaction_id,
                requested_profile=plan.requested_profile,
                previous_profile=plan.previous_profile,
                generation=plan.generation,
                profile_digest=plan.profile_digest,
                bundle_digest=plan.bundle_digest,
                host_pid=int(new_pid),
                started_at=started_at,
                hop_health=hop_health,
                live_verified=False,
                committed_at=isoformat_z(self.host.clock.now()),
                supervisor_command_id=plan.supervisor_command_id,
                staged_paths=plan.staged_paths,
                previous_snapshot=plan.previous_snapshot,
                observed_pid=int(new_pid),
                observed_started_at=started_at,
                target=plan.target,
                target_kind=plan.target_kind,
            )
            self._commit(plan, receipt)
            self.host.remove_staging(plan.generation)
            return receipt
        except Exception as exc:
            wrapped = _wrap(exc)
            if wrapped.code == "rollback_failed":
                raise wrapped
            if not restart_issued:
                self._cleanup_pre_restart(plan, snapshot_written, hop_started_pid, wrapped)
                raise wrapped
            self._rollback_once(plan, wrapped)
            raise wrapped

    def execute(self, target: str, apply: bool = False):
        plan = self.plan(target)
        if apply is not True:
            return plan
        return self.apply(plan, apply=True)

    def _preflight_world(self) -> None:
        if self.host.pending_command() is not None:
            raise SwitchError("supervisor command is pending", "pending_command")
        if self.host.is_busy():
            raise SwitchError("agent is busy", "busy_agent")

    def _assert_known_bundle(self, digest: str) -> None:
        known = set(self.artifacts.known_bundle_digests())
        if not digest or digest not in known:
            raise SwitchError("unknown bundle hash", "unknown_hash")

    def _require_secret(self, secret_ref: Optional[str]) -> None:
        if not secret_ref:
            raise SwitchError("missing secret metadata", "missing_secret")
        try:
            meta = self.host.inspect_secret(secret_ref)
        except HostError as exc:
            raise SwitchError(str(exc), exc.code, exc.evidence) from exc
        if meta.get("rejected") or not meta.get("fingerprint"):
            raise SwitchError("invalid or missing secret metadata", "invalid_secret", {"reason": meta.get("reason")})

    def _secret_fingerprints(self) -> Tuple[Tuple[str, str], ...]:
        root = self.host.layout.secrets_dir
        if not root.exists():
            return ()
        items = []
        for path in sorted(root.rglob("*")):
            if not path.is_file() and not path.is_symlink():
                continue
            rel = str(path.relative_to(root)).replace("\\", "/")
            meta = self._hop.inspect_secret_metadata(path)
            fingerprint = meta.get("fingerprint")
            items.append((rel, str(fingerprint or "rejected")))
        return tuple(items)

    def _validate_hop_config_payload(self, payload: Mapping[str, object]) -> None:
        if not self._hop.is_loopback_host(str(payload.get("listenHost") or "")):
            raise SwitchError("hop must listen only on loopback", "unsafe_endpoint")
        try:
            self._hop.validate_endpoint(str(payload.get("resolvedEndpoint") or ""))
            self._hop.validate_headers(payload.get("headers") or {})
        except self._hop.HopError as exc:
            code = "unsafe_header" if "header" in str(exc) else "unsafe_endpoint"
            raise SwitchError(str(exc), code) from exc

    def _assert_plan_matches_world(self, plan: ActivationPlan) -> None:
        observed = self.host.observe()
        if observed.generation != plan.previous_snapshot.generation:
            raise SwitchError("host generation changed since plan", "snapshot_mismatch")
        if observed.profile_id != plan.previous_profile:
            raise SwitchError("active profile changed since plan", "snapshot_mismatch")
        if observed.bundle_digest != plan.previous_snapshot.bundle_digest:
            raise SwitchError("active bundle changed since plan", "snapshot_mismatch")
        if observed.pid != plan.observed_pid:
            raise SwitchError("host pid changed since plan", "snapshot_mismatch")
        self._assert_known_bundle(observed.bundle_digest)
        if plan.bundle_digest not in set(self.artifacts.known_bundle_digests()):
            raise SwitchError("unknown bundle hash", "unknown_hash")
        if plan.target_kind == "official":
            if plan.bundle_digest not in self.artifacts.known_stock_digests:
                raise SwitchError("unknown bundle hash", "unknown_hash")
        else:
            if plan.bundle_digest not in self.artifacts.known_patched_digests:
                raise SwitchError("unknown bundle hash", "unknown_hash")
            if plan.secret_ref:
                self._require_secret(plan.secret_ref)
            self._validate_hop_config_payload(_mapping(plan.hop_config))
        if plan.live_verified is not False:
            raise SwitchError("liveVerified must be false", "invalid_profile")

    def _stage(self, plan: ActivationPlan) -> None:
        bundle_src = self.artifacts.stock_bundle if plan.target_kind == "official" else self.artifacts.patched_bundle
        data = Path(bundle_src).read_bytes()
        if sha256_bytes(data) != plan.bundle_digest:
            raise SwitchError("staged artifact digest mismatch", "staged_mismatch")
        self.host.stage_file(Path(plan.staged_paths.bundle), data, mode=0o644)
        if plan.target_kind == "external":
            config_text = json.dumps(_mapping(plan.host_config), indent=2, sort_keys=True) + "\n"
            hop_text = json.dumps(_mapping(plan.hop_config), indent=2, sort_keys=True) + "\n"
            self.host.stage_file(Path(plan.staged_paths.config), config_text.encode("utf-8"), mode=0o644)
            self.host.stage_file(Path(plan.staged_paths.hop_config), hop_text.encode("utf-8"), mode=0o600)

    def _verify_staged(self, plan: ActivationPlan) -> None:
        if sha256_file(Path(plan.staged_paths.bundle)) != plan.bundle_digest:
            raise SwitchError("staged artifact digest mismatch", "staged_mismatch")
        if plan.target_kind == "external":
            hop_payload = json.loads(Path(plan.staged_paths.hop_config).read_text(encoding="utf-8"))
            if hop_payload.get("resolvedEndpoint") != plan.resolved_endpoint:
                raise SwitchError("staged artifact digest mismatch", "staged_mismatch")
            if hop_payload.get("protocol") != plan.protocol or hop_payload.get("model") != plan.model:
                raise SwitchError("staged hop config is internally inconsistent", "protocol_mismatch")

    def _start_and_health_hop(self, plan: ActivationPlan) -> int:
        config = _mapping(plan.hop_config)
        try:
            pid = self.host.start_hop(config)
            health = self.host.hop_health(pid, config)
        except HostError as exc:
            raise SwitchError(str(exc), exc.code or "hop_start_failed", exc.evidence) from exc
        self._assert_health_consistent(plan, health)
        return pid

    def _assert_health_consistent(self, plan: ActivationPlan, health: Mapping[str, object]) -> None:
        if health.get("ok") is not True:
            raise SwitchError("hop health is not ok", "hop_health")
        expected = {
            "profileId": plan.target,
            "protocol": plan.protocol,
            "model": plan.model,
            "resolvedEndpoint": plan.resolved_endpoint,
        }
        for key, value in expected.items():
            if health.get(key) != value:
                raise SwitchError("hop health is internally inconsistent", "protocol_mismatch", {"field": key})
        if plan.auth_type == "none":
            if health.get("credentialLoaded") is True:
                raise SwitchError("hop health is internally inconsistent", "protocol_mismatch")
        elif health.get("credentialLoaded") is not True:
            raise SwitchError("hop health is internally inconsistent", "protocol_mismatch")
        if health.get("service") != "grokctl-provider-hop":
            raise SwitchError("hop health is internally inconsistent", "protocol_mismatch")

    def _install_active(self, plan: ActivationPlan, hop_pid: Optional[int]) -> None:
        self.host.install_bundle(Path(plan.staged_paths.bundle))
        if plan.target_kind == "official":
            if self.host.layout.config_path.is_file():
                self.host.disable_config()
            if plan.previous_profile != OFFICIAL_ID:
                previous = self.catalog.get(plan.previous_profile)
                auth = previous.get("auth") or {}
                secret_ref = auth.get("secretRef") if isinstance(auth, dict) else None
                if secret_ref:
                    self.host.remove_secret(str(secret_ref))
            if self.host.read_hop_pid() is not None:
                self.host.stop_hop_if_owner(self.host.layout.hop_cmdline_token)
            if self.host.layout.hop_config_path.exists():
                self.host.layout.hop_config_path.unlink()
        else:
            self.host.install_config(_mapping(plan.host_config))
            atomic_write_bytes(
                self.host.layout.hop_config_path,
                Path(plan.staged_paths.hop_config).read_bytes(),
                mode=0o600,
            )

    def _read_hop_health(self, plan: ActivationPlan, hop_pid: Optional[int]) -> str:
        if plan.target_kind == "official":
            if self.host.read_hop_pid() is not None:
                raise SwitchError("official mode left a hop pid", "pid_ownership")
            return "stopped"
        if hop_pid is None:
            raise SwitchError("missing hop pid after external activation", "hop_health")
        health = self.host.hop_health(hop_pid, _mapping(plan.hop_config))
        self._assert_health_consistent(plan, health)
        return "healthy"

    def _commit(self, plan: ActivationPlan, receipt: ActivationReceipt) -> None:
        try:
            self.host.commit_receipt(receipt.to_dict(), plan.transaction_id)
        except HostError as exc:
            raise SwitchError("activation receipt could not be committed", "missing_receipt") from exc
        self.host.write_state(
            {
                "schemaVersion": 1,
                "generation": plan.generation,
                "activeProfile": plan.target,
                "transactionId": plan.transaction_id,
                "profileDigest": plan.profile_digest,
                "bundleDigest": plan.bundle_digest,
            }
        )

    def _assert_restored(self, plan: ActivationPlan) -> None:
        observed = self.host.observe()
        snap = plan.previous_snapshot
        if observed.bundle_digest != snap.bundle_digest:
            raise SwitchError("restored bundle does not match snapshot", "rollback_failed")
        if observed.profile_id != snap.profile_id:
            raise SwitchError("restored profile does not match snapshot", "rollback_failed")
        if int(observed.generation) != int(snap.generation):
            raise SwitchError("restored generation does not match snapshot", "rollback_failed")

    def _cleanup_pre_restart(
        self,
        plan: ActivationPlan,
        snapshot_written: bool,
        hop_started_pid: Optional[int],
        cause: SwitchError,
    ) -> None:
        evidence = {
            "transactionId": plan.transaction_id,
            "previousProfile": plan.previous_profile,
            "target": plan.target,
            "snapshotDir": plan.staged_paths.snapshot,
            "cause": cause.code,
            "restoreProven": False,
        }
        hop_stop_failed = False
        if hop_started_pid is not None:
            try:
                self.host.stop_pid(hop_started_pid, self.host.layout.hop_cmdline_token)
            except Exception:
                hop_stop_failed = True
                evidence["hopPidLingering"] = hop_started_pid
        if snapshot_written:
            try:
                self.host.restore_snapshot(Path(plan.staged_paths.snapshot))
                self._assert_restored(plan)
                evidence["restoreProven"] = True
            except Exception as exc:
                wrapped = _wrap(exc)
                evidence["restoreError"] = wrapped.code
                raise SwitchError(
                    "pre-restart cleanup could not restore the previous snapshot",
                    "rollback_failed",
                    evidence,
                ) from exc
        try:
            self.host.remove_staging(plan.generation)
        except OSError:
            evidence["stagingCleanup"] = "failed"
        if hop_stop_failed:
            evidence["hopStopFailed"] = True
            raise SwitchError(
                "pre-restart cleanup could not stop the started hop",
                "rollback_failed",
                evidence,
            )
        cause.evidence.update(evidence)

    def _rollback_once(self, plan: ActivationPlan, cause: SwitchError) -> None:
        evidence = {
            "transactionId": plan.transaction_id,
            "previousProfile": plan.previous_profile,
            "target": plan.target,
            "snapshotDir": plan.staged_paths.snapshot,
            "cause": cause.code,
        }
        try:
            self.host.restore_snapshot(Path(plan.staged_paths.snapshot))
            self.host.clear_own_command(plan.supervisor_command_id)
            rollback_id = self.host.ids.new()
            self.host.issue_restart(rollback_id, reason="rollback " + plan.transaction_id)
            new_pid, started_at = self.host.wait_consumed(rollback_id)
            evidence["rollbackCommandId"] = rollback_id
            evidence["rollbackPid"] = new_pid
            evidence["rollbackStartedAt"] = started_at
        except Exception as exc:
            wrapped = _wrap(exc)
            raise SwitchError(
                "rollback failed after post-restart error",
                "rollback_failed",
                {**evidence, "rollbackCause": wrapped.code},
            ) from exc
        raise SwitchError(
            "post-restart failure restored the previous snapshot",
            cause.code,
            evidence,
        )
