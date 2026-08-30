"""Desktop orchestration over the paired native client, never synthetic state."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import time

from grokctl import client_bridge
from grokctl.installation import discover_installation
from grokctl.models import ConflictError, GrokctlError, OFFICIAL_ID


class NativeClientService:
    def __init__(self, service):
        self.service = service
        self.home = service.home

    def configured(self):
        return any(os.path.lexists(self.home / name) for name in ("client-bridge.json", "bridge-enabled.json"))

    def installation(self):
        found = discover_installation()
        if found.get("ambiguous") or len(found.get("installations", [])) != 1:
            raise GrokctlError("未找到唯一的 Grok Bot 安装，请先安装并打开一次。", code="client-not-found")
        return found["installations"][0]

    def client_status(self):
        try:
            executable = self.installation()["executable"]
        except GrokctlError:
            executable = None
        return client_bridge.status(self.home, executable)

    def _call(self, action, **kwargs):
        try:
            return client_bridge.call(self.home, action, installed_executable=self.installation()["executable"], **kwargs)
        except client_bridge.ClientBridgeError as error:
            messages = {"probe-only": "当前是连接测试模式，请完成接入后使用。",
                        "probe-busy": "Grok Bot 正在处理另一项操作，请稍后刷新。",
                        "invalid-pairing": "请打开 Grok Bot，并重新连接。",
                        "native-operation-unconfirmed": "操作结果尚未确认，请刷新进度，不要重复切换。"}
            raise GrokctlError(messages.get(error.code, "Grok Bot 未完成此操作，请检查连接和运行状态。"), code=error.code) from None

    def connect(self):
        installation = self.installation()
        state = self.client_status()
        if state.get("mode") != "native-switch" or state.get("connected") is not True:
            from grokctl.client_install import install_adapter
            from grokctl.native_resources import client_source
            try:
                install_adapter(self.home, installation, client_source())
            except Exception as error:
                code = getattr(error, "code", "client-attach-failed")
                messages = {
                    "client-busy": "请先退出 Grok Bot，再点击连接；接入完成后会自动打开。",
                    "unsupported-installation": "当前 Grok Bot 版本尚未支持，安装文件未修改。",
                    "unmanaged-archive": "Grok Bot 安装文件已变化，为保护现有安装，未进行替换。",
                    "recovery-required": "安装结果未能确认，已保留原版备份。请勿重复接入，先检查备份和恢复记录。",
                }
                raise GrokctlError(messages.get(code, "无法接入 Grok Bot，请确认安装目录可写。已有登录与 Bot 不会被删除。"), code=code) from None
            subprocess.Popen([installation["executable"]], stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            until = time.monotonic() + 25
            while time.monotonic() < until:
                state = self.client_status()
                if state.get("mode") == "native-switch" and state.get("hostReachable") is True:
                    break
                time.sleep(0.5)
        if state.get("hostReachable") is not True:
            raise GrokctlError("请确认 Grok Bot 已登录且连接正常，再点击连接。", code="client-not-ready")
        self._call("bootstrap")
        result = self._call("setup")
        self.service._append_activity("client.connected")
        return result

    def projection(self, client):
        runtime = client.get("runtime")
        if client.get("mode") != "native-switch" or not isinstance(runtime, dict):
            return None
        result = {"runtimeKind": "native-host", "host": {"wired": True},
                  "activeProfile": runtime["activeProfile"], "observedProfile": runtime["activeProfile"],
                  "desiredProfile": runtime["desiredProfile"] or "official", "blocking": list(runtime["blocking"]),
                  "activation": runtime.get("activation"), "previousProfile": runtime.get("previousProfile")}
        current = result["activeProfile"]
        if current and current != OFFICIAL_ID:
            try:
                profile = self.service._profile(current)
                if profile.digest() != runtime["profileDigest"]:
                    result["activeProfile"] = None
                    result["blocking"].append("profile-changed")
            except GrokctlError:
                result["activeProfile"] = None
                result["blocking"].append("profile-missing")
        return result

    def plan(self, target):
        profile = self.service._profile(target)
        secret = self.service._secret_for(profile)
        blocks = []
        if secret.rejected:
            blocks.append("secret-rejected")
        elif profile.requires_secret() and not secret.installed:
            blocks.append("needs-key")
        if not profile.enabled:
            blocks.append("disabled")
        plan = {"target": profile.id, "protocol": profile.protocol.value if profile.protocol else None,
                "model": profile.model, "resolvedEndpoint": profile.resolved_endpoint(),
                "runtimeKind": "native-host", "wired": True, "blocking": blocks,
                "liveVerified": False, "dryRun": True}
        if blocks:
            return plan
        result = self._call("plan", profile=profile.to_canonical_dict())
        plan.update(result)
        return plan

    def use(self, target):
        plan = self.plan(target)
        if plan["blocking"]:
            raise GrokctlError("请先补齐该供应商的配置和密钥。", code=plan["blocking"][0])
        profile = self.service._profile(target)
        send = lambda secret=None: self._call("begin", profile=profile.to_canonical_dict(), secret=secret)
        result = self.service.secrets.transfer(profile.id, send) if profile.requires_secret() else send()
        self.service._append_activity("switch.requested", profile_id=profile.id)
        return {**result, "runtimeKind": "native-host", "hostMutation": True, "liveVerified": False}

    def progress(self):
        return self._call("progress")

    def references(self):
        state = self.client_status()
        if state.get("mode") == "probe":
            return set()
        runtime = state.get("runtime")
        if not isinstance(runtime, dict):
            raise ConflictError("暂时无法确认 Grok Bot 的运行配置，请先连接后再修改或删除。")
        activation = runtime.get("activation") or {}
        return {value for value in (runtime.get("activeProfile"), runtime.get("desiredProfile"),
                                    runtime.get("previousProfile"), activation.get("target")) if value}

    def switch_back(self, *, apply=False):
        state = self.client_status()
        runtime = state.get("runtime") or {}
        target = runtime.get("previousProfile")
        if not target:
            raise GrokctlError("尚无可切回的上一通道。", code="missing-receipt")
        return self.use(target) if apply else self.plan(target)
