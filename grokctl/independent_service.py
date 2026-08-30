"""Cloud-local control plane: no desktop adapter, pairing, or relay."""
from grokctl.models import GrokctlError
from grokctl.native_client_service import NativeClientService
from grokctl.service import GrokctlService


class CloudLocalClient(NativeClientService):
    def configured(self):
        return True

    def _call(self, action, **values):
        if action not in {"inspect", "setup", "plan", "begin", "progress"}:
            raise GrokctlError("不支持此操作", code="unsupported-operation")
        from ops.native_runner import dispatch, public_error
        try:
            return dispatch({"action": action, **values})
        except Exception as error:
            code = public_error(error)
            messages = {
                "unknown-host-bundle": "当前 Grok Bot 云端版本尚未支持，未执行切换。",
                "supervisor-source-mismatch": "当前 Grok Bot 重启组件版本尚未支持，未执行切换。",
                "host-not-healthy-idle": "Grok Bot 正在工作或暂未就绪，请等待任务结束后再切换。",
                "supervisor-command-pending": "云端已有等待处理的操作，请稍后检查。",
                "activation-in-progress": "已有尚未确认的切换，请先检查进度。",
                "active-state-drift": "云端状态已变化，未覆盖现有状态。",
            }
            raise GrokctlError(messages.get(code, "无法完成操作，请检查云端状态。"), code=code) from None

    def connect(self):
        return self._call("setup")

    def client_status(self):
        try:
            runtime = self._call("inspect")
        except GrokctlError as error:
            return {"connected": False, "mode": "native-switch", "transport": "cloud-local",
                    "hostReachable": False, "providerSwitchReady": False,
                    "error": {"code": error.code, "message": str(error)}}
        return {"connected": True, "mode": "native-switch", "transport": "cloud-local",
                "hostReachable": runtime["observation"]["health"],
                "providerSwitchReady": runtime["providerSwitchReady"], "runtime": runtime}


class IndependentService(GrokctlService):
    def _native(self):
        return CloudLocalClient(self)

    def connection_info(self):
        return {"connectionMode": "independent", "installation": None}

    def connect_native(self):
        with self._lock.holding():
            return self._native().connect()

    def pairing_start(self, url):
        raise GrokctlError("独立模式不使用中继", code="unsupported-operation")

    def pairing_revoke(self):
        raise GrokctlError("独立模式不使用中继", code="unsupported-operation")
