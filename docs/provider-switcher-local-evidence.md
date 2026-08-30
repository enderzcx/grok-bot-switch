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

## 仍未完成

1. 真实 SSH/云主机执行器及安装、升级、启动管理。
2. 供应商专属 OAuth 授权/刷新适配器。
3. `--live` 在线验证，以及真实 Grok Bot 消息和供应商计费回执。
4. 公共分发、原生菜单栏包装、真实供应商/模型能力矩阵。

这些是实现或验收缺口，不只是一项审批。生产授权到来后也不能直接把模拟执行器用于真实主机。
