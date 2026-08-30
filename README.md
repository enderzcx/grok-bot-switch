# grokctl — Grok Bot Provider Switcher

一个不绑定供应商的 Grok Bot 通道管理工具：保存任意兼容服务的 URL、模型和 API key，明确选择协议，并在官方通道与外部通道之间规划切换。非 xAI / X 官方项目。

**当前是本地实验版，不是已接入真实主机的成品。** 配置管理、CLI、浏览器面板、三协议适配器和 host 补丁编译器已实现；切换事务目前只连接模拟主机。真实 SSH/云主机执行器、在线验证和供应商 OAuth 适配器尚未实现，不能用模拟 PID、健康状态或测试结果证明生产切换成功。

## 使用

Python 3.10+；运行协议/host 测试另需 Node.js。无需安装运行时第三方依赖。在仓库目录运行：

```bash
python3 -m grokctl --home runtime/operator-state ui
```

打开输出的 `http://127.0.0.1:<port>` 地址。面板可以添加供应商、单独安装密钥、显示完整请求端点、检查配置和查看切换计划。按 Ctrl+C 关闭。面板不监听外网，写操作要求会话令牌；密钥写入后不再返回浏览器。

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

高级 `endpointPath` 是完整绝对路径覆盖，不是再追加到根地址路径。程序不会猜协议，也不会在协议失败后换另一种重试。具体模型是否支持工具、推理或图像仍取决于供应商能力；不支持的语义应报错，不能假装兼容。

`official` 是内置的原厂通道，不等于 xAI API key 通道。xAI 或任何其他兼容 API 都作为普通自定义 profile 配置。认证支持 `none`、`bearer`、`x-api-key`；`oauth-adapter` 目前仅保留显式契约并阻止未接入的适配器，不接受通用 OAuth token 导入。

## 安全与真实边界

- 外部模式所有推理 session 均路由到 loopback hop；失败不自动回落到官方。
- key 只由 hop 持有；host 配置不含凭据。配置和 secret 分文件、仅当前用户可读写。
- 当前通道与恢复流程引用中的密钥禁止原地轮换或删除；需要更换时新建通道再切换。切回官方不会删除已保存密钥。
- HTTPS 外部 URL、明确的请求路径、安全请求头、DNS/IP 检查和禁止重定向共同约束上游；这不是任意 URL 代理。
- host 补丁仅对已验证的 0.30 bundle hash 与唯一锚点编译；未知版本拒绝。不会自动修改已安装 App。
- `host configure` 当前只接受 `lab-local-root`，明确显示 `lab-synthetic`；默认禁止模拟 apply。即使测试显式开启模拟 apply，也不会重启真实 Grok Bot。
- `switch-back`（兼容别名 `rollback`）校验上一份回执/快照后，按当前 profile 重新发起切换，**不是按历史快照原样恢复**。事务执行失败时的内部恢复另有快照保护。
- `test --live`、`verify --live` 尚未接入，会明确报错。不宣称原生额度为零，也不宣称任何第三方已完成生产兼容验收。

## 验证与下一阶段

```bash
python3 -m unittest discover -s tests
node --test tests/*.test.mjs
python3 -m grokctl --help
```

[完整实现合同](docs/provider-switcher-v0.1.md)包含产品形态、模块职责、安全边界、验收矩阵和真实上线门槛；[本轮交付记录](docs/provider-switcher-local-evidence.md)记录本地证据及尚未完成项。

后续先实现真实主机适配器与安装/升级流程，再经单独授权进行 `official → custom → official` 的真实 Grok Bot 消息、PID/hash、供应商回执及额度读回。现有 BeefAPI 专用实验代码只作为兼容/回归样本保留，不是通用核心依赖。
