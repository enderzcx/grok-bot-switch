# Grok Bot Switch

仓库：[`enderzcx/grok-bot-switch`](https://github.com/enderzcx/grok-bot-switch) · 独立模式预览版

一个不绑定供应商的 Grok Bot 通道管理工具：保存兼容服务的 URL、模型和 API key，明确选择协议，在官方通道与外部通道之间切换。非 xAI / X 官方项目。

用户只需把[安装提示词](docs/install-with-grok.md)交给 Grok Bot。它会下载固定版本、先校验再安装，在自己的云端启动管理面板。然后从原版 Grok Bot 的云端桌面进入面板，填写供应商配置并切换。

不需要用户上传安装包、安装本机 Switch、配置 SSH/Tailscale、另建服务器或使用我们的服务。本版只提供独立模式，自建/托管中继后续再做。完整条件、数据边界和恢复方式见[独立模式说明](docs/independent-mode.md)。

**这是预览版，不是稳定版。** 独立模式已验证新建 Bot 的普通聊天、三条外部生产回执和恢复官方，见[本版验收记录](docs/independent-acceptance.md)。已有复杂工具/图片历史的会话存在失败记录，建议从新建 Bot 开始。仅支持经过校验的云端版本，未知版本拒绝切换；供应商 OAuth 尚未实现。旧 Windows 预览版的[历史验收记录](docs/native-client-rollout.md)与本版分开。

## 使用与源码开发

普通用户使用[安装提示词](docs/install-with-grok.md)，第一次由 Grok Bot 执行安装可能消耗官方额度。密钥只在云端面板密码框中填写，不要粘贴到聊天。

[旧 Windows 预览版 v0.2.0-beta.1](https://github.com/enderzcx/grok-bot-switch/releases/tag/v0.2.0-beta.1)属于历史客户端适配方案，不是本版独立模式安装入口。以下 CLI 命令供开发和本地配置检查，不能在用户电脑上直接控制独立云端。

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
- host 补丁仅对固定的已知 bundle hash 与唯一锚点编译；未知版本拒绝。独立模式不修改 Windows/Mac 的原版安装，用户点击切换时才适配云端主程序；并非整个系统完全无侵入。
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
