# 独立模式验收记录

本记录与旧 Windows 客户端适配方案分开。日期：2026-08-31（Asia/Shanghai）。

## 范围和结构检查

- 对比基线 `0fa4e186ddb0a12e137fa5aff280a505d4e0de4b`。
- 本版只有云端独立模式，不部署任何中继，不修改原版 Windows/Mac 安装，不读取 OAuth 凭据。
- 安装生命周期由 `ops/independent.py` 负责；供应商状态和事务仍由既有服务及 native controller 负责，没有新增切换状态机。
- 发布目录从干净基线单独构建，未包含待续的 relay 文件、第三方 Python 依赖或历史运行数据。
- 按用户“自己完成，不使用 Grok 或子代理”的要求，由主代理执行结构检查。Grok Bot 仅作为实际使用入口，不担任代码作者或审查者。
- 结构检查结论：PASS。重点验证了私有目录、ZIP 路径约束、校验失败拒绝、重复安装、进程归属、仅停止面板、状态查询不触发主机操作和凭据不回显。

## 本地

- 发布工作区 Python：383 项执行，380 通过、3 项平台跳过。
- 发布工作区协议/Node：163 项通过。
- React：35 项通过，TypeScript/Vite 构建通过。
- 独立模式新增测试包含无中继/本机发现调用、只读状态、故障脱敏、外部/官方事务转发、安装包可执行性和确定性、路径穿越/符号链接拒绝。
- 通过维护隧道读取真实云端面板的浏览器 DOM；390px 无横向溢出，深色切换可用，无配对入口。截图接口超时，因此没有把 DOM 检查冒充截图验收。

## 云端安装

- 真实 Linux 云端 Python 3.13.5，未安装 pip/npm 依赖。
- 安装、重复安装复用同一 PID、停止和重新启动均通过；只操作面板进程。
- 安装前后 Grok Bot 主进程 PID `872676`、startedAt `1788105766501` 及主程序 SHA-256 保持不变。
- 安装包未配置供应商、未发送模型请求、未向 supervisor 写重启命令。
- 本阶段由维护连接运行安装程序，不能据此声称 Grok Bot 已执行公开安装提示词。

## de429dc 兼容性

- 主程序 SHA-256：`12df7a63cf7d0eb153697fbfc18494cf4f44eff4f0a1d086703a8c7e8043e1d0`。
- supervisor SHA-256：`54d78fee7222970e3aaf8baee548b87a5c3dded3502f6d39488768cb8a269233`。
- 对照已验收 `17184bb`，推理和语音接入区段 8808 字节逐字一致，区段 SHA-256 为 `c52c15713c3723af85400baae4bb1dd81c7dd8e922e90119cf49dccbfcc1c1a3`。
- supervisor 差异为开机下载代码；命令处理、busy 检查、restart 和 ack 路径未变化。
- 新版实际源码的精确锚点、补丁幂等性、备份身份和 Node 语法测试通过；只新增两个精确哈希，不放开未知版本。
- 初次安装时正确阻止未知版本；新增已审查版本后，读回 `activeProfile=official`、健康、空闲、无待处理命令。

## 正常客户端、云端事务与生产回执

2026-08-30 16:49–16:50 UTC，在未修改的 Mac Grok Bot 0.30.0 中新建测试 Bot，
发送 `Your name is Grok Switch Independent Test. Reply exactly GROK_SWITCH_INDEPENDENT_OK. Do not use any tools.`。
客户端正常聊天返回 `GROK_SWITCH_INDEPENDENT_OK`，已用 Cua Driver 树与截图交叉确认。

- 外部切换：`gbs-f8b77fd0-a3a6-4027-a43d-dd1f480e9ad4`，generation 3，verified。
- 外部主进程：PID `891262`，startedAt `1788108515330`，SHA-256 `35b8e56dfac3208c1ca1fb1dc226634ce9aa515d5ce73d62adedbba3a39aaf8b`。
- 面板运行的是 CI 发布候选包 `299d2864d651764a8197aa6e41d22865cbb2bcd40755bea8ec5bb02947b0ced9`。
- 云端三条 `recentReceipts` 的 request id 与下列生产日志逐条匹配，均为 HTTP 200、streaming=true、OpenAI Chat、grok-4.6。

| 生产日志 id | request id | quota |
|---|---|---:|
| 1657552 | `202608301649388740028578268d9d6wD51D1K0` | 29230 |
| 1657553 | `202608301649521912304248268d9d63mU2jkzi` | 28530 |
| 1657554 | `202608301650011960146258268d9d6ulUjSem6` | 1124 |

三条均为 group `grok`、channel 254、token 2383。测试 Key 的 used_quota 从
4588872 增至 4647756，差额 58884，与表中之和一致。没有输出 Key。
BeefAPI 只用于本轮验收，不在运行包、默认配置或安装提示词中。

恢复官方：`gbs-1bf70dc3-b391-4f05-bdd6-eb116cd0695d`，generation 4，verified。
原版每周用量在测试前后均显示 6%；中间还包含官方对照请求和新 Bot 初始化，
不能据此声称外部测试期间官方额度精确为零。

## 保留的失败与限制

先使用一个已有大量工具/图片历史的 Bot 测试，未获得回复和外部回执，测试 Key 用量未变。
已立即在空闲后恢复官方；同一个 Bot 随后的官方对照返回 `GROK_SWITCH_OFFICIAL_BASELINE_OK`。
新建 Bot 的外部测试成功，但这不能覆盖旧会话的失败。尚未确认具体执行时消息形状的根因。
导出的可读 transcript 不是运行时模型消息，不能凭对导出格式的离线拒绝直接定因。
首版建议新建 Bot 验证，不承诺任意既有富媒体/工具历史均可跨协议续接；不删除或静默丢弃历史。

维护网络的直连 SSH 一度超时，改用既有 Tailscale 用户态转发后可达；云端面板和模型请求均继续运行。
这不是产品要求用户配置 Tailscale，维护网络也未加入独立运行包。

## CI 与发布资产

[CI 33323031919](https://github.com/enderzcx/grok-bot-switch/actions/runs/33323031919) 完成前后端测试、Linux 安装、重复安装复用 PID、状态查询和停止。
[CI 33323540886](https://github.com/enderzcx/grok-bot-switch/actions/runs/33323540886) 对归档来源再次通过验证。
最终 ZIP 采用 CI 原始资产；本地在同一编译后前端输入下重建 SHA-256 一致。

## 公开发布与提示词执行

- `v0.3.0-beta.1` 于 2026-08-30T16:57:09Z 公开发布，非草稿、预览版；tag 指向 `bc39937c6a7043cf47d07950c31fff50966507cf`。
- 主分支 [CI 33323785909](https://github.com/enderzcx/grok-bot-switch/actions/runs/33323785909) 成功。
- 从公开 GitHub 下载地址重新取得 ZIP，SHA-256 与 CI 原件 `299d2864d651764a8197aa6e41d22865cbb2bcd40755bea8ec5bb02947b0ced9` 一致。
- 将发布页的完整提示词直接发送给新建 Bot，没有上传附件。原版 UI 读回 Bot 的下载/校验过程、`ok: true` 安装结果、云端面板 URL 和面板截图。
- 本轮属于已有安装上的幂等自安装验证，不冒充全新云端的首装；全新目录安装另由先前的真实 Linux 手动验收和 CI 验证覆盖。
- 安装完成时 Bot 自己仍在运行，面板正确显示 busy-agent；安装过程没有切换通道或重启主机。服务端读回仍为 official，主进程 PID `892815`、startedAt `1788108777328` 和原厂 SHA-256 未变化，健康、无待处理重启命令。
- 当前 Grok Bot 云端页面由原版客户端可见，用户在云端浏览器中操作，不在本机浏览器打开云端 loopback 地址。
- Cua 使用 CLI：本会话无 Cua MCP 可调用工具，已检查已有 MCP 配置后使用 CLI；原版进程未修改。后台输入为默认，个别无响应的菜单/远程桌面点击使用了有界前台递送，没有使用脚本绕过 GUI 控制。
