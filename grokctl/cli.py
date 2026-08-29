"""Dependency-light grokctl command line."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence, TextIO

from grokctl.models import GrokctlError, NotWiredError, ValidationError, pretty_dumps
from grokctl.service import GrokctlService


PROG = "grokctl"


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # type: ignore[override]
        raise ValidationError("参数无效")


def resolve_home(explicit: str | None, env: Mapping[str, str]) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    raw = env.get("GROKCTL_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path(env.get("HOME", str(Path.home()))) / ".grokctl"


def split_global_flags(argv: Sequence[str]) -> tuple[str | None, bool, list[str]]:
    home: str | None = None
    json_mode = False
    rest: list[str] = []
    i = 0
    items = list(argv)
    while i < len(items):
        arg = items[i]
        if arg == "--json":
            json_mode = True
        elif arg == "--home":
            i += 1
            if i >= len(items):
                raise ValidationError("参数无效")
            home = items[i]
        elif arg.startswith("--home="):
            home = arg.split("=", 1)[1]
        else:
            rest.append(arg)
        i += 1
    return home, json_mode, rest


def _build_parser() -> _ArgumentParser:
    parser = _ArgumentParser(prog=PROG, description="Grok Bot 提供方切换")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", help="查看本地状态")

    providers = sub.add_parser("providers", help="管理提供方")
    providers_sub = providers.add_subparsers(dest="providers_command")
    providers_sub.add_parser("list", help="列出提供方")
    add = providers_sub.add_parser("add", help="添加提供方")
    add.add_argument("--file", required=True, help="提供方 JSON 文件")
    providers_sub.add_parser("show", help="查看提供方").add_argument("profile")
    providers_sub.add_parser("remove", help="删除提供方").add_argument("profile")

    secret = sub.add_parser("secret", help="管理密钥")
    secret_sub = secret.add_subparsers(dest="secret_command")
    secret_set = secret_sub.add_parser("set", help="从标准输入安装密钥")
    secret_set.add_argument("profile")
    secret_set.add_argument("--stdin", action="store_true", help="从标准输入读取密钥")
    secret_sub.add_parser("remove", help="删除密钥").add_argument("profile")

    test = sub.add_parser("test", help="校验提供方配置")
    test.add_argument("profile")
    test.add_argument("--live", action="store_true", help="在线测试（会消耗额度）")

    plan = sub.add_parser("plan", help="查看切换计划")
    plan.add_argument("target")

    use = sub.add_parser("use", help="切换提供方")
    use.add_argument("target")
    use.add_argument("--apply", action="store_true", help="应用到主机")

    verify = sub.add_parser("verify", help="校验当前通道")
    verify.add_argument("--live", action="store_true", help="在线校验（会消耗额度）")

    rollback = sub.add_parser("rollback", help="回滚到上一通道")
    rollback.add_argument("--apply", action="store_true", help="应用到主机")

    activity = sub.add_parser("activity", help="查看本地活动")
    activity.add_argument("--limit", type=int, default=50, help="最多返回条数")

    host = sub.add_parser("host", help="配置本机根目录")
    host_sub = host.add_subparsers(dest="host_command")
    host_configure = host_sub.add_parser("configure", help="从文件写入本机根目录配置")
    host_configure.add_argument("--file", required=True, help="主机 JSON 文件")
    host_sub.add_parser("show", help="查看本机根目录配置")

    ui = sub.add_parser("ui", help="打开本地面板")
    ui.add_argument("--port", type=int, default=0, help="监听端口，0 表示自动分配")
    return parser


def _emit_json(payload: object, stdout: TextIO) -> None:
    stdout.write(pretty_dumps(payload))


def _emit_lines(lines: Iterable[str], stdout: TextIO) -> None:
    text = "\n".join(lines)
    stdout.write(text if text.endswith("\n") else text + "\n")


def _secret_line(secret: Mapping[str, Any]) -> str:
    if secret.get("rejected"):
        return secret.get("reason") or "密钥文件不安全"
    if secret.get("installed"):
        count = secret.get("byteCount")
        prefix = secret.get("fingerprintPrefix")
        return f"已安装 {count} 字节 fingerprint={prefix}"
    if secret.get("required"):
        return "未安装密钥"
    return "无需密钥"


def _format_status(payload: Mapping[str, Any]) -> list[str]:
    host = payload.get("host") or {}
    lines = [
        "状态",
        f"  主目录: {payload['home']}",
        f"  目标通道: {payload.get('desiredProfile')}",
        f"  提供方: {payload['providers']}",
        f"  密钥: {payload['secretsInstalled']} 已安装",
        f"  回退: {payload.get('fallbackPolicy', 'never')}",
    ]
    if not host.get("wired"):
        lines.insert(2, f"  当前通道: {payload.get('desiredProfile')}")
        lines.append("  主机: 未接入")
        return lines
    lines.append(f"  实际通道: {payload.get('observedProfile')}")
    if payload.get("activeProfile"):
        lines.append(f"  生效通道: {payload.get('activeProfile')}")
    lines.append(f"  代数: {payload.get('generation')}")
    lines.append(f"  主机 PID: {host.get('pid')}")
    lines.append(f"  启动时间: {host.get('startedAt')}")
    lines.append(f"  程序校验和: {host.get('bundleDigest')}")
    lines.append(f"  转发: {host.get('hopHealth')}")
    lines.append(f"  漂移: {'是' if payload.get('drift') else '否'}")
    blocking = payload.get("blocking") or []
    if blocking:
        lines.append("  阻塞: " + ", ".join(str(item) for item in blocking))
    receipt = payload.get("lastReceipt") or {}
    if receipt:
        lines.append(f"  最近回执: {receipt.get('transactionId')}")
    return lines


def _format_provider_line(item: Mapping[str, Any]) -> str:
    endpoint = item.get("resolvedEndpoint") or "本地官方通道"
    protocol = item.get("protocol") or item.get("mode")
    return f"{item['id']}\t{item['displayName']}\t{protocol}\t{endpoint}\t{_secret_line(item['secret'])}"


def _format_show(item: Mapping[str, Any]) -> list[str]:
    lines = [
        f"提供方: {item['id']}",
        f"名称: {item['displayName']}",
        f"模式: {item['mode']}",
    ]
    if item.get("protocol"):
        lines.append(f"协议: {item['protocol']}")
    if item.get("model"):
        lines.append(f"模型: {item['model']}")
    method = item.get("resolvedMethod")
    endpoint = item.get("resolvedEndpoint")
    if method and endpoint:
        lines.append(f"地址: {method} {endpoint}")
    else:
        lines.append("地址: 本地官方通道")
    lines.append(f"认证: {item.get('authType')}")
    lines.append(f"回退: {item.get('fallbackPolicy')}")
    lines.append(f"状态: {item.get('state')}")
    lines.append(f"密钥: {_secret_line(item['secret'])}")
    return lines


def _format_plan(payload: Mapping[str, Any]) -> list[str]:
    applied = bool(payload.get("apply")) and not bool(payload.get("dryRun"))
    title = "已应用" if applied else "计划（不会改主机）"
    lines = [
        title,
        f"  动作: {payload.get('action')}",
        f"  目标: {payload.get('target')}",
    ]
    if payload.get("current"):
        lines.append(f"  当前: {payload.get('current')}")
    method = payload.get("resolvedMethod")
    endpoint = payload.get("resolvedEndpoint")
    if method and endpoint:
        lines.append(f"  地址: {method} {endpoint}")
    else:
        lines.append("  地址: 本地官方通道")
    if payload.get("protocol"):
        lines.append(f"  协议: {payload['protocol']}")
    if payload.get("model"):
        lines.append(f"  模型: {payload['model']}")
    lines.append(f"  认证: {payload.get('authType', '-')}")
    lines.append(f"  回退: {payload.get('fallbackPolicy', 'never')}")
    secret = payload.get("secret") or {}
    lines.append(f"  密钥: {_secret_line(secret)}")
    blocking = payload.get("blocking") or []
    if blocking:
        lines.append("  阻塞: " + ", ".join(str(item) for item in blocking))
    return lines


def _format_test(payload: Mapping[str, Any]) -> list[str]:
    title = "配置校验通过" if payload.get("ok") else "配置校验未通过"
    lines = [title, f"提供方: {payload.get('profileId')}"]
    if payload.get("protocol"):
        lines.append(f"协议: {payload['protocol']}")
    if payload.get("model"):
        lines.append(f"模型: {payload['model']}")
    method = payload.get("resolvedMethod")
    endpoint = payload.get("resolvedEndpoint")
    if method and endpoint:
        lines.append(f"地址: {method} {endpoint}")
    else:
        lines.append("地址: 本地官方通道")
    lines.append(f"认证: {payload.get('authType', '-')}")
    lines.append(f"回退: {payload.get('fallbackPolicy', 'never')}")
    lines.append(f"状态: {payload.get('state')}")
    return lines


def _format_host(payload: Mapping[str, Any]) -> list[str]:
    return [
        "本机根目录",
        f"  模式: {payload.get('mode')}",
        f"  根目录: {payload.get('hostRoot')}",
        f"  原厂程序: {payload.get('stockBundle')}",
        f"  已补丁程序: {payload.get('patchedBundle')}",
        f"  已知原厂校验和: {len(payload.get('knownStockDigests') or [])}",
        f"  已知补丁校验和: {len(payload.get('knownPatchedDigests') or [])}",
    ]


def _format_activity(payload: Mapping[str, Any]) -> list[str]:
    events = payload.get("events") or []
    if not events:
        return ["暂无活动"]
    lines = ["活动"]
    for event in events:
        profile = event.get("profileId") or "-"
        lines.append(f"  {event.get('at')}  {event.get('type')}  {profile}")
    return lines


def _dispatch(service: GrokctlService, args: argparse.Namespace, stdin: Any) -> tuple[object, list[str]]:
    command = args.command
    if command is None:
        raise ValidationError("请指定命令")
    if command == "status":
        payload = service.status()
        return payload, _format_status(payload)
    if command == "providers":
        action = args.providers_command
        if action == "list":
            payload = service.list_providers()
            lines = ["提供方"] + [_format_provider_line(item) for item in payload["providers"]]
            return payload, lines
        if action == "add":
            path = Path(args.file)
            try:
                raw = path.read_bytes()
            except OSError as exc:
                raise ValidationError("无法读取配置文件") from exc
            payload = service.add_provider(raw)
            return payload, ["已添加提供方 " + str(payload["id"]), *_format_show(payload)[1:]]
        if action == "show":
            payload = service.show_provider(args.profile)
            return payload, _format_show(payload)
        if action == "remove":
            payload = service.remove_provider(args.profile)
            return payload, [f"已删除提供方 {payload['id']}"]
        raise ValidationError("请指定 providers 子命令")
    if command == "secret":
        action = args.secret_command
        if action == "set":
            if not getattr(args, "stdin", False) and hasattr(stdin, "isatty") and stdin.isatty():
                raise ValidationError("请使用 --stdin 并通过标准输入提供密钥")
            payload = service.set_secret(args.profile, stdin)
            secret = payload["secret"]
            return payload, ["密钥已安装", f"提供方: {payload['id']}", _secret_line(secret)]
        if action == "remove":
            payload = service.remove_secret(args.profile)
            return payload, [f"已删除密钥 {payload['id']}"]
        raise ValidationError("请指定 secret 子命令")
    if command == "test":
        payload = service.test_profile(args.profile, live=bool(args.live))
        return payload, _format_test(payload)
    if command == "plan":
        payload = service.plan(args.target)
        return payload, _format_plan(payload)
    if command == "use":
        payload = service.use(args.target, apply=bool(args.apply))
        return payload, _format_plan(payload)
    if command == "verify":
        payload = service.verify(live=bool(args.live))
        return payload, _format_test(payload)
    if command == "rollback":
        payload = service.rollback(apply=bool(args.apply))
        return payload, _format_plan(payload)
    if command == "activity":
        payload = service.activity(limit=args.limit)
        return payload, _format_activity(payload)
    if command == "host":
        action = args.host_command
        if action == "configure":
            path = Path(args.file)
            try:
                raw = path.read_bytes()
            except OSError as exc:
                raise ValidationError("无法读取配置文件") from exc
            payload = service.configure_host(raw)
            return payload, ["已配置本机根目录", *_format_host(payload)[1:]]
        if action == "show":
            payload = service.show_host()
            return payload, _format_host(payload)
        raise ValidationError("请指定 host 子命令")
    if command == "ui":
        service.ui(port=int(args.port))
        raise NotWiredError("本地面板尚未接入")
    raise ValidationError("未知命令")


def main(
    argv: Sequence[str] | None = None,
    *,
    stdin: Any = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
    argv_list = list(sys.argv[1:] if argv is None else argv)
    stdin = sys.stdin if stdin is None else stdin
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    env = os.environ if env is None else env

    json_mode = False
    try:
        home, json_mode, rest = split_global_flags(argv_list)
        parser = _build_parser()
        args, extra = parser.parse_known_args(rest)
        if extra:
            if args.command == "secret":
                raise ValidationError("密钥不能通过命令行参数传入")
            raise ValidationError("参数无效")
        if args.command is None:
            raise ValidationError("请指定命令")
        service = GrokctlService(resolve_home(home, env))
        payload, lines = _dispatch(service, args, stdin)
        if json_mode:
            _emit_json(payload, stdout)
        else:
            _emit_lines(lines, stdout)
        return 0
    except GrokctlError as exc:
        if json_mode:
            _emit_json(exc.to_public_dict(), stdout)
        else:
            stderr.write(exc.message + "\n")
        return exc.exit_code
    except BrokenPipeError:
        return 0
    except Exception:
        message = "内部错误"
        if json_mode:
            _emit_json({"ok": False, "error": {"code": "internal", "message": message}}, stdout)
        else:
            stderr.write(message + "\n")
        return 1
