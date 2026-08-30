// Web application shell adapted from CC Switch App.tsx. Tauri client tabs,
// filesystem bindings and native settings are intentionally not transplanted.
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  History,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Sun,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ListItemRow } from "@/components/common/ListItemRow";
import { ProviderCard } from "@/components/providers/ProviderCard";
import { ProviderForm } from "@/components/providers/ProviderForm";
import ApiKeyInput from "@/components/providers/forms/ApiKeyInput";
import {
  api,
  planBlockers,
  profilePath,
  type Profile,
  type Status,
  type Plan,
  type Activity,
  type Activation,
  type ActionResult,
} from "@/lib/api";

type Review = {
  kind: "delete" | "removeKey";
  profile: Profile;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败";
const nativeAttached = (status: Status | null) =>
  status?.runtimeKind === "native-host" &&
  status.client?.pairingConfirmed !== false &&
  status.client?.mode === "native-switch";
const nativeReady = (status: Status | null) =>
  !!(
    status?.runtimeKind === "native-host" &&
    status.host.wired &&
    status.client?.connected === true &&
    status.client.hostReachable &&
    status.client.providerSwitchReady &&
    status.client.mode === "native-switch"
  );
const activationResult = (result: ActionResult): Activation | null =>
  result.id &&
  result.status &&
  result.target &&
  typeof result.generation === "number"
    ? {
        ...result,
        phase: result.phase || "",
        id: result.id,
        status: result.status,
        target: result.target,
        generation: result.generation,
      }
    : null;
const activationError = (job: Activation) => {
  const reason = typeof job.error === "string" ? job.error : job.error?.message;
  if (!reason) return "尚未确认切换结果，请继续检查。";
  if (/^[a-z-]+$/.test(reason)) {
    if (reason === "recovery-waiting-idle")
      return "Grok Bot 正在工作，等待空闲后再检查恢复结果。";
    if (reason === "foreign-command-pending")
      return "Grok Bot 正在处理另一项操作，请稍后继续检查。";
    if (job.status === "failed") return "请刷新运行状态后重试。";
    return "运行状态需要检查，尚未确认目标通道生效。";
  }
  return reason;
};

function SecretDialog({
  profile,
  onClose,
  onSaved,
  onRemove,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: () => void;
  onRemove: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (busy || !key) return;
    const secret = key;
    setKey("");
    setBusy(true);
    setError("");
    try {
      await api(profilePath(profile.id) + "/secret", { secret });
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="w-[calc(100%-2rem)] max-w-lg"
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>管理密钥</DialogTitle>
          <DialogDescription>
            {profile.displayName} · {profile.id}
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-scroll space-y-4">
          <p className="text-sm text-muted-foreground">
            {profile.secret?.installed
              ? "已安装 · " + profile.secret.fingerprintPrefix
              : "未安装密钥"}
            。已有密钥不会显示。
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            使用此供应商时，地址和密钥会同步到当前 Grok Bot
            云端。切换会影响该云端的所有 Bot。
          </p>
          {error && (
            <p role="alert" className="text-red-600">
              {error}
            </p>
          )}
          <ApiKeyInput value={key} onChange={setKey} disabled={busy} />
          {profile.secret?.installed && (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setKey("");
                onRemove();
              }}
            >
              移除密钥
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy || !key.trim()} onClick={() => void save()}>
            {busy ? "安装中" : "安装密钥"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<Profile | "new" | null>(null);
  const [secretProfile, setSecretProfile] = useState<Profile | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [switchErrors, setSwitchErrors] = useState<Record<string, string>>({});
  const [rollbackError, setRollbackError] = useState("");
  const [switching, setSwitching] = useState<{ target: string | null } | null>(
    null,
  );
  const switchInFlight = useRef(false);
  const connectInFlight = useRef(false);
  const [job, setJob] = useState<Activation | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [checking, setChecking] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [progressNote, setProgressNote] = useState("");
  const [pollEpoch, setPollEpoch] = useState(0);
  const mounted = useRef(true);
  const [view, setView] = useState<"providers" | "activity">("providers");
  const [events, setEvents] = useState<Activity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [dark, setDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const serial = useRef(0);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  function observeActivation(
    next: Activation,
    current: Status,
    announce = false,
  ) {
    setStatus(current);
    if (next.status === "verified") {
      const readback = current.activation;
      if (
        nativeReady(current) &&
        !current.blocking.length &&
        current.activeProfile === next.target &&
        readback?.id === next.id &&
        readback.status === "verified" &&
        readback.target === next.target &&
        readback.generation === next.generation
      ) {
        setJob(null);
        setProgressNote("");
        setSwitchErrors((errors) => ({ ...errors, [next.target]: "" }));
        if (announce)
          setNotice(
            "已切换到「" +
              (profiles.find((p) => p.id === next.target)?.displayName ||
                next.target) +
              "」。",
          );
        return;
      }
      setJob({
        ...next,
        status: "needs-attention",
        error: "尚未确认目标通道已生效，请继续检查。",
      });
      return;
    }
    setJob(next);
  }
  async function reload() {
    const seq = ++serial.current;
    setNotice("");
    setLoading(true);
    setError("");
    try {
      const [current, list] = await Promise.all([
        api<Status>("/api/status"),
        api<{ providers: Profile[] }>("/api/providers"),
      ]);
      if (seq === serial.current) {
        setStatus(current);
        setProfiles(list.providers);
        if (current.activation) observeActivation(current.activation, current);
        return current;
      }
    } catch (err) {
      if (seq === serial.current) setError(message(err));
    } finally {
      if (seq === serial.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      serial.current++;
      mounted.current = false;
    };
  }, []);
  const pendingId = job?.status === "pending" ? job.id : null;
  useEffect(() => {
    if (!pendingId) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setPollPaused(false);
    setProgressNote("");
    const deadline = setTimeout(() => {
      controller.abort();
      if (!cancelled) {
        setChecking(false);
        setPollPaused(true);
        setProgressNote("仍在等待确认，可以稍后继续检查。");
      }
    }, 60000);
    async function progress() {
      setChecking(true);
      try {
        const result = await api<ActionResult>(
          "/api/progress",
          {},
          controller.signal,
        );
        const current = await api<Status>(
          "/api/status",
          undefined,
          controller.signal,
        );
        if (cancelled || controller.signal.aborted) return;
        const returned = activationResult(result);
        const next =
          returned?.status === "needs-attention" ||
          returned?.status === "failed"
            ? returned
            : current.activation || returned;
        if (
          !next ||
          next.id !== pendingId ||
          next.target !== job?.target ||
          next.generation !== job?.generation ||
          (returned &&
            (returned.id !== pendingId ||
              returned.target !== job?.target ||
              returned.generation !== job?.generation))
        ) {
          setJob(
            (previous) =>
              previous && {
                ...previous,
                status: "needs-attention",
                error: "无法确认当前切换任务，请刷新状态。",
              },
          );
          return;
        }
        observeActivation(next, current, true);
        if (next.status === "pending") {
          if (++attempts < 12) timer = setTimeout(() => void progress(), 2000);
          else {
            setPollPaused(true);
            setProgressNote("仍在等待确认，可以稍后继续检查。");
          }
        }
      } catch (err) {
        if (!cancelled && !controller.signal.aborted) {
          setPollPaused(true);
          setProgressNote("检查暂时中断，切换结果尚未确认。" + message(err));
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    timer = setTimeout(() => void progress(), 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      controller.abort();
    };
    // Job identity, not response object identity, owns the bounded polling loop.
  }, [pendingId, pollEpoch]);
  function resumeProgress() {
    if (!job || checking) return;
    setJob({ ...job, status: "pending", error: null });
    setPollEpoch((value) => value + 1);
  }
  async function connect() {
    if (
      busy ||
      (nativeAttached(status) && status?.connectionMode !== "independent") ||
      connectInFlight.current ||
      pendingId ||
      switchInFlight.current
    )
      return;
    connectInFlight.current = true;
    setConnecting(true);
    setConnectionError("");
    setNotice("");
    try {
      const result = await api<ActionResult>("/api/connect", {});
      if (!mounted.current) return;
      const current = await reload();
      if (!current || !mounted.current) return;
      const next = activationResult(result) || current.activation;
      if (next) observeActivation(next, current);
      else if (nativeReady(current)) setNotice("已连接 Grok Bot。");
      else
        setConnectionError(
          current.client?.error?.message || planBlockers({ blocking: current.blocking, target: "official" }).join("；") || "云端尚未就绪，请稍后刷新。",
        );
    } catch (err) {
      if (mounted.current) setConnectionError(message(err));
    } finally {
      connectInFlight.current = false;
      if (mounted.current) setConnecting(false);
    }
  }
  async function activity() {
    setView("activity");
    setActivityLoading(true);
    setError("");
    try {
      setEvents(
        (await api<{ events: Activity[] }>("/api/activity")).events.reverse(),
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setActivityLoading(false);
    }
  }

  async function switchProvider(profile?: Profile) {
    if (
      busy ||
      loading ||
      connecting ||
      (job && job.status !== "failed") ||
      switchInFlight.current
    )
      return;
    switchInFlight.current = true;
    setBusy(true);
    setSwitching({ target: profile?.id ?? null });
    if (job?.status === "failed") setJob(null);
    setNotice("");
    const report = (reason: string) => {
      if (profile)
        setSwitchErrors((errors) => ({ ...errors, [profile.id]: reason }));
      else setRollbackError(reason);
    };
    report("");
    try {
      const plan = await api<Plan>(
        profile ? "/api/plan" : "/api/rollback",
        profile ? { target: profile.id } : {},
      );
      const blockers = planBlockers(plan);
      if (blockers.length) throw new Error(blockers.join("；"));
      if (!plan.target || (profile && plan.target !== profile.id))
        throw new Error("无法确认切换目标，请刷新后重试。");
      const result = await api<ActionResult>(
        profile ? "/api/use" : "/api/rollback",
        {
          target: plan.target,
          apply: true,
        },
      );
      if (!mounted.current) return;
      const current = await reload();
      if (!current)
        throw new Error("切换请求已提交，但状态读取失败，请刷新确认。");
      const next = activationResult(result) || current.activation;
      if (next) {
        if (next.target !== plan.target)
          throw new Error("无法确认切换目标，请刷新后重试。");
        observeActivation(next, current, true);
        return;
      }
      if (result.verified === false || result.status === "pending")
        throw new Error("切换仍在处理中，尚未确认生效，请刷新状态。");
      const simulated = current.runtimeKind === "lab-synthetic";
      if (current.activeProfile !== plan.target || current.blocking.length)
        throw new Error("尚未确认目标通道已生效，请刷新查看主机状态。");
      setNotice(
        simulated
          ? "模拟切换完成，真实 Grok Bot 未改变。"
          : "已切换到「" +
              (profiles.find((p) => p.id === plan.target)?.displayName ||
                plan.target) +
              "」。",
      );
    } catch (err) {
      report(message(err));
    } finally {
      switchInFlight.current = false;
      if (mounted.current) {
        setSwitching(null);
        setBusy(false);
      }
    }
  }

  async function prepare(kind: Review["kind"], profile: Profile) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await api(
        profilePath(profile.id) +
          (kind === "delete" ? "/remove" : "/secret/remove"),
        {},
      );
      setReview({ kind, profile });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function applyReview() {
    if (!review || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(
        profilePath(review.profile!.id) +
          (review.kind === "delete" ? "/remove" : "/secret/remove"),
        { confirm: true },
      );
      setReview(null);
      setNotice("操作已完成");
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function action(
    kind: "use" | "edit" | "secret" | "test" | "delete",
    profile: Profile,
  ) {
    setNotice("");
    if (kind === "edit") {
      setForm(profile);
      return;
    }
    if (kind === "secret") {
      setSecretProfile(profile);
      return;
    }
    if (kind === "use") {
      await switchProvider(profile);
      return;
    }
    if (kind === "delete") {
      await prepare("delete", profile);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const test = await api<{ ok: boolean }>("/api/test", {
        target: profile.id,
        live: false,
      });
      setNotice(
        test.ok
          ? "配置校验通过，未发送推理请求。"
          : "配置校验未通过，请检查密钥和地址。",
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const isLab = status?.runtimeKind === "lab-synthetic";
  const independent = status?.connectionMode === "independent";
  const installation = status?.installation;
  const installed = installation?.installations[0];
  const unconfirmed = !!job && job.status !== "failed";
  const visible = profiles.filter((p) =>
    (p.displayName + " " + p.id + " " + p.model + " " + p.protocol)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const disabled = busy || loading || connecting || unconfirmed;
  return (
    <div className="workspace">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-0 focus:left-0 focus:z-[120] bg-background p-3"
      >
        跳到主内容
      </a>
      <header className="sticky top-0 z-30 w-full bg-background border-b border-border">
        <div className="flex h-16 items-center justify-between gap-2 px-4 sm:px-6 max-w-6xl mx-auto">
          <div className="flex items-center gap-3 min-w-0">
            <Bot className="h-6 w-6 text-blue-500 shrink-0" />
            <h1 className="text-base sm:text-lg font-semibold">
              Grok Bot Switch
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? "切换浅色" : "切换深色"}
              onClick={() => setDark(!dark)}
            >
              {dark ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新"
              disabled={busy || loading || connecting || checking}
              onClick={() => void reload()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      <main id="main" className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <section
          aria-label="主机状态"
          className="rounded-xl border border-border bg-card p-4 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium">
              Grok Bot{" "}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {loading
                  ? "读取中"
                  : error
                    ? "状态读取失败"
                    : isLab
                      ? "模拟环境"
                      : independent
                        ? nativeReady(status) ? "独立模式 · 已就绪" : "独立模式 · 暂不可切换"
                      : connecting
                        ? "连接中"
                        : nativeAttached(status) ||
                            (status?.host.wired && !status.client)
                          ? "已接入"
                          : installation?.ambiguous
                            ? "检测到多个安装"
                            : installed
                              ? "已检测到 " + installed.version
                              : installation
                                ? "未找到 Grok Bot"
                                : "主机未接入"}
              </span>
            </p>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {loading
              ? "正在读取运行状态…"
              : error
                ? "暂时无法读取状态，请点击刷新重试。"
                : isLab
                  ? "当前连接的是模拟主机，不代表真实 Grok Bot 已切换。"
                  : independent
                    ? "面板运行在你的 Grok Bot 云端，直接连接你配置的供应商。"
                  : nativeAttached(status) ||
                      (status?.host.wired && !status.client)
                    ? "切换以确认后的状态为准。"
                    : installed
                      ? "已找到本机 Grok Bot，尚未连接。"
                      : "请先安装 Grok Bot，安装后点击刷新。"}
          </p>
          {independent && !nativeReady(status) && (
            <div className="mt-3 space-y-2">
              <p className="text-sm text-muted-foreground" role="status">
                {status?.client?.error?.message || planBlockers({ blocking: status?.blocking, target: "official" }).join("；") || "正在检查云端兼容性。"}
              </p>
              <Button variant="outline" disabled={disabled} onClick={() => void connect()}>检查云端兼容性</Button>
            </div>
          )}
          {!isLab && !independent && (
            <p className="mt-3 text-sm text-muted-foreground">请将独立安装包和附带的安装提示词交给 Grok Bot，然后在它的云端浏览器打开管理面板。本机窗口不能直接控制云端。</p>
          )}
          {!isLab && (installed || status?.client) && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              切换会影响当前云端的所有 Bot。供应商密钥保存在该云端，不要粘贴到聊天中。
            </p>
          )}
          {connectionError && (
            <p
              role="alert"
              className="mt-3 break-words text-sm text-red-600 dark:text-red-300"
            >
              {connectionError}
            </p>
          )}
          {job && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
              <p
                role={job.status === "pending" ? "status" : "alert"}
                className={
                  job.status === "pending"
                    ? "text-muted-foreground"
                    : "text-red-600 dark:text-red-300"
                }
              >
                {job.status === "pending"
                  ? progressNote || "切换正在等待确认，请勿重复提交。"
                  : "切换尚未确认。" + activationError(job)}
              </p>
              {(pollPaused || job.status !== "pending") && (
                <Button
                  variant="outline"
                  className="min-h-10"
                  disabled={checking || busy || connecting}
                  onClick={resumeProgress}
                >
                  继续检查
                </Button>
              )}
            </div>
          )}
          {installed && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">安装位置</summary>
              <p className="mt-1 break-all">{installed.path}</p>
            </details>
          )}
        </section>
        {error && !review && (
          <p
            role="alert"
            className="rounded-lg bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200 p-3"
          >
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-lg bg-muted p-3">
            {notice}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {view === "activity" && (
              <Button
                variant="outline"
                size="icon"
                aria-label="返回供应商"
                onClick={() => setView("providers")}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <h2 className="text-lg font-semibold">
              {view === "providers" ? "供应商" : "活动记录"}
            </h2>
            <span className="text-xs text-muted-foreground">
              {view === "providers" && !loading
                ? profiles.length + " 个配置"
                : ""}
            </span>
          </div>
          {view === "providers" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => void switchProvider()}
              >
                <Undo2 className="h-4 w-4" />
                {switching?.target === null ? "切换中" : "切回上一通道"}
              </Button>
              <Button
                variant="outline"
                aria-label="活动记录"
                onClick={() => void activity()}
              >
                <History className="h-4 w-4" />
              </Button>
              <Button disabled={disabled} onClick={() => setForm("new")}>
                <Plus className="h-4 w-4" />
                添加供应商
              </Button>
            </div>
          )}
        </div>
        {view === "providers" ? (
          <>
            {rollbackError && (
              <p
                role="alert"
                className="break-words text-sm text-red-600 dark:text-red-300"
              >
                {rollbackError}
              </p>
            )}
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="搜索供应商"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索名称、协议或模型"
                className="pl-9 h-10"
              />
            </div>
            <section
              aria-label="供应商列表"
              aria-busy={loading}
              className="space-y-3"
            >
              {loading && !profiles.length ? (
                <p
                  className="py-8 text-center text-muted-foreground"
                  role="status"
                >
                  正在读取供应商配置…
                </p>
              ) : (
                visible.map((profile) => (
                  <ProviderCard
                    key={profile.id}
                    provider={profile}
                    active={
                      !error &&
                      !loading &&
                      !busy &&
                      !connecting &&
                      !isLab &&
                      !job &&
                      !switchErrors[profile.id] &&
                      status?.host.wired === true &&
                      status.activeProfile === profile.id &&
                      (!status.client ||
                        (nativeAttached(status) &&
                          status.client.connected &&
                          status.client.hostReachable))
                    }
                    busy={disabled || !!error}
                    switching={
                      switching?.target === profile.id ||
                      (job?.status === "pending" && job.target === profile.id)
                    }
                    switchError={switchErrors[profile.id]}
                    onAction={(kind, p) => void action(kind, p)}
                  />
                ))
              )}
              {!loading && !error && !visible.length && (
                <p className="py-10 text-center text-muted-foreground">
                  没有匹配的供应商
                </p>
              )}
            </section>
          </>
        ) : (
          <section
            aria-label="活动列表"
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            {activityLoading ? (
              <p className="p-4" role="status">
                读取中…
              </p>
            ) : events.length ? (
              events.map((event, i) => (
                <ListItemRow
                  key={event.at + ":" + i}
                  isLast={i === events.length - 1}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm break-words">{event.type}</p>
                    <p className="text-xs text-muted-foreground">
                      {event.profileId || "本地配置"}
                    </p>
                  </div>
                  <time className="text-xs text-muted-foreground">
                    {new Date(event.at).toLocaleString()}
                  </time>
                </ListItemRow>
              ))
            ) : (
              <p className="p-4 text-muted-foreground">暂无活动</p>
            )}
          </section>
        )}
        <footer className="pt-3 text-xs text-muted-foreground">
          非官方实验项目 · 前端组件源自{" "}
          <a
            href="https://github.com/farion1231/cc-switch"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            CC Switch
          </a>
          （MIT）· 不会读取其他客户端配置
        </footer>
      </main>
      {form && (
        <ProviderForm
          initial={form === "new" ? undefined : form}
          onClose={() => {
            setForm(null);
            void reload();
          }}
          onSaved={() => setNotice("供应商已保存")}
        />
      )}
      {secretProfile && (
        <SecretDialog
          profile={secretProfile}
          onClose={() => setSecretProfile(null)}
          onSaved={() => void reload()}
          onRemove={() => {
            const p = secretProfile;
            setSecretProfile(null);
            void prepare("removeKey", p);
          }}
        />
      )}
      {review && (review.kind === "delete" || review.kind === "removeKey") && (
        <ConfirmDialog
          isOpen
          title={review.kind === "delete" ? "删除供应商" : "移除密钥"}
          message={
            (review.profile?.displayName || "") +
            "（" +
            review.profile?.id +
            "）\n" +
            (review.profile?.resolvedEndpoint || "") +
            "\n" +
            (review.kind === "delete"
              ? "将删除配置及密钥，不能撤销。"
              : "将删除该通道已保存的密钥，配置保留。") +
            (error ? "\n" + error : "")
          }
          pending={busy}
          onCancel={() => {
            setReview(null);
            setError("");
          }}
          onConfirm={() => void applyReview()}
        />
      )}
    </div>
  );
}
