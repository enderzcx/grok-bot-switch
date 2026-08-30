# Provider Switcher 本地交付记录

日期：2026-08-30。验收层级：local / fixture，不是 production。

## 当前结果

通用 profile/密钥、三协议适配器、事务核心、host 补丁编译器、CLI 与 loopback UI 已整合。真实主机执行器仍未实现，本轮不构成完整生产版 v0.1 验收。

## Grok 分工与 Codex 审查

| Grok 切片 | 交付 | Codex 接受前要求的修复 |
|---|---|---|
| Provider core | schema、registry、secret、CLI | 原子 secret 写入、64 KiB 限制、移除 tombstone、官方 profile 不落盘 |
| 三协议适配 | Chat / Responses / Messages | Responses 加密推理、Anthropic 签名 thinking 续接，并绑定可见 reasoning |
| 切换事务与 hop | staging、回执、快照、fail-closed | 限定 POST/路径、URL/DNS 防护、owner-only 文件、失败清理 |
| Service wiring | 同一 registry 接事务 | 移除全局假 DNS；明确 lab-synthetic；校验 switch-back 快照；禁止删除引用中的 profile |
| Host executor | 编译进 pinned 0.30 host | provider state 经 host redaction 保留；流/错误体上限、120 秒截止时间 |
| 本地面板 | profile/secret/plan/activity | Codex 补 CLI 生命周期、统一入口、模拟环境提示、全部阻塞状态禁用 apply |

## 确定性证据

- 整合初验：`python3 -m unittest discover -s tests` 159 pass；`node --test tests/*.test.mjs` 86 pass。
- CLI/UI 接线补丁后：CLI + UI 25 pass，含真实 subprocess 启动、HTTP status 读回及 SIGINT 正常退出。
- 三协议 fake-loopback 覆盖 text/reasoning/tool calls/usage/续接；没有真实供应商请求。
- pinned 0.30 bundle 注入及 `node --check` 在 patcher 测试中完成。未修改安装目录或云主机。
- 最终统一 gate 与独立结构审查结果将在收口时追加，以上不是最终 release PASS。

## 浏览器读回

使用隔离的 `runtime/ui-acceptance-home`，不是用户真实 provider/密钥数据：

- 桌面默认态显示“未接入”，不会假报官方主机已连接。
- 通过表单保存 `ui-responses`、`https://api.example.com/v1`、`test-model` 和明确的 synthetic 测试值。
- 列表读回 `POST https://api.example.com/v1/responses`，密钥只显示指纹。
- 提交后密码输入框非空数量为 0；可见页面不含 synthetic 测试密钥。
- 打开计划显示“主机未接入”，“启用”禁用。
- 390px 宽度 `clientWidth=scrollWidth=390`，无横向溢出；截图确认布局与操作可见。
- 深色模式手机表单宽 356px；页面仍无横向溢出，浏览器控制台无 error/warn。验收后恢复颜色与尺寸设置。
- 连接显式的本地 fixture 后页面标记“模拟环境”，计划显示“模拟切换未启用”，“启用”禁用。
- 编辑后名称读回为“自定义 Responses · 已编辑”，完整地址为 `https://api.example.com/v1/gateway/responses?api-version=2024-06-01`；表单预览与保存后列表一致，密钥指纹仍为 `712cfae650ed`。
- 带密钥修改认证方式时，浏览器显示“请先移除密钥，再更改认证方式”，没有保存不兼容配置；编辑后手机宽度仍为 390/390。
- synthetic secret、profile、活动和锁文件的实际文件权限均读回为 `600`。

## 仍未完成

1. 真实 SSH/云主机执行器及安装、升级、启动管理。
2. 供应商专属 OAuth 授权/刷新适配器。
3. `--live` 在线验证，以及真实 Grok Bot 消息和供应商计费回执。
4. 公共分发、原生菜单栏包装、真实供应商/模型能力矩阵。

这些是实现或验收缺口，不只是一项审批。生产授权到来后也不能直接把模拟执行器用于真实主机。

## 独立结构审查与修复记录

Grok 首次任务 `20260830-093817-review-b3af8c25` 只返回开始说明，未被接受为审查证据。续接任务 `20260830-094414-continue-45ac4a67` 对固定 `0b4c300...3bec3f8` 实际读代码后给出 REPAIR。

Codex 已复现并修复：

- 参数丢失和 hop 5 秒超时：Grok `930d678`，整合为 `d67a6f8`，跨 Python 编译器到真实 Node adapter/session 的边界测试通过。
- host 重定向和非法 enabled 配置静默退回原生：`5417ecb`。
- 连续外部切换及失败恢复中的 hop 残留：`5767087`；模拟网关现在也检查监听端口冲突。
- 恢复后重新校验 bundle/config/generation/hop，切换引擎不再删除存储密钥：`e3a771a`；包括损坏恢复产物的反例测试。
- 当前/恢复引用密钥删除和轮换阻止：`9c956d8`，59 个相关测试通过。
- 公共恢复语义：明确选择新事务 `switch-back`，文档/CLI/UI 都不再宣称 exact restore；快照校验用于历史来源与完整性门槛，不作为实际使用了快照字节的证明。

URL query 拼接及重复 profile canonicalizer 已由 Grok `c4b31c4` 修复，整合为 `d3bd3ce`。Codex 独立复跑相关 48 个测试，且重放 query 反例，preview 与 hop 地址已一致。profile schema 统一到 `models.parse_profile` / `official_profile`；独立部署的 hop 保留标准库 URL join，但跨层相等测试和编译时相等断言防止再次漂移。

## 最终本地判定

Codex 判定：**Local preview PASS**。Grok 的原始审查仍记录为对旧 pin 的 REPAIR，不能改写成 Grok 对最终版本签发 PASS。各已接受问题均已逐项修复并独立复验；完整生产版 v0.1 仍未完成。

最终代码 pin：`d3bd3ce`（随后仅补交付文档）。

| Gate | 结果 |
|---|---|
| `python3 -m unittest discover -s tests` | 192 pass |
| `node --test tests/*.test.mjs` | 91 pass |
| `python3 -m compileall -q grokctl ops` | pass |
| `node --check grokctl/web/app.js` | pass |
| `check_delivery_doc.py docs/provider-switcher-v0.1.md` | pass |
| `git diff --check` | pass |
| 新增核心路径的 API-key/JWT/private-key pattern 文件名扫描 | 无命中；不替代完整秘密扫描器 |

补充浏览器验收：Messages 缺少输出上限时 `required=true` / `valueMissing=true`，无法提交；填写 8192 后保存并重新编辑，值读回 8192。最终参数表单手机宽度仍为 390/390。测试只保存 synthetic profiles，未发送推理请求。

### Worker commit attribution

| 切片 | Grok 原始提交 | 整合提交 |
|---|---|---|
| Provider core | `683de3e`, `f332772` | `4af26af`, `5212f1b` |
| Protocol adapters | `7798e5c`, `69747d1`, `873b2c6` | `0d2f2c2`, `cf72214`, `8001c12` |
| Switch runtime | `58311cb`, `8b446d0` | `1b67879`, `5c3ae1d` |
| Service wiring | `23d68b4`, `978f7e8` | `4dd6888`, `1536b45` |
| Host executor | `b3e0815`, `d90802a` | `abdac00`, `2b5522a` |
| UI panel | `fbcc7ac` | `1244f95` |
| Parameter boundary | `930d678` | `d67a6f8` |
| Profile edit | `762446d` | `592502b` |
| Schema / URL repair | `c4b31c4` | `d3bd3ce` |

其它修复与整合提交由 Codex 主代理完成。发布边界：只合并到本地 main 和本机 bare origin；没有 GitHub 发布、CI 运行、生产部署或真实额度证据。
