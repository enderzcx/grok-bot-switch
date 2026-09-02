# Grok Bot Switch

让 Grok Bot 用你自己的模型 API。一段提示词装好，之后在聊天框里打 `/gs use xxx` 切换、`/gs official` 切回。支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议，也能直接用 ChatGPT 订阅（Codex 登录）。非 xAI / X 官方项目。

## 怎么用

**第一步：把下面这段发给 Grok Bot**（把 `myapi`、地址、模型、key 换成你的）：

> 请在你的云端电脑执行下面这条命令，然后把完整输出原样发给我，不要做别的事：
>
> `mkdir -p /workspace/grok-switch && curl -fsSL https://raw.githubusercontent.com/enderzcx/grok-bot-switch/main/dist/grok-switch.cjs -o /workspace/grok-switch/grok-switch.cjs && node /workspace/grok-switch/grok-switch.cjs use myapi --protocol openai-chat --url https://api.example.com/v1 --model gpt-5 --key sk-xxxx`

Bot 会下载工具、先向你的 API 发一条测试请求（地址、key、模型任何一个不对都会在这里报出来，什么都不会改）、给云端主程序打补丁、申请一次重启。它回复完这一轮后主程序重启，之后**新对话**就走你的模型。发一句 `/gs status` 可以确认。

**第二步：以后在聊天框里切换**，不需要终端，不调用模型，不花 token：

| 在聊天框里发 | 效果 |
|---|---|
| `/gs official` | 切回官方 Grok，下一条消息生效 |
| `/gs use myapi` | 切到已保存的供应商，下一条消息生效 |
| `/gs status` | 看当前走哪里、保存了哪些供应商 |

再加一个供应商，把第一步的提示词换个名字和参数再发一次即可；已保存的供应商都会保留，随时 `/gs use` 切换。

`--protocol` 按供应商选：`openai-chat`（绝大多数中转站、DeepSeek、xAI API 等）、`openai-responses`（OpenAI 官方 Responses 接口）、`anthropic-messages`（Claude 官方或兼容接口）。请求地址 = `--url` + 协议默认路径（`/chat/completions`、`/responses`、`/messages`），特殊路径用 `--endpoint` 指定。

### 用 ChatGPT 订阅（Codex 登录）

不需要 API key，用的是你的 ChatGPT Plus/Pro 额度。先让 Bot 在云端安装 Codex CLI 并用设备码登录：

> 请在你的云端电脑执行 `npm i -g @openai/codex && codex login --device-auth`，把它显示的网址和验证码发给我，等我在浏览器里完成登录后再告诉我结果。

登录完成后发：

> 请在你的云端电脑执行 `node /workspace/grok-switch/grok-switch.cjs use chatgpt --auth codex --model gpt-5.4` 并把完整输出原样发给我。

（第一次用还没下载工具的话，把上面第一步命令里的 `use myapi ...` 部分换成这一段。）它会自动走 Responses 协议和 `https://chatgpt.com/backend-api/codex`，token 过期时自动刷新。**注意**：这是让 Codex 后端为非 Codex 程序提供服务，OpenAI 条款上是擦边行为，账号有被限制的可能，自行权衡。

### 关于 key 经过聊天

第一步的提示词里带着 API key，它会出现在你和 Grok Bot 的聊天记录里。介意的话，在 Grok Bot 的云端终端里自己敲同一条命令即可（命令完全相同），或者用 `--key-file <路径>` / 环境变量 `GROK_SWITCH_API_KEY`。`/gs` 聊天命令不接受 key，只能切换已保存的供应商。

## 终端命令

云端终端里 `node /workspace/grok-switch/grok-switch.cjs <命令>`：

| 命令 | 作用 |
|---|---|
| `use <name> [选项]` | 切到某个供应商；带选项时先保存/更新它，并先发一条测试请求（`--no-test` 跳过）。必要时打补丁并申请重启 |
| `official` | 切回官方 Grok，配置保留 |
| `add <name> <选项>` / `remove <name>` | 保存或删除供应商，不切换 |
| `list` | 列出供应商和当前选中项 |
| `status [--json]` | 主程序是否打补丁、进程是否已重启到新代码、当前路由、各供应商累计请求数和 token、最近请求 |
| `test <name> [--json]` | 向供应商发一条测试请求 |
| `log [N]` | 最近 N 条上游请求：状态码、耗时、token、错误原因 |
| `restart` | 主动请求 supervisor 重启主程序 |
| `restore` | 去掉补丁、恢复原厂主程序并重启 |

供应商选项：`--url`、`--model`、`--protocol`、`--key` / `--key-file`、`--auth bearer|x-api-key|none|codex`、`--endpoint /自定义/路径`、`--header 'Name: value'`（可重复）、`--reasoning low|medium|high`、`--max-tokens N`（Anthropic 默认 8192）。

## 原理

Grok Bot 的推理请求不是从你的 Mac/Windows 发出的，而是从它的云端 Linux 电脑里的主程序 `/home/box/sand-host/host-main.cjs` 发出的。本工具把一段包装代码接到主程序创建推理会话的地方，每次新建会话时读一遍 `/workspace/grok-switch/config.json`：

- 没有选中的供应商 → 走官方 Grok，行为不变。
- 选中了供应商 → 直接从云端 `fetch` 你的 API，带上 key；请求、流式回复、工具调用、推理内容都按协议转换。
- 最后一条用户消息以 `/gs` 开头 → 在主程序里直接执行、直接回复，不发给任何模型。

因为路由是每次会话时决定的，切换只是改配置文件，**不需要重启**。只有第一次打补丁（以及 Grok Bot 升级覆盖了主程序之后重新打补丁）需要重启一次主程序，重启由 Grok 自带的 supervisor 在没有 Bot 忙碌时执行。补丁只依赖主程序里 `createHostInference` 这一个函数名，不校验版本哈希；写入前 `node --check`，原文件备份为 `host-main.cjs.grok-switch.orig`，`restore` 后逐字节一致。

## 边界与注意

- 切换影响同一云端上的所有 Bot；语音转写、标题生成等非推理功能在外部模式下不走供应商（标题/标注回调被跳过，语音仍走官方）。
- 配置文件包含 API key，权限 600，只对当前云端用户可读。请求日志不含 key。
- 选中供应商后如果请求失败（key 错、余额不足、供应商挂了），对话直接报错并写入 `log`，**不会**悄悄回落到官方计费。
- Grok Bot 升级会覆盖主程序、补丁丢失，`status` 会提示；再跑一次 `use <name>`（或把第一步提示词再发一次）即可。如果某个新版本改了结构，`use` 会拒绝并保持原文件不动。
- 旧对话可以直接切换。官方 Grok 产生的历史里有外部协议无法表达的内容（脱敏推理、带签名的推理、工具返回的截图、文件附件），会按规则降级而不是报错：脱敏推理丢弃；没有本协议 providerState 的推理不回放（Chat Completions 一律不回放推理）；工具截图在 Anthropic 里放进 `tool_result`，在 OpenAI 两种协议里紧跟一条带图的用户消息；文件附件替换为一行占位文字；空的助手消息跳过。

## 开发

```sh
npm test        # 构建 dist/grok-switch.cjs 并运行全部测试（无第三方依赖，Node 20+）
```

`src/protocols/` 是三种协议的转换器，`src/runtime.cjs` 是注入主程序的路由、聊天命令和流式代码，`src/cli.cjs` 是命令行；`build.mjs` 把它们拼成 `dist/grok-switch.cjs`。测试把构建产物的注入段加载到模拟的主程序作用域里运行，并对一个合成主程序（本地有真实主程序时也会对它）执行打补丁、测试请求、重启请求、恢复的完整流程。

MIT License。
