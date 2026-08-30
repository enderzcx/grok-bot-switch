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
} from "@/lib/api";

type Review = {
  kind: "use" | "rollback" | "delete" | "removeKey";
  profile?: Profile;
  plan: Plan;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败";

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
  async function reload() {
    const seq = ++serial.current;
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
      }
    } catch (err) {
      if (seq === serial.current) setError(message(err));
    } finally {
      if (seq === serial.current) setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    return () => {
      serial.current++;
    };
  }, []);
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

  async function prepare(kind: Review["kind"], profile?: Profile) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const plan = await api<Plan>(
        kind === "use"
          ? "/api/plan"
          : kind === "rollback"
            ? "/api/rollback"
            : profilePath(profile!.id) +
              (kind === "delete" ? "/remove" : "/secret/remove"),
        kind === "use" ? { target: profile!.id } : {},
      );
      setReview({ kind, profile, plan });
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
      if (review.kind === "use")
        await api("/api/use", { target: review.plan.target, apply: true });
      else if (review.kind === "rollback")
        await api("/api/rollback", { target: review.plan.target, apply: true });
      else
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
    kind: "plan" | "edit" | "secret" | "test" | "delete",
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
    if (kind === "plan" || kind === "delete") {
      await prepare(kind === "plan" ? "use" : "delete", profile);
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
  const blocked = review ? planBlockers(review.plan) : [];
  const visible = profiles.filter((p) =>
    (p.displayName + " " + p.id + " " + p.model + " " + p.protocol)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const disabled = busy || loading;
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
              disabled={disabled}
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
                      : status?.host.wired
                        ? "已接入"
                        : "主机未接入"}
              </span>
            </p>
            <span className="text-xs text-muted-foreground">
              仅本机 · 失败不回退
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {isLab
              ? "当前连接的是模拟主机，不代表真实 Grok Bot 已切换。"
              : status?.host.wired
                ? "切换以主机读回状态为准。"
                : "可先管理供应商配置。真实主机接入尚未开放。"}
          </p>
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
                onClick={() => void prepare("rollback")}
              >
                <Undo2 className="h-4 w-4" />
                切回上一通道
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
                      !error && !isLab && status?.activeProfile === profile.id
                    }
                    busy={disabled || !!error}
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
      {review && (review.kind === "use" || review.kind === "rollback") && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setReview(null);
          }}
        >
          <DialogContent
            className="w-[calc(100%-2rem)] max-w-xl"
            onEscapeKeyDown={(e) => {
              if (busy) e.preventDefault();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {review.kind === "use" ? "切换计划" : "切回上一通道"}
              </DialogTitle>
              <DialogDescription>
                {review.plan.runtimeKind === "lab-synthetic"
                  ? "这是模拟切换，不会切换真实 Grok Bot。"
                  : "确认前不会改变主机。"}
                {review.kind === "rollback"
                  ? " 按当前配置重新切换，不是原样恢复历史快照。"
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="dialog-scroll space-y-4">
              <p>目标：{review.plan.target || "未确定"}</p>
              <p className="endpoint font-mono text-xs">
                {review.plan.resolvedEndpoint
                  ? "POST " + review.plan.resolvedEndpoint
                  : "官方通道"}
              </p>
              <p className="text-sm text-muted-foreground">
                {review.plan.protocol} {review.plan.model}
              </p>
              {blocked.map((reason) => (
                <p
                  key={reason}
                  className="rounded-lg bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100 p-3"
                >
                  {reason}
                </p>
              ))}
              {error && (
                <p role="alert" className="text-red-600">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setReview(null)}
              >
                取消
              </Button>
              <Button
                disabled={busy || blocked.length > 0 || !review.plan.target}
                onClick={() => void applyReview()}
              >
                {busy ? "执行中" : "确认切换"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
