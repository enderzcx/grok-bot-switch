# Grok Bot Switch

仓库：[`enderzcx/grok-bot-switch`](https://github.com/enderzcx/grok-bot-switch) · CLI：`grokctl` · 状态：Windows 公开预览版

一个不绑定供应商的 Grok Bot 通道管理工具：保存兼容服务的 URL、模型和 API key，明确选择协议，在官方通道与外部通道之间切换。非 xAI / X 官方项目。

产品入口是自动识别本机已安装的 Grok Bot，不要求用户配置 SSH 或 Tailscale。Windows 0.28.0 的可恢复客户端适配、原生连接和切换控制器已通过实机验收；已检查的接口和接入边界见 [本机客户端接入](docs/local-client-integration.md)。

**当前是公开预览版，不是稳定版。** 已在 Windows 完成官方 → 自定义 API → 官方的真实切换，并从普通 Grok Bot 聊天读回 `GROK_BOT_SWITCH_EXTERNAL_OK`，五条外部请求均与供应商生产回执匹配。此次真实协议为 OpenAI Chat；Responses、Messages 已有本地测试，但未完成相同的实机供应商验收。供应商 OAuth 尚未实现。完整证据和限制见 [原生接入验收记录](docs/native-client-rollout.md)。

## 使用

[下载 Windows x64 预览版 v0.2.0-beta.1](https://github.com/enderzcx/grok-bot-switch/releases/tag/v0.2.0-beta.1)。下载后可用同页的 `SHA256SUMS.txt` 校验 ZIP 完整性。

Windows 桌面测试包已可构建：解压后双击 `GrokBotSwitch.exe`，不需要安装 Python/Node。原生窗口、真实主机切换与生产验收的完成状态分开记录，见 [Windows 桌面验收](docs/desktop-windows.md)。下方命令用于源码/CLI 使用。

Python 3.10+；运行协议/host 测试另需 Node.js。Python 服务不需要第三方包，React 前端及依赖已打包在仓库内。在仓库目录运行：

```bash
python3 -m grokctl --home runtime/operator-state ui
```

打开输出的 `http://127.0.0.1:<port>` 地址。面板可以添加供应商、单独安装密钥、显示完整请求端点和检查配置。点击“使用”或“切回上一通道”后自动检查切换条件，通过才执行，不再弹出确认框；失败原因就地显示。删除供应商和移除密钥仍需确认。按 Ctrl+C 关闭。面板不监听外网，写操作要求会话令牌；密钥写入后不再返回浏览器。

CLI 使用相同服务和数据：

```bash
python3 -m grokctl --home runtime/operator-state providers add --file config/custom-provider.example.json
python3 -m grokctl --home runtime/operator-state providers list
python3 -m grokctl --home runtime/operator-state test custom-openai
python3 -m grokctl --home runtime/operator-state plan custom-openai
python3 -m grokctl --home runtime/operator-state status --json
```

需要安装密钥时，使用面板密码框，或 `secret set <profile> --stdin` 从安全输入源读取；不要把真实 key 放到命令参数、配置 JSON 或 shell 历史中。示例配置不含密钥，也不会自动发送请求。

未指定 `--home` 时使用 `GROKCTL_HOME`，再回退到 `~/.grokctl`。本仓库验收始终使用 `runtime/` 或临时目录；不会改变系统 `HOME` 或现有 Grok 登录态。

## 协议不是供应商

| 协议 | 示例根地址 | 默认请求端点 |
|---|---|---|
| `openai-chat` | `https://api.example.com/v1` | `POST /v1/chat/completions` |
| `openai-responses` | `https://api.example.com/v1` | `POST /v1/responses` |
| `anthropic-messages` | `https://api.example.com/v1` | `POST /v1/messages` |

高级 `endpointPath` 替换协议的默认接口后缀，再追加到根地址路径。例如根地址含 `/v1`、接口路径为 `/custom/chat` 时，最终为 `/v1/custom/chat`；若要完全指定路径，根地址只填域名。query 参数保留在最终 URL 末尾。程序不会猜协议，也不会在协议失败后换另一种重试。具体模型是否支持工具、推理或图像仍取决于供应商能力；不支持的语义应报错，不能假装兼容。

`official` 是内置的原厂通道，不等于 xAI API key 通道。xAI 或任何其他兼容 API 都作为普通自定义 profile 配置。认证支持 `none`、`bearer`、`x-api-key`；`oauth-adapter` 目前仅保留显式契约并阻止未接入的适配器，不接受通用 OAuth token 导入。

## 安全与真实边界

- 外部模式所有推理 session 均路由到 loopback hop；失败不自动回落到官方。
- 推理请求由 hop 添加 key；host 的推理配置不含凭据。配置和 secret 分文件、仅当前用户可读写；密钥不会回显给界面。
- 当前通道与恢复流程引用中的密钥禁止原地轮换或删除；需要更换时新建通道再切换。切回官方不会删除已保存密钥。
- HTTPS 外部 URL、明确的请求路径、安全请求头、DNS/IP 检查和禁止重定向共同约束上游；这不是任意 URL 代理。
- host 补丁仅对固定的已知 bundle hash 与唯一锚点编译；未知版本拒绝。首次点击连接会备份并适配已支持的 Windows 安装；运行中的客户端不会被强制关闭。Mac 目前只检测，不修改安装。
- 切换影响当前云端的所有 Bot。地址和供应商密钥会提交到该云端的私有目录；原有账号凭据留在原生客户端进程内。
- 切换结果必须经过原生重启回执、新进程身份和健康状态确认。等待中的命令不强制重启；不确定的结果停止后续切换。外部模式暂不支持原生语音转写，不回退官方语音。
- `host configure` 当前只接受 `lab-local-root`，明确显示 `lab-synthetic`；默认禁止模拟 apply。即使测试显式开启模拟 apply，也不会重启真实 Grok Bot。
- `switch-back`（兼容别名 `rollback`）校验上一份回执/快照后，按当前 profile 重新发起切换，**不是按历史快照原样恢复**。事务执行失败时的内部恢复另有快照保护。
- `test --live`、`verify --live` 尚未接入，会明确报错。不宣称原生额度为零，也不宣称任何第三方已完成生产兼容验收。
- 当前单次 host 请求截止时间为 120 秒；成功响应总量上限 64 MiB、单个 SSE 事件 1 MiB。超过限制明确失败，不换供应商重试。

## 验证与下一阶段

### CC Switch 前端源码移植

当前面板直接移植并改造自 CC Switch 的 React 源码，不再维护此前手写的 HTML/JS 面板。包含 15 份原样组件/工具源码，以及适配 Grok Bot 的供应商卡片、操作区和全屏表单。保留上游主题和交互，数据调用改接 `grokctl`，不带入 Tauri 或其它客户端的配置写入逻辑。

来源、固定 commit 和改造清单见 [frontend/UPSTREAM.md](frontend/UPSTREAM.md)；版权和依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

修改前端后使用 Node 20.19+ 或 22.12+ 在 `frontend/` 执行：

```bash
npm ci
npm test
npm run build
```

构建产物写入 `grokctl/web/`。普通使用者运行 Python CLI 即可，无需启动 Vite 或安装 Tauri。

### 后端验证

```bash
python3 -m unittest discover -s tests
node --test tests/*.test.mjs
python3 -m grokctl --help
```

[完整实现合同](docs/provider-switcher-v0.1.md)包含产品形态、模块职责、安全边界、验收矩阵和真实上线门槛；[本轮交付记录](docs/provider-switcher-local-evidence.md)记录本地证据及尚未完成项。

剩余公开发布门槛包括签名/安装器、升级兼容矩阵和更多供应商协议实测。原生用量界面此次前后均为 100%，不能用这个粗粒度读数证明原生扣费精确为零。BeefAPI 仅用于这次验收；专用实验管理脚本不随桌面包发布，不是通用核心依赖。
