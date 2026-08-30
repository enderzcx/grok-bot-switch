"""Journaled native activation, never a synthetic process or supervisor engine.

Post-command uncertainty is deliberately needs-attention: an unhealthy gateway
does not prove the native host stopped. We never kill it or guess a rollback.
"""

from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import uuid

from grokctl.models import parse_profile, canonical_dumps
from grokctl.platform_security import reject_links
from ops import provider_hop


KNOWN_STOCK_SHA256 = frozenset({
    "0035c31a74ac9d7fc9d93532cf37e217d6074143d46b1eeb3c5e79699df2f88f",
    "3c3f986e614aaf8fbec642269da40dd20f1dbd9912bdf8f2390bafd61ec684ef",
})
HANDLE_KEYS = ("pid", "port", "generation", "profileDigest", "configPath", "configDigest", "startedTicks")


class ActivationError(RuntimeError):
    """Fixed error codes only; never exception strings from a provider or key."""


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _reject_path(path):
    absolute = Path(os.path.abspath(path))
    try:
        for part in (*reversed(absolute.parents), absolute):
            reject_links(part)
    except OSError:
        raise ActivationError("unsafe-path") from None


def _read(path, limit=128 * 1024 * 1024):
    _reject_path(path)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ActivationError("unsafe-file")
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise ActivationError("oversized-file")
    return value


def _digest(path):
    return _sha(_read(path)) if os.path.lexists(path) else None


def _json(path):
    if not os.path.lexists(path):
        return None
    value = json.loads(_read(path, 256 * 1024))
    if not isinstance(value, dict):
        raise ActivationError("invalid-journal")
    return value


def _sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _private_dir(path):
    _reject_path(path)
    existed = path.exists()
    if not path.parent.exists():
        _private_dir(path.parent)
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
        raise ActivationError("unsafe-directory")
    if not existed:
        _sync_dir(path.parent)


def _create(path, data):
    _reject_path(path)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    _sync_dir(path.parent)


def _replace(path, data, expected, mode=0o600):
    """Cooperative lock plus last-moment hash fence; no foreign drift overwrite."""
    _reject_path(path)
    if _digest(path) != expected:
        raise ActivationError("file-drift")
    name = None
    try:
        fd, name = tempfile.mkstemp(prefix=".gbs-write-", dir=path.parent)
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if _digest(path) != expected:
            raise ActivationError("file-drift")
        os.replace(name, path)
        _sync_dir(path.parent)
    finally:
        if name is not None and os.path.lexists(name):
            os.unlink(name)


class NativeActivation:
    def __init__(self, root, host, stock_bundle, patched_bundle, hop_manager, *, stock_sha256, patched_sha256):
        if stock_sha256 not in KNOWN_STOCK_SHA256 or not isinstance(patched_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", patched_sha256):
            raise ActivationError("unknown-artifact-pin")
        self.root, self.host = Path(root).absolute(), host
        self.stock, self.patched = Path(stock_bundle), Path(patched_bundle)
        self.stock_sha, self.patched_sha = stock_sha256, patched_sha256
        self.hops = hop_manager
        self.config = self.root / "config" / "external.json"
        self.job_path, self.active_path = self.root / "native-job.json", self.root / "native-active.json"
        self.hop = provider_hop

    @contextmanager
    def _lock(self):
        _private_dir(self.root)
        fd = os.open(self.root / "native.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ActivationError("activation-locked") from None
            yield
        finally:
            os.close(fd)

    def _save(self, path, value):
        _replace(path, canonical_dumps(value).encode(), _digest(path))

    def _artifacts(self):
        try:
            matched = _digest(self.stock) == self.stock_sha and _digest(self.patched) == self.patched_sha
        except Exception:
            matched = False
        if not matched:
            raise ActivationError("artifact-drift")

    def _profile(self, raw):
        try:
            profile = parse_profile(raw, allow_official=True)
            if not profile.enabled:
                raise ValueError()
            if profile.mode != "official":
                if profile.auth.type.value not in self.hop.AUTH_TYPES:
                    raise ValueError()
                self.hop.validate_endpoint(profile.resolved_endpoint())
                self.hop.validate_headers(dict(profile.headers))
            return profile
        except Exception:
            raise ActivationError("invalid-profile") from None

    def _idle(self, observation):
        if observation.get("pendingCommand") is not None:
            raise ActivationError("supervisor-command-pending")
        if observation.get("health") is not True or observation.get("isBusy") is not False:
            raise ActivationError("host-not-healthy-idle")

    def _prepare(self, raw):
        profile = self._profile(raw)
        self._artifacts()
        current = self.host.read_observation()
        if current.get("hostBundleSha256") not in (self.stock_sha, self.patched_sha):
            raise ActivationError("unknown-host-bundle")
        self._idle(current)
        active, job = _json(self.active_path), _json(self.job_path)
        if job and job.get("status") not in ("verified", "failed"):
            raise ActivationError("activation-in-progress")
        if active and (active.get("verified") is not True or current["hostBundleSha256"] != active.get("hostBundleSha256")
                       or _digest(self.config) != active.get("configDigest")):
            raise ActivationError("active-state-drift")
        if active is None and current["hostBundleSha256"] != self.stock_sha:
            raise ActivationError("unmanaged-patched-host")
        generation = max(int((active or {}).get("generation", 0)), int((job or {}).get("generation", 0))) + 1
        return profile, current, active, generation

    def plan(self, profileRaw):
        try:
            profile, current, _, generation = self._prepare(profileRaw)
            return {"status": "planned", "verified": False, "target": profile.id,
                    "mode": profile.mode, "generation": generation, "profileDigest": profile.digest(),
                    "hostBundleSha256": self.stock_sha if profile.mode == "official" else self.patched_sha,
                    "previousPid": current["pid"], "previousStartedAt": current["startedAt"]}
        except ActivationError:
            raise
        except Exception:
            raise ActivationError("plan-unavailable") from None

    def _public(self, job, **overrides):
        result = {key: job.get(key) for key in ("id", "status", "phase", "error", "target", "generation", "profileDigest")}
        result["verified"] = job.get("status") == "verified"
        result.update(overrides)
        return result

    def _hop_ok(self, job):
        if job["mode"] == "official":
            return True
        handle = job["newHop"]
        config = _json(Path(handle["configPath"]))
        if _digest(Path(handle["configPath"])) != handle["configDigest"]:
            return False
        health = self.hops.health(handle)
        expected = {"service": "grokctl-provider-hop", "generation": job["generation"],
                    "profileDigest": job["profileDigest"], "listenHost": "127.0.0.1", "listenPort": handle["port"]}
        expected.update({key: config[key] for key in ("profileId", "protocol", "model", "resolvedEndpoint", "authType")})
        return (isinstance(health, dict) and health.get("ok") is True
                and health.get("credentialLoaded") is (config["authType"] != "none")
                and all(health.get(key) == value for key, value in expected.items()))

    def _compile(self, profile, generation, directory, secret):
        if profile.mode == "official":
            if secret is not None:
                raise ActivationError("unexpected-secret")
            return None
        secret_path = None
        if profile.requires_secret():
            if not isinstance(secret, str) or not secret or len(secret.encode()) > 65536 or secret != secret.strip():
                raise ActivationError("invalid-secret")
            try:
                self.hop.validate_header_value(secret)
            except Exception:
                raise ActivationError("invalid-secret") from None
            secret_path = str(directory / "secret.key")
            _create(Path(secret_path), secret.encode())
        elif secret is not None:
            raise ActivationError("unexpected-secret")
        resolved = profile.resolved_endpoint()
        _, endpoint, _ = self.hop.validate_endpoint(resolved)
        config = {"schemaVersion": 1, "listenHost": "127.0.0.1", "listenPort": 0,
                  "profileId": profile.id, "protocol": profile.protocol.value, "model": profile.model,
                  "resolvedEndpoint": resolved, "endpointPath": endpoint, "authType": profile.auth.type.value,
                  "headers": dict(profile.headers), "timeoutSec": 120, "secretFile": secret_path,
                  "receiptFile": str(directory / "provider-receipts.jsonl"),
                  "generation": generation, "profileDigest": profile.digest()}
        if profile.protocol.value == "anthropic-messages" and "anthropic-version" not in {key.lower() for key in dict(profile.headers)}:
            config["anthropicVersion"] = "2023-06-01"
        _create(directory / "hop.json", canonical_dumps(config).encode())
        self.hop.load_config(directory / "hop.json")
        return config

    def _fence(self, job, bundle_hash, config_hash):
        observed = self.host.read_observation()
        self._idle(observed)
        if any(observed.get(key) != job["previous"][key] for key in ("pid", "startedAt")):
            raise ActivationError("host-identity-changed")
        if observed.get("hostBundleSha256") != bundle_hash or _digest(self.host.host_entry) != bundle_hash or _digest(self.config) != config_hash:
            raise ActivationError("file-drift")
        return observed

    def begin(self, profileRaw, secret=None):
        with self._lock():
            profile, previous, active, generation = self._prepare(profileRaw)
            _private_dir(self.root / "generations")
            _private_dir(self.config.parent)
            directory = self.root / "generations" / (str(generation) + "-" + str(uuid.uuid4()))
            _private_dir(directory)
            original = _read(self.host.host_entry)
            original_config = _read(self.config) if os.path.lexists(self.config) else None
            if _sha(original) != previous["hostBundleSha256"]:
                raise ActivationError("file-drift")
            _create(directory / "original-bundle.cjs", original)
            if original_config is not None:
                _create(directory / "original-config.json", original_config)
            job = {"id": "gbs-" + str(uuid.uuid4()), "status": "pending", "phase": "preparing", "error": None,
                   "target": profile.id, "mode": profile.mode, "generation": generation,
                   "profileDigest": profile.digest(), "previous": previous, "previousActive": active,
                   "directory": str(directory), "previousConfigHash": _sha(original_config) if original_config is not None else None,
                   "targetBundleHash": self.stock_sha if profile.mode == "official" else self.patched_sha,
                   "targetConfigHash": None, "newHop": None, "bundleMode": stat.S_IMODE(self.host.host_entry.stat().st_mode)}
            self._save(self.job_path, job)  # durable snapshot and journal precede all live mutations
            try:
                hop_config = self._compile(profile, generation, directory, secret)
                if hop_config is not None:
                    job["phase"] = "starting-hop"
                    self._save(self.job_path, job)
                    handle = self.hops.start(hop_config, directory)
                    if not isinstance(handle, dict) or set(HANDLE_KEYS) - handle.keys():
                        raise ActivationError("invalid-hop-handle")
                    expected_path = str(directory / "hop.json")
                    if (type(handle["pid"]) is not int or handle["pid"] <= 0 or type(handle["port"]) is not int
                            or not 1 <= handle["port"] <= 65535 or handle["generation"] != generation
                            or handle["profileDigest"] != profile.digest() or handle["configPath"] != expected_path
                            or handle["configDigest"] != _digest(Path(expected_path))
                            or type(handle["startedTicks"]) is not int or handle["startedTicks"] <= 0):
                        raise ActivationError("invalid-hop-handle")
                    job["newHop"] = {key: handle[key] for key in HANDLE_KEYS}
                    self._save(self.job_path, job)
                    if handle["port"] == ((active or {}).get("hop") or {}).get("port") or not self._hop_ok(job):
                        raise ActivationError("hop-not-ready")
                host_config = {"schemaVersion": 1, "enabled": profile.mode != "official", "mode": "external-only",
                               "nativeFallback": False, "fallbackPolicy": "never", "profileId": profile.id,
                               "generation": generation, "profileDigest": profile.digest()}
                if hop_config is not None:
                    host_config.update(protocol=profile.protocol.value, model=profile.model,
                        baseUrl=f"http://127.0.0.1:{job['newHop']['port']}", endpointPath=hop_config["endpointPath"])
                    if profile.parameters:
                        host_config["parameters"] = dict(profile.parameters)
                new_config = canonical_dumps(host_config).encode()
                _create(directory / "external.json", new_config)
                job.update(targetConfigHash=_sha(new_config), phase="installing")
                self._save(self.job_path, job)
                self._artifacts()
                self._fence(job, previous["hostBundleSha256"], job["previousConfigHash"])
                target = self.stock if profile.mode == "official" else self.patched
                target_bytes = _read(target)
                if _sha(target_bytes) != job["targetBundleHash"]:
                    raise ActivationError("artifact-drift")
                _replace(self.host.host_entry, target_bytes, previous["hostBundleSha256"], job["bundleMode"])
                self._fence(job, job["targetBundleHash"], job["previousConfigHash"])
                _replace(self.config, new_config, job["previousConfigHash"])
                expected = self._fence(job, job["targetBundleHash"], job["targetConfigHash"])
                job["restartPrevious"] = expected
                job["phase"] = "issuing-restart"
                self._save(self.job_path, job)
                self.host.issue_restart(job["id"], expected)
                job["phase"] = "awaiting-restart"
                self._save(self.job_path, job)
                return self._public(job)
            except Exception:
                return self._precommand_failure(job)

    def _precommand_failure(self, job):
        failed_phase = job["phase"]
        job.update(status="needs-attention", error="activation-step-failed", phase=failed_phase)
        try:
            current = self.host.read_observation()
            if job.get("restartPrevious") is not None:
                # Publication can succeed before an exception reaches us. Never
                # infer that a command was not consumed from file absence alone.
                job["error"] = "restart-outcome-uncertain"
            elif failed_phase == "starting-hop" and job["newHop"] is None:
                # A failed start call may have spawned a child before failing.
                # Without a verified ownership handle, do not retry or kill it.
                job["error"] = "hop-start-outcome-uncertain"
            else:
                self._idle(current)
                if any(current.get(key) != job["previous"][key] for key in ("pid", "startedAt")):
                    raise ActivationError("host-identity-changed")
                bundle, config = _digest(self.host.host_entry), _digest(self.config)
                if bundle not in (job["previous"]["hostBundleSha256"], job["targetBundleHash"]) or config not in (job["previousConfigHash"], job["targetConfigHash"]):
                    raise ActivationError("file-drift")
                directory = Path(job["directory"])
                old_bundle = _read(directory / "original-bundle.cjs")
                old_config = _read(directory / "original-config.json") if job["previousConfigHash"] is not None else None
                if _sha(old_bundle) != job["previous"]["hostBundleSha256"] or (None if old_config is None else _sha(old_config)) != job["previousConfigHash"]:
                    raise ActivationError("snapshot-drift")
                if bundle != job["previous"]["hostBundleSha256"]:
                    _replace(self.host.host_entry, old_bundle, bundle, job["bundleMode"])
                if config != job["previousConfigHash"]:
                    if old_config is None:
                        if _digest(self.config) != job["targetConfigHash"]:
                            raise ActivationError("file-drift")
                        self.config.unlink()
                        _sync_dir(self.config.parent)
                    else:
                        _replace(self.config, old_config, config)
                if job["newHop"] is not None:
                    stopped = self.hops.stop(job["newHop"])
                    if not isinstance(stopped, dict) or stopped.get("stopped") is not True:
                        raise ActivationError("hop-cleanup-pending")
                job.update(status="failed", rolledBack=True)
        except Exception:
            job["error"] = "recovery-needs-attention"
        self._save(self.job_path, job)
        return self._public(job)

    def progress(self):
        with self._lock():
            job = _json(self.job_path)
            if job is None:
                return {"status": "idle", "verified": False}
            if job["status"] in ("verified", "failed"):
                return self._public(job)
            current = self.host.read_observation()
            pending = current.get("pendingCommand")
            if pending is not None:
                # Pending is expected. This path does not write a journal, touch
                # a bundle/config, stop a hop, clear a command, or reissue one.
                if pending == {"id": job["id"], "kind": "restart"}:
                    return self._public(job, status="pending", phase="awaiting-restart", verified=False)
                return self._public(job, status="needs-attention", error="foreign-command-pending", verified=False)
            if job.get("restartPrevious") is None:
                return self._public(job, status="needs-attention", error="precommand-outcome-uncertain", verified=False)
            try:
                receipt = self.host.restart_receipt(job["id"], job["restartPrevious"])
                if receipt.get("verified") is not True:
                    return self._public(job, status="needs-attention", error="restart-not-verified", verified=False)
                observed = receipt["observation"]
                if (observed.get("hostBundleSha256") != job["targetBundleHash"]
                        or _digest(self.host.host_entry) != job["targetBundleHash"]
                        or _digest(self.config) != job["targetConfigHash"] or not self._hop_ok(job)):
                    return self._public(job, status="needs-attention", error="activation-readback-mismatch", verified=False)
                active = {key: job[key] for key in ("id", "target", "mode", "generation", "profileDigest")}
                active.update(hostBundleSha256=job["targetBundleHash"], configDigest=job["targetConfigHash"],
                              pid=observed["pid"], startedAt=observed["startedAt"], hop=job["newHop"], verified=True)
                self._save(self.active_path, active)
                job.update(status="verified", phase="committed", error=None)
                self._save(self.job_path, job)
                old_hop = (job["previousActive"] or {}).get("hop")
                if old_hop is not None:
                    try:
                        stopped = self.hops.stop(old_hop)
                        if not isinstance(stopped, dict) or stopped.get("stopped") is not True:
                            raise ActivationError("hop-cleanup-pending")
                    except Exception:
                        job["error"] = "old-hop-cleanup-needs-attention"
                        self._save(self.job_path, job)
                return self._public(job)
            except Exception:
                return self._public(job, status="needs-attention", error="activation-readback-unavailable", verified=False)
