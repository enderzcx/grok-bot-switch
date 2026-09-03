# Grok Bot Switch

让 Grok Bot 用你自己的模型。一段提示词让 Grok Bot 装好并打开配置面板，你在面板里填供应商（API key 或 ChatGPT 登录），之后在聊天里发 `/gs use 名字` 切换、`/gs official` 切回。支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议。非 xAI / X 官方项目。

## 怎么用

**1. 把这段发给 Grok Bot：**

> 请在你的云端电脑执行下面这条命令，把输出里的面板地址在你的浏览器里打开，然后告诉我"面板已打开，请在云端桌面里配置"。不要做别的事：
>
> `mkdir -p /workspace/grok-switch && curl -fsSL "https://raw.githubusercontent.com/enderzcx/grok-bot-switch/main/dist/grok-switch.cjs?v=$(date +%s)" -o /workspace/grok-switch/grok-switch.cjs && node /workspace/grok-switch/grok-switch.cjs install`

`install` 会下载后立刻给云端主程序打补丁并申请一次重启（补丁在没选供应商时完全透明，仍走官方 Grok），然后启动面板。Bot 回复完这一轮，主程序重启，之后就不再需要任何重启。

**2. 在 Grok Bot 的云端桌面里操作面板**（面板只在云端本机可访问，不要把地址复制到自己电脑的浏览器）：

- **加供应商**：填名字、协议、接口根地址、模型、API key，点"保存并测试"。它会真发一条测试请求，地址、key、模型任何一个不对都当场报出来。测试通过默认直接切换过去，下一条消息生效。
- **用 ChatGPT 订阅**：点"登录 ChatGPT"，面板显示一个网址和一次性验证码，你在**自己的**手机或电脑上打开网址、输验证码，登录完成后面板自动保存一个供应商。不需要 API key，用的是 Plus/Pro 额度；云端未装 Codex CLI 时面板有一键安装按钮。
- **切换**：点供应商右边的"使用"，或"切回官方 Grok"，下一条消息生效，不重启。

**3. 以后在聊天框里切**，任何平台都行，不用面板也不用终端，不调模型、不花 token：

| 在聊天框里发 | 效果 |
|---|---|
| `/gs use myapi` | 切到已保存的供应商，下一条消息生效 |
| `/gs official` | 切回官方 Grok |
| `/gs status` | 看当前走哪里、保存了哪些供应商 |

面板随时可以再开：对 Bot 说"运行 `node /workspace/grok-switch/grok-switch.cjs ui --background` 并打开面板"。

### 不想用面板？让 Bot 直接配

把参数写进提示词，Bot 会下载、测试、切换一步完成（key 会出现在聊天记录里，介意的话用面板或云端终端）：

> 请在你的云端电脑执行下面这条命令，然后把完整输出原样发给我：
> `mkdir -p /workspace/grok-switch && curl -fsSL "https://raw.githubusercontent.com/enderzcx/grok-bot-switch/main/dist/grok-switch.cjs?v=$(date +%s)" -o /workspace/grok-switch/grok-switch.cjs && node /workspace/grok-switch/grok-switch.cjs use myapi --protocol openai-chat --url https://api.example.com/v1 --model gpt-5 --key sk-xxxx`

也可以只说"帮我把 Grok Bot 切到我的 API"，让 Bot 问你要地址、模型和 key，再由它执行同样的命令。

`--protocol` 按供应商选：`openai-chat`（绝大多数中转站、DeepSeek、xAI API 等）、`openai-responses`（OpenAI 官方 Responses 接口）、`anthropic-messages`（Claude 官方或兼容接口）。请求地址 = 根地址 + 协议默认路径（`/chat/completions`、`/responses`、`/messages`），特殊路径用 `--endpoint` 或面板的高级选项。

### 关于 ChatGPT 登录

用的是 Codex CLI 的设备码登录（`codex login --device-auth`），凭据保存在云端 `~/.codex/auth.json`，过期自动刷新。请求走 Responses 协议到 `https://chatgpt.com/backend-api/codex`。**这是让 Codex 后端为非 Codex 程序提供服务，OpenAI 条款上属擦边行为，账号有被限制的可能，自行权衡。** Claude 的 OAuth 登录暂不支持，Anthropic 接口请用 API key。

## 终端命令

云端终端里 `node /workspace/grok-switch/grok-switch.cjs <命令>`，面板做的每件事都有对应命令：

| 命令 | 作用 |
|---|---|
| `install [--no-ui]` | 打补丁、申请一次重启、启动面板；重复执行无副作用 |
| `ui [--background] [--port N]` / `ui status` / `ui stop` | 配置面板，只监听 127.0.0.1，地址带一次性令牌 |
| `use <name> [选项]` | 切到某个供应商；带选项时先保存/更新它并先发测试请求（`--no-test` 跳过）。必要时打补丁并申请重启 |
| `official` | 切回官方 Grok，配置保留 |
| `add <name> <选项>` / `remove <name>` | 保存或删除供应商，不切换 |
| `list` | 列出供应商和当前选中项 |
| `status [--json]` | 补丁、进程、当前路由、各供应商累计请求数和 token、最近请求 |
| `test <name> [--json]` | 向供应商发一条测试请求 |
| `log [N]` | 最近 N 条上游请求：状态码、耗时、token、错误原因 |
| `restart` | 主动请求 supervisor 重启主程序 |
| `restore` | 去掉补丁、恢复原厂主程序并重启 |

供应商选项：`--url`、`--model`、`--protocol`、`--key` / `--key-file` / 环境变量 `GROK_SWITCH_API_KEY`、`--auth bearer|x-api-key|none|codex`、`--endpoint /自定义/路径`、`--header 'Name: value'`（可重复）、`--reasoning low|medium|high`、`--max-tokens N`（Anthropic 默认 8192）。

## 原理

Grok Bot 的推理请求不是从你的 Mac/Windows 发出的，而是从它的云端 Linux 电脑里的主程序 `/home/box/sand-host/host-main.cjs` 发出的。本工具把一段包装代码接到主程序创建推理会话的地方，每次新建会话时读一遍 `/workspace/grok-switch/config.json`：

- 没有选中的供应商 → 走官方 Grok，行为不变。
- 选中了供应商 → 直接从云端 `fetch` 你的 API，带上凭据；请求、流式回复、工具调用、推理内容都按协议转换。
- 最后一条用户消息以 `/gs` 开头 → 在主程序里直接执行、直接回复，不发给任何模型。

因为路由是每次会话时决定的，切换只是改配置文件，**不需要重启**。为什么装的时候要重启一次：主程序是一个已经在跑的 Node 进程，代码在启动时已读进内存，改磁盘文件不会影响它，只有重启才会带着补丁起来。这一次重启在 `install` 时就申请了，由 Grok 自带的 supervisor 在没有 Bot 忙碌时执行（Grok 给自己升级用的同一机制）；之后除 Grok Bot 升级覆盖主程序需要重新打补丁外，不再重启。补丁只依赖主程序里 `createHostInference` 这一个函数名，不校验版本哈希；写入前 `node --check`，原文件备份为 `host-main.cjs.grok-switch.orig`，`restore` 后逐字节一致。

面板是 `dist/grok-switch.cjs` 里内嵌的一页 HTML（移植自 CC Switch 的 React 界面，构建后内联成单文件），由同一个文件起的 HTTP 服务提供，只监听 127.0.0.1，API 要求地址里的一次性令牌；它调用的就是上面的终端命令，不多一套逻辑。

## 边界与注意

- 给用外部模型的 Bot 建议关掉"本机执行"：外部模型往往不会指定目标机器，主程序会把命令默认路由到你自己的电脑上。
- ChatGPT 登录目前是实验性功能，云端实测还少；不工作请反馈。
- 切换影响同一云端上的所有 Bot；语音转写、标题生成等非推理功能在外部模式下不走供应商（标题/标注回调被跳过，语音仍走官方）。
- 配置文件包含 API key，权限 600，只对当前云端用户可读；面板和请求日志都不回显 key。
- 选中供应商后如果请求失败（key 错、余额不足、供应商挂了），对话直接报错并写入 `log`，**不会**悄悄回落到官方计费。
- Grok Bot 升级会覆盖主程序、补丁丢失，面板和 `status` 会提示；再点一次"使用"或跑一次 `use <name>` 即可。如果某个新版本改了结构，`use` 会拒绝并保持原文件不动。
- 旧对话可以直接切换。官方 Grok 产生的历史里有外部协议无法表达的内容（脱敏推理、带签名的推理、工具返回的截图、文件附件），会按规则降级而不是报错：脱敏推理丢弃；没有本协议 providerState 的推理不回放（Chat Completions 一律不回放推理）；工具截图在 Anthropic 里放进 `tool_result`，在 OpenAI 两种协议里紧跟一条带图的用户消息；文件附件替换为一行占位文字；空的助手消息跳过。

## 开发

```sh
npm test        # 构建 dist/grok-switch.cjs 并运行全部测试（无第三方依赖，Node 20+）
```

`panel/` 是配置面板的 React 源码，移植自 [CC Switch](https://github.com/farion1231/cc-switch)（MIT）的供应商管理界面，Vite 构建成单个 `panel/dist/index.html` 后由 `build.mjs` 嵌进 `dist/grok-switch.cjs`（`cd panel && npm install && npm run build`）。

`minitool/` 是挂在小红书"小工具"里的离线使用向导（纯静态 H5：安装提示词生成器、切换命令、ChatGPT 登录说明、常见问题），`npm run build:minitool` 打成 `dist/grok-switch-minitool.zip` 直接上传；它不联网、不调用剪贴板，按小红书小工具容器规范编写（脚本外置、ES2017、Chrome 61 CSS 基线）。

`src/protocols/` 是三种协议的转换器，`src/runtime.cjs` 是注入主程序的路由、聊天命令和流式代码，`src/ui.cjs` 是面板（服务端 + 内嵌页面），`src/cli.cjs` 是命令行；`build.mjs` 把它们拼成 `dist/grok-switch.cjs`。测试把构建产物的注入段加载到模拟的主程序作用域里运行，并对一个合成主程序（本地有真实主程序时也会对它）执行打补丁、测试请求、面板 API、重启请求、恢复的完整流程。

MIT License。
