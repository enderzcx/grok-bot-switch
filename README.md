# Grok Bot Switch

让 Grok Bot 用你自己的模型 API（OpenAI Chat / OpenAI Responses / Anthropic Messages 兼容接口）。一个文件，一条命令，切换不用重启。非 xAI / X 官方项目。

## 原理

Grok Bot 的推理请求不是从你的 Mac/Windows 发出的，而是从它的云端 Linux 电脑里的主程序 `/home/box/sand-host/host-main.cjs` 发出的。本工具把一段包装代码接到主程序创建推理会话的地方；每次新建会话时读一遍 `/workspace/grok-switch/config.json`：

- 没有选中的供应商 → 走官方 Grok，行为不变。
- 选中了供应商 → 直接从云端 `fetch` 你的 API，带上 key；请求、流式回复、工具调用、推理内容都按协议转换。

因为路由是每次会话时决定的，切换供应商、切回官方只是改配置文件，**不需要重启**。只有第一次打补丁（以及 Grok Bot 升级覆盖了主程序之后重新打补丁）需要重启一次主程序，重启由 Grok 自带的 supervisor 在没有 Bot 忙碌时执行。

## 安装与使用

在 Grok Bot 的云端终端里（不是你本机）：

```sh
mkdir -p /workspace/grok-switch
curl -fsSL https://raw.githubusercontent.com/enderzcx/grok-bot-switch/main/dist/grok-switch.cjs -o /workspace/grok-switch/grok-switch.cjs
alias gs='node /workspace/grok-switch/grok-switch.cjs'

gs use myapi --url https://api.example.com/v1 --model gpt-5 --key sk-xxx
gs status
```

`use` 会保存供应商、把主程序打上补丁（原文件备份为 `host-main.cjs.grok-switch.orig`）、请求一次重启。重启完成后新对话就走你的 API。之后：

```sh
gs test myapi        # 真发一条小请求，看能不能通、回什么、花多少 token
gs official          # 切回官方 Grok，下一轮对话生效，供应商配置保留
gs use myapi         # 再切回来，同样下一轮生效
gs log               # 最近的上游请求：状态码、耗时、token、错误原因
gs restore           # 彻底卸载：去掉补丁并重启，恢复原厂主程序
```

也可以让 Grok Bot 代劳下载，把下面这段发给它即可：

> 在你的云端电脑执行 `mkdir -p /workspace/grok-switch && curl -fsSL https://raw.githubusercontent.com/enderzcx/grok-bot-switch/main/dist/grok-switch.cjs -o /workspace/grok-switch/grok-switch.cjs && node /workspace/grok-switch/grok-switch.cjs status`，把输出原样发给我，不要运行其它命令。

之后的 `use` 命令建议自己在云端终端敲，这样 API key 不经过聊天记录。如果让 Bot 执行 `use`，它自己的这一轮会话还在运行，重启会等它回答结束后进行。key 也可以用 `--key-file <path>` 或环境变量 `GROK_SWITCH_API_KEY` 传入。

## 命令

| 命令 | 作用 |
|---|---|
| `use <name> [选项]` | 切到某个供应商；带选项时先保存/更新它。必要时打补丁并请求重启 |
| `official` | 切回官方 Grok，配置保留 |
| `add <name> <选项>` / `remove <name>` | 保存或删除供应商，不切换 |
| `list` | 列出供应商和当前选中项 |
| `status [--json]` | 主程序是否打补丁、进程是否已重启到新代码、supervisor 状态、当前路由、最近请求 |
| `test <name> [--json]` | 向供应商发一条测试请求 |
| `log [N]` | 最近 N 条上游请求记录 |
| `restart` | 主动请求 supervisor 重启主程序 |
| `restore` | 去掉补丁、恢复原厂主程序并重启 |

供应商选项：`--url`（根地址）、`--model`、`--protocol openai-chat|openai-responses|anthropic-messages`（默认 openai-chat）、`--key` / `--key-file`、`--auth bearer|x-api-key|none`、`--endpoint /自定义/路径`、`--header 'Name: value'`（可重复）、`--reasoning low|medium|high`、`--max-tokens N`（Anthropic 默认 8192）。

请求地址 = `--url` + 协议默认路径（`/chat/completions`、`/responses`、`/messages`），`--endpoint` 可以替换默认路径。例如 `--url https://api.example.com/v1` 会请求 `https://api.example.com/v1/chat/completions`。

## 边界与注意

- 切换影响同一云端上的所有 Bot；语音转写、标题生成等非推理功能在外部模式下不走供应商（标题/标注回调被跳过，语音仍走官方）。
- 配置文件包含 API key，权限 600，只对当前云端用户可读。请求日志不含 key。
- 选中供应商后如果请求失败（key 错、余额不足、供应商挂了），对话直接报错并写入 `log`，**不会**悄悄回落到官方计费。
- 补丁只依赖主程序里 `createHostInference` 这一个函数名，Grok Bot 升级一般不需要改本工具；升级会覆盖主程序、补丁丢失，`status` 会提示，再跑一次 `use <name>` 即可。如果某个新版本改了这个结构，`use` 会拒绝并保持原文件不动。
- 写入前会 `node --check` 校验补丁后的文件；`restore` 后主程序与原文件逐字节一致。
- 旧对话可以直接切换。官方 Grok 产生的历史里有外部协议无法表达的内容（脱敏推理、带签名的推理、工具返回的截图、文件附件），会按下面规则降级而不是报错：脱敏推理丢弃；没有本协议 providerState 的推理不回放（Chat Completions 一律不回放推理）；工具截图在 Anthropic 里放进 `tool_result`，在 OpenAI 两种协议里紧跟一条带图的用户消息；文件附件替换为一行占位文字；空的助手消息跳过。

## 开发

```sh
npm test        # 构建 dist/grok-switch.cjs 并运行全部测试（无第三方依赖，Node 20+）
```

`src/protocols/` 是三种协议的转换器，`src/runtime.cjs` 是注入主程序的路由/流式代码，`src/cli.cjs` 是命令行；`build.mjs` 把它们拼成 `dist/grok-switch.cjs`。测试把构建产物的注入段加载到模拟的主程序作用域里运行，并对一个合成主程序（本地有真实主程序时也会对它）执行打补丁、重启请求、恢复的完整流程。

MIT License。
