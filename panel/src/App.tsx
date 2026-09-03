// Web application shell adapted from CC Switch App.tsx (MIT, Jason Young).
// Header, provider list and full-screen form keep the upstream layout; the
// data layer talks to the grok-switch panel API instead of Tauri.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquareText, Moon, Plus, RefreshCw, Sparkles, Sun, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProviderCard } from "@/components/providers/ProviderCard";
import { ProviderForm } from "@/components/providers/ProviderForm";
import { ProviderStatusBadge } from "@/components/providers/ProviderStatusBadge";
import { api, type LogEntry, type Probe, type State } from "@/lib/api";
import { cn } from "@/lib/utils";

type Toast = { id: number; text: string; tone: "ok" | "bad" | "info" };
type Review = { kind: "delete"; name: string } | { kind: "restore" };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem("gs-theme") === "dark" || (localStorage.getItem("gs-theme") == null && window.matchMedia("(prefers-color-scheme: dark)").matches));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("gs-theme", dark ? "dark" : "light");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

function formatLog(e: LogEntry): string {
  if (e.raw) return e.raw;
  return [
    (e.ts ?? "").slice(11, 19),
    e.provider ?? "-",
    e.model ?? "-",
    e.kind ?? "-",
    "HTTP " + (e.status ?? 0),
    (e.ms ?? 0) + "ms",
    e.usage ? `${e.usage.promptTokens}+${e.usage.completionTokens}` : "",
    e.error ? "ERROR " + e.error : "",
  ]
    .filter(Boolean)
    .join("  ");
}

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ editing: string | null } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [codexName, setCodexName] = useState("chatgpt");
  const [codexModel, setCodexModel] = useState("");
  const theme = useTheme();
  const timer = useRef<number | undefined>(undefined);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { id, text, tone }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === "bad" ? 8000 : 3500);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
      setLoadError(null);
      if (!codexModel && next.codex.defaultModel) setCodexModel(next.codex.defaultModel);
    } catch (e) {
      setLoadError(message(e));
    }
  }, [codexModel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!state) return;
    const active = Object.values(state.codex.jobs).some((j) => j.status === "running") || state.host.runningCurrentBundle === false;
    timer.current = window.setTimeout(() => void refresh(), active ? 2000 : 15000);
    return () => window.clearTimeout(timer.current);
  }, [state, refresh]);

  useEffect(() => {
    if (window.location.hash === "#add" && state && !form) setForm({ editing: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state != null]);

  async function run(label: string, action: () => Promise<{ lines?: string[]; state?: State }>, okText?: string) {
    setBusy(label);
    try {
      const result = await action();
      if (result.state) setState(result.state);
      toast(okText ?? result.lines?.join(" ") ?? "完成", "ok");
    } catch (e) {
      toast(message(e), "bad");
    } finally {
      setBusy(null);
    }
  }

  async function testProvider(name: string) {
    setBusy("test:" + name);
    toast(`正在向 ${name} 发测试请求…`);
    try {
      const { probe } = await api.test(name);
      toast(probe.ok ? `${name} 正常：${probe.ms}ms，回复 ${JSON.stringify(probe.text)}` : `${name} 失败：${probe.error}`, probe.ok ? "ok" : "bad");
      void refresh();
    } catch (e) {
      toast(message(e), "bad");
    } finally {
      setBusy(null);
    }
  }

  function onSaved(next: State, name: string, probe: Probe | null, useNow: boolean) {
    setState(next);
    if (probe && !probe.ok) return;
    setForm(null);
    toast(probe ? `${name} 测试通过（${probe.ms}ms）` : `${name} 已保存`, "ok");
    if (useNow) void run("use:" + name, () => api.use(name));
  }

  if (loadError && !state) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div className="space-y-2">
          <p className="text-lg font-semibold">无法连接面板服务</p>
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <p className="text-xs text-muted-foreground">请用 `ui` 命令打印出的完整地址（带令牌）重新打开。</p>
        </div>
      </div>
    );
  }
  if (!state) return <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">加载中…</div>;

  const { host } = state;
  const names = Object.keys(state.providers);
  const activeProvider = state.active ? state.providers[state.active] : null;
  const restartPending = host.runningCurrentBundle === false || host.supervisor.pending != null;
  const codex = state.codex;
  const login = codex.jobs["codex-login"];
  const install = codex.jobs["codex-install"];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 w-full bg-background/95 backdrop-blur border-b border-border">
        <div className="flex h-16 items-center justify-between gap-2 px-4 sm:px-6 max-w-5xl mx-auto">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm">GS</div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-tight">Grok Bot Switch</h1>
              <p className="text-xs text-muted-foreground">v{state.version}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setHelpOpen(true)} title="聊天里的切换命令">
              <MessageSquareText className="h-4 w-4" />
              <span className="hidden sm:inline">聊天命令</span>
            </Button>
            <Button variant="ghost" size="icon" onClick={theme.toggle} aria-label="切换主题">
              {theme.dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => void refresh()} aria-label="刷新">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => setForm({ editing: null })}>
              <Plus className="h-4 w-4" />
              添加
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <section className="rounded-xl border border-border bg-card p-4 shadow-sm flex flex-wrap items-center gap-4">
          <div className="flex-1 min-w-[220px]">
            <p className="text-xs text-muted-foreground">当前对话使用</p>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <span className="text-lg font-semibold">{state.route === "official" ? "官方 Grok" : state.route === "external" ? state.active : "配置有误"}</span>
              {state.route === "external" && activeProvider && <ProviderStatusBadge label={activeProvider.protocol === "anthropic-messages" ? "Anthropic" : activeProvider.protocol === "openai-responses" ? "Responses" : "Chat"} tone="info" />}
              {restartPending && <ProviderStatusBadge label="等待主程序重启" tone="warning" title="补丁刚更新，Grok 的 supervisor 会在没有 Bot 忙碌时重启主程序，之后新对话生效。" />}
            </div>
            <p className="text-xs text-muted-foreground font-mono break-all mt-1">
              {state.route === "external" && activeProvider ? activeProvider.summary : state.route === "error" ? state.routeError : "选择下面任一来源后，下一条消息生效"}
            </p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <Dot ok={host.exists && host.patched} warn={host.exists && !host.patched} label={!host.exists ? "未找到主程序" : host.patched ? "补丁已就位" : "未打补丁"} />
            <Dot ok={host.process != null && host.runningCurrentBundle !== false} warn={host.process == null || host.runningCurrentBundle === false} label={host.process ? (host.runningCurrentBundle === false ? "重启待执行" : "主程序运行中") : "主程序未运行"} />
            <Dot ok={!host.supervisor.busy} warn={host.supervisor.busy} label={host.supervisor.busy ? "Bot 忙碌中" : "空闲"} />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-medium text-muted-foreground">模型来源</h2>
            <span className="text-xs text-muted-foreground">{names.length ? `${names.length} 个自定义来源` : ""}</span>
          </div>
          <ProviderCard name="official" provider={null} active={state.route === "official"} busy={busy != null} switching={busy === "official"} onUse={() => void run("official", () => api.official(), "已切回官方 Grok，下一条消息生效")} />
          {names.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              还没有自定义模型来源。点右上角"添加"，或在下方用 ChatGPT 登录。
            </div>
          )}
          {names.map((name) => (
            <ProviderCard
              key={name}
              name={name}
              provider={state.providers[name]}
              active={state.active === name}
              busy={busy != null}
              switching={busy === "use:" + name}
              onUse={() => void run("use:" + name, () => api.use(name))}
              onEdit={() => setForm({ editing: name })}
              onTest={() => void testProvider(name)}
              onDelete={() => setReview({ kind: "delete", name })}
            />
          ))}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground px-1">ChatGPT 订阅</h2>
          <article className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <div className="h-9 w-9 flex-shrink-0 rounded-lg bg-muted flex items-center justify-center border border-border">
                  <Sparkles size={20} />
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">用 ChatGPT Plus / Pro 额度</h3>
                    {!codex.installed ? <ProviderStatusBadge label="未安装 Codex CLI" tone="warning" /> : codex.loggedIn ? <ProviderStatusBadge label="已登录" tone="success" /> : <ProviderStatusBadge label="未登录" tone="muted" />}
                    <ProviderStatusBadge label="实验性" tone="muted" title="让 Codex 后端为非 Codex 程序提供服务，在 OpenAI 条款上属擦边行为，账号有被限制的可能。" />
                  </div>
                  <p className="text-xs text-muted-foreground">不需要 API key，登录在你自己的设备上完成，云端只保存登录凭据。</p>
                  {codex.installed && login?.status === "running" && (
                    <ol className="text-sm space-y-1 list-decimal pl-5">
                      <li>
                        在你自己的手机或电脑浏览器打开 <span className="font-mono font-semibold break-all">{login.url ?? "…"}</span>
                      </li>
                      <li>
                        输入验证码 <span className="font-mono text-2xl font-bold tracking-widest text-primary">{login.code ?? "获取中…"}</span>
                      </li>
                      <li>登录完成后这里会自动更新</li>
                    </ol>
                  )}
                  {codex.installed && login?.status !== "running" && (
                    <div className="grid gap-3 sm:grid-cols-2 max-w-xl">
                      <div className="space-y-1">
                        <Label htmlFor="codex-name">保存为来源名</Label>
                        <Input id="codex-name" value={codexName} onChange={(e) => setCodexName(e.target.value)} />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="codex-model">模型</Label>
                        <Input id="codex-model" value={codexModel} onChange={(e) => setCodexModel(e.target.value)} placeholder="gpt-5.4" />
                      </div>
                    </div>
                  )}
                  {login?.status === "done" && <p className="text-sm text-emerald-600 dark:text-emerald-400">登录成功，已保存来源。{login.error}</p>}
                  {login?.status === "failed" && <p className="text-sm text-red-600 dark:text-red-300">{login.error ?? "登录失败"}</p>}
                  {install?.status === "failed" && <p className="text-sm text-red-600 dark:text-red-300">{install.error}</p>}
                  {!codex.installed && install?.output && <pre className="text-xs bg-muted rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap">{install.output}</pre>}
                </div>
              </div>
              <div className="flex-shrink-0">
                {!codex.installed ? (
                  <Button size="sm" disabled={busy != null || install?.status === "running"} onClick={() => void run("codex-install", () => api.codexInstall(), "开始安装 Codex CLI")}>
                    {install?.status === "running" ? "安装中…" : "安装 Codex CLI"}
                  </Button>
                ) : login?.status === "running" ? (
                  <Button size="sm" variant="outline" onClick={() => void run("codex-cancel", () => api.codexCancel(), "已取消")}>
                    取消
                  </Button>
                ) : (
                  <Button size="sm" disabled={busy != null} onClick={() => void run("codex-login", () => api.codexLogin(codexName || "chatgpt", codexModel), "已开始登录流程")}>
                    {codex.loggedIn ? "重新登录并保存" : "登录 ChatGPT"}
                  </Button>
                )}
              </div>
            </div>
          </article>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground px-1">用量与记录</h2>
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
            {Object.keys(state.usage).length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有外部请求。</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left font-medium pb-2">来源</th>
                    <th className="text-right font-medium pb-2">请求</th>
                    <th className="text-right font-medium pb-2">失败</th>
                    <th className="text-right font-medium pb-2">输入 token</th>
                    <th className="text-right font-medium pb-2">输出 token</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(state.usage).map(([name, u]) => (
                    <tr key={name} className="border-t border-border">
                      <td className="py-2">{name}</td>
                      <td className="py-2 text-right">{u.requests}</td>
                      <td className="py-2 text-right">{u.failed}</td>
                      <td className="py-2 text-right">{u.promptTokens.toLocaleString()}</td>
                      <td className="py-2 text-right">{u.completionTokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {state.recent.length > 0 && <pre className="text-xs bg-muted rounded-lg p-3 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono">{state.recent.map(formatLog).join("\n")}</pre>}
          </div>
        </section>

        <section>
          <button type="button" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground px-1" onClick={() => setShowMaintenance((v) => !v)}>
            {showMaintenance ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Wrench className="h-4 w-4" />
            主程序与补丁状态 · 维护操作
          </button>
          {showMaintenance && (
            <div className="mt-3 rounded-xl border border-border bg-card p-4 shadow-sm space-y-3 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">主程序</dt>
                <dd className="break-all">
                  {host.path}
                  {host.version ? ` · ${host.version}` : ""} · {host.patched ? `已打补丁 ${host.patchVersion}` : "未打补丁"}
                </dd>
                <dt className="text-muted-foreground">进程</dt>
                <dd>{host.process ? `pid ${host.process.pid}${host.process.startedAtMs ? " · 启动于 " + new Date(host.process.startedAtMs).toLocaleString() : ""}` : "未运行"}</dd>
                <dt className="text-muted-foreground">supervisor</dt>
                <dd>
                  {host.supervisor.busy ? "有 Bot 在忙" : "空闲"}
                  {host.supervisor.pending ? ` · 待处理命令 ${host.supervisor.pending.id}` : ""}
                </dd>
                <dt className="text-muted-foreground">配置文件</dt>
                <dd className="break-all">{state.configPath}</dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={busy != null} onClick={() => void run("restart", () => api.restart())}>
                  请求重启主程序
                </Button>
                <Button variant="outline" size="sm" disabled={busy != null} className="text-destructive" onClick={() => setReview({ kind: "restore" })}>
                  卸载补丁并恢复原厂
                </Button>
              </div>
            </div>
          )}
        </section>
      </main>

      {form && <ProviderForm editing={form.editing} initial={form.editing ? state.providers[form.editing] : null} takenNames={names} onClose={() => setForm(null)} onSaved={onSaved} />}

      <ConfirmDialog
        isOpen={review != null}
        title={review?.kind === "delete" ? `删除来源 ${review.name}` : "卸载补丁"}
        message={review?.kind === "delete" ? "只删除这条配置，不影响其它来源。" : "主程序恢复为原厂文件并重启一次；已保存的来源配置不会删除。"}
        confirmText={review?.kind === "delete" ? "删除" : "卸载"}
        pending={busy != null}
        onCancel={() => setReview(null)}
        onConfirm={() => {
          const current = review;
          setReview(null);
          if (!current) return;
          if (current.kind === "delete") void run("delete", () => api.deleteProvider(current.name), `已删除 ${current.name}`);
          else void run("restore", () => api.restore());
        }}
      />

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>在聊天里切换</DialogTitle>
            <DialogDescription>这些消息在云端主程序里直接处理，不发给任何模型、不花 token，任何平台都一样。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">/gs use 名字</code> 切到某个来源，下一条消息生效
            </p>
            <p>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">/gs official</code> 切回官方 Grok
            </p>
            <p>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">/gs status</code> 看当前走哪里、保存了哪些来源
            </p>
            <p className="text-muted-foreground text-xs pt-2">添加来源（带 key）只能在这个面板或云端终端里做；聊天命令不接受 key。给用外部模型的 Bot 建议关掉"本机执行"，否则模型可能把命令跑到你自己的电脑上。</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setHelpOpen(false)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-[min(520px,calc(100vw-32px))] pointer-events-none">
        {toasts.map((t) => (
          <div key={t.id} className={cn("rounded-lg px-4 py-2.5 text-sm shadow-lg text-white break-all", t.tone === "ok" ? "bg-emerald-700" : t.tone === "bad" ? "bg-red-700" : "bg-slate-800")}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Dot({ ok, warn, label }: { ok: boolean; warn: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", ok ? "bg-emerald-500" : warn ? "bg-amber-500" : "bg-red-500")} />
      {label}
    </span>
  );
}

