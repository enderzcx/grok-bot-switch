# CC Switch UI 源码移植验收

## 范围

用户明确要求直接移植 CC Switch 前端源码后改造。采用 `farion1231/cc-switch` 的 `d8065cc628fcd373d00c4363d718095f19e78c9e`，package version 3.20.1，保留 Jason Young 的 MIT 声明。

`frontend/upstream.json` 记录 15 份原样代码的 SHA-256；与固定上游 checkout 逐字节比较通过。供应商卡片、操作区、全屏面板和应用外壳由上游对应源码适配，去除其它客户端、Tauri 配置写入、OAuth 读取、用量查询和自动回退接线。不是将 CC Switch 整个桌面软件无修改地嵌入，也没有重新实现其后端。

## 实现边界

- `frontend/src/lib/api.ts` 是唯一浏览器服务适配器，调用现有同源 `/api/*`。
- profile、secret、切换状态仍由 Python 服务持有，浏览器不新增持久状态。
- 密钥只进入单独的安装请求；编辑不会读取已有密钥，失败后新输入会清空。
- 创建配置后安装密钥失败时，重试更新已创建 profile，不会再次创建；退出表单也重新读取列表。
- 原手写面板被构建产物替换。Python 静态 HTTP 路由和 CLI 启动方式保持不变。
- Radix 动态样式使用 nonce；CSP 没有添加 unsafe-inline、unsafe-eval 或外部连接域名。
- 前端只展示已接入动作。主机未接入或模拟 apply 未启用时，确认切换不可用。
- 风格直接保留 CC Switch 的系统字体、蓝色按钮、主题和组件几何，不单独发明新设计语言。

## 验证

- React 行为测试覆盖编辑的 id/密钥隔离、参数/header/enabled 保留、secret 独立写入、失败重试、同源/CSRF/重定向限制、未知 blocker、模拟状态和未接入主机禁止 apply。
- Python 增加源码来源、无 Tauri/浏览器持久存储依赖，以及 nonce CSP 的回归测试。原 API 和切换测试保留；原静态源码字符串断言改成 React 行为测试。
- 浏览器真实新增 `cc-port-test`：地址为 `https://api.example.com/v1/responses?api-version=2026`，仅使用 synthetic key。
- 新增后只显示指纹；编辑页 `readOnly=true`、密码输入数量 0、maxTokens 为 8192；改名后指纹不变。
- 计划弹窗显示“主机未接入”，确认切换禁用。
- 删除确认框显示名称、id、端点和不可撤销提示；没有执行浏览器删除。
- 桌面、390px 全屏表单、375px 深色列表、320px 确认框检查通过，无横向溢出；浏览器无 error/warn。
- 依赖审计发现上游 Vitest 2 开发工具漏洞后，将测试工具升级到修复版 Vitest 3，最终 npm audit 为 0。
- 62 个运行时包许可证文本随仓库保留；react-remove-scroll-bar 的 npm 包缺少许可证文件，补充了其上游仓库 MIT 声明并在生成器中注明来源。

## 结构检查

Codex 对移植 diff 直接做有界结构检查：上游 UI 与业务接线分离、没有 Tauri 调用、没有第二份 profile 状态、没有读取真实凭据的新入口。自定义适配源文件保持分离，原样上游组件用 manifest 检测漂移。检查发现并修复了部分保存失败后的列表刷新和请求期间表单可继续编辑的问题。

这里是本地 UI 验收，不是生产主机接入、线上计费或 OAuth 验收。原有真实主机适配器缺口不因换 UI 而消失。

## Gate 结果

| 检查 | 结果 |
|---|---|
| `python3 -m unittest discover -s tests` | 195 pass |
| `node --test tests/*.test.mjs` | 91 pass |
| `cd frontend && npm test` | 9 pass |
| `cd frontend && npm run build` | TypeScript + Vite pass |
| `cd frontend && npm audit` | 0 vulnerabilities |
| 15 份原样组件与上游 pin 对比 | byte-for-byte pass |
| `git diff --check` | pass |

本轮结构检查由 Codex 直接完成，结论为本地 UI 移植 PASS，没有声称 Grok 或其它独立审查者签发了此轮结论。
