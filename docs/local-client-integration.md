# 本机 Grok Bot 接入边界

> 当前结论（2026-08-30 晚）：Windows 0.28.0 已完成原生连接、真实自定义 API 对话、供应商回执和切回官方验收。下文保留早期勘察经过；当前状态以 [原生接入验收记录](native-client-rollout.md) 为准。Mac 安装未修改。

## 已确认的产品入口

用户要求自动识别本机已经安装的 Grok Bot。不得把 SSH、Tailscale、云主机地址等工程运维配置变成使用前提。Windows 是验收平台，不是要求在 Windows 安装云主机运行环境。

## 本轮实际完成

- 自动发现 macOS `/Applications/Grok Bot.app`、用户 Applications 目录；Windows 检查 Grok Bot 卸载注册表的安装位置及常见安装目录。
- 只读取安装包的公开元数据：macOS Info.plist 与 Electron ASAR 的 package.json；不读取登录凭据、OAuth、Cookies、用户设置。
- 有界解析 ASAR header/package.json，验证应用身份与可执行文件；多个安装标为歧义，不能当成已选择目标。
- 状态明确区分检测到安装与接入/激活。只检测到安装时不得显示“使用中”。

## 当前 Mac 只读证据，2026-08-30

- 路径：`/Applications/Grok Bot.app`
- Bundle ID：`com.anysphere.sand`
- 版本：`0.30.0`
- package：`name=sand`、`productName=Grok Bot`、`main=dist/electron-main/main.cjs`
- app.asar SHA-256：`4bbcd2f7af9f54cd1b354bd7b3c8376da569657a80f6560edac9b3280299a394`

静态检查 `dist/electron-main/main.cjs`：

- `setAgentDefaultModel` 接受 `{modelId,maxMode,parameters}`，调用 `syncHostSettingsToBox` 并等待读回，不是任意供应商配置。
- `setHostSettings` 的验证 schema 包含 agentDefaultModel、computerUseModel 等字段，没有自定义 provider URL/key 字段。
- `SAND_BACKEND_URL` / `CURSOR_API_BASE_URL` 是整个账号/控制面 transport 的基址，不是可直接接 Chat Completions 的替代端点。不能拿它冒充推理供应商切换。
- `startDevControlServer` 只在未打包开发应用中启动；不能把开发接口当成当前已安装发行版可用的开放接口。

结论是“尚未找到可直接复用的供应商切换入口”，不是证明所有接入方式都不可能。本机自动发现已完成，真实供应商切换没有完成。

## 下一步决策边界

需验证一个受控的本机客户端适配层。建议先用独立副本验证，不修改当前安装，不复制登录数据；若需要登录由用户在副本中完成正常授权。只有适配机制验证后，才讨论对现有安装的正式接入与恢复方案。

现有项目合同禁止修改 `/Applications/Grok Bot.app`、导入真实 OAuth 和未经授权的付费请求。本轮没有扩大这些权限。独立副本或安装包改动涉及产品接入方式，应先向用户说明范围，不能静默替换已安装客户端。

## Windows 实机检查，2026-08-30

用户要求直接在 Windows 验收，现已直接使用 Windows 已安装客户端进行只读检查，没有复制 Mac 的登录态。

- 实际安装：`F:\grok-bot\Grok Bot\Grok Bot.exe`，包版本 `0.28.0`，进程正在运行。
- 注册表条目为 `Grok Bot 0.28.0`，没有 InstallLocation；DisplayIcon 为 `F:\grok-bot\Grok Bot\Grok Bot.exe,0`。
- 原检测只匹配无版本后缀的名称和 InstallLocation，造成漏检。已修复对版本后缀、DisplayIcon 与带引号路径的支持，仍排除另一个名称为 Grok 的不同应用；最终继续用 ASAR 元数据验证身份。
- 修复后默认自动发现读回：`detected=true`，路径如上，`version=0.28.0`；`integrationReady=false`。
- Windows 原生 10 项安装检测测试及 7 项平台权限/锁测试通过，新 Windows 包已构建成功。
- 原版 Grok Bot 真实窗口截图显示登录首页，尚未登录。正常 Bot 回合、登录后接口与供应商切换未验收；需要用户在 Windows 原版中正常登录，不复制任何凭据。
- app.asar SHA-256：`3476b583b2757ec94b155197a20d0ebe0123929ec280483726cc3d8d6caa5591`。
- Windows 0.28.0 静态接口检查同样未发现自定义 provider URL/key 设置入口；不能以识别成功冒充切换成功。

### Windows 登录后核验

用户完成登录后，已通过原版客户端的真实窗口确认 Bot 列表、账户菜单和设置页正常显示。设置页包含本机执行权限、外观、自动审核等，账户菜单显示用量；没有在这些可见入口找到自定义供应商 URL/key。

此次只读核验未发送新消息、未修改权限、未导入凭据、未重启原版客户端。登录不再是阻塞；真正未完成的是客户端与推理执行的适配。任何客户端安装文件改造和重启试验应单独明确授权，不把“用户已登录”当作这些操作的许可。
