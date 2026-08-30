# Windows 桌面客户端验收

> 最新结论（2026-08-30 晚）：Windows 原生窗口、可恢复客户端接入、官方 → 外部 → 官方切换，以及普通 Bot 对话和匹配的供应商回执已通过。本文件早期 ZIP 是历史产物；最终产物和限制见 [原生接入验收记录](native-client-rollout.md)。仍为未签名内部测试版。

> 方向纠正（2026-08-30，用户确认）：入口必须是自动识别用户本机已安装的 Grok Bot，不能要求用户配置 SSH/Tailscale/云主机。错误添加的连接面板和 API 已撤回。下文 ZIP 和测试为撤回前的历史构建证据，旧 ZIP 不作为当前交付，不代表产品闭环完成。

## 当前边界

桌面客户端使用现有 CC Switch React 界面、Python 控制面和 pywebview 原生窗口。Windows 包内置 Python 与界面资源，不依赖用户安装 Python 或 Node，也不需要保持终端打开。Windows 使用 WebView2，不允许降级到旧 IE 渲染器。

这不是完整真实切换闭环的完成声明。当前保存、编辑、密钥管理可用；本机 Grok Bot 自动发现与真实接入机制仍需核实实现。Windows 不运行 Linux 专属的模拟主机。

## 普通使用

解压 `GrokBotSwitch-windows-x64.zip`，保留整个文件夹，双击 `GrokBotSwitch.exe`。

- 默认数据目录：`%LOCALAPPDATA%\GrokBotSwitch`，不读写 Grok Bot 登录目录。
- 密钥、配置与活动记录使用当前用户专属 DACL；拒绝 junction/reparse 路径。
- 关闭窗口只停止本地控制面板，不停止云端 Grok Bot 或转发进程。
- 同一数据目录只允许一个桌面实例。
- 这是未签名的内部测试包，不是已发布、签名或完成生产验收的版本。不要关闭 Windows 安全防护来运行它。

## 开发构建

在 Windows 项目目录创建独立虚拟环境，安装 `desktop/requirements.txt`，执行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r desktop\requirements.txt
.\desktop\build.ps1 -Python .\.venv\Scripts\python.exe
```

前端有改动时先在 `frontend` 执行 `npm ci`、`npm test`、`npm run build`。构建输出在 `runtime\desktop-build`。构建工具依赖不等于用户运行依赖。

`desktop/installer.iss` 提供后续 Inno Setup 6 每用户安装包配置；当前未安装 Inno 编译器，不能把这个脚本称为已产出的安装程序。安装脚本不删除应用数据，不修改 Grok Bot，不申请管理员权限。

## 2026-08-30 已读回证据

- Windows 11 10.0.26200，x64；Python 3.14.2，PyInstaller 6.22.2，pywebview 6.2.1。
- 原生 Windows portability 7 项测试通过，包含实际 DACL 宽权限拒绝、junction 拒绝、跨进程锁争用及配置/密钥往返。
- Windows desktop 生命周期 4 项、connection 检查 4 项测试通过。
- 打包 exe 的 `--self-check --report <path>` 返回退出码 0：`frozen=true`、`backend=true`、`frontendAssets=true`、`windowTested=false`、`hostModified=false`。该检查不打开窗口，也不使用真实凭据。
- ZIP 已传回 Mac，双方 SHA-256 相同：`750b910b25f2be7be347833beea334b8921d16748ae98a6addfed7d022ef0647`。
- 本地 Python 共 210 项测试通过，其中 2 项 Windows 专属测试在 Mac 跳过并已在 Windows 单独运行；React 26 项、Node 协议 91 项通过。

## 待完成的闭环

1. 核实本机安装的 Grok Bot 的实际配置、进程与接入机制，禁止将工程运维连接暴露成产品前置要求。
2. 实现自动发现本机 Grok Bot、必要授权、切换与结果读回。
3. 单独授权必要变更与付费请求后，完成 official → custom → official 的普通 Grok Bot 对话及供应商回执验证。
4. 安装器构建/安装/卸载、签名与公开发行另做验收，不以便携 ZIP 代替。

参考：[pywebview 打包文档](https://pywebview.flowrl.com/guide/freezing)、[窗口 API](https://pywebview.flowrl.com/api/)。

## 本机入口修复后的 Windows 包

后续已移除 SSH/Tailscale 产品入口，改为自动发现本机安装。Windows 实机发现注册表名为 `Grok Bot 0.28.0` 且只含 DisplayIcon 的安装，补充了回归测试并修复漏检。

新 ZIP SHA-256：`bf673ec36ef42ca9293e110e9691210c4a04fa3f2a5e58bb71f034c00d79a5fd`，与上面的历史包不同。它仍是检测/配置测试包，不是供应商切换已完成的成品。用户随后已完成 Windows 原版登录，真实 Bot 列表及设置页已核验；剩余阻塞是客户端/推理适配，不再是登录。
