export type Protocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages";
export interface Profile {
  schemaVersion: 1;
  id: string;
  displayName: string;
  mode?: string;
  builtIn?: boolean;
  protocol: Protocol | null;
  baseUrl: string | null;
  endpointPath?: string | null;
  model: string | null;
  auth: { type: string; adapter?: string };
  headers: Record<string, string>;
  parameters: { maxTokens?: number; reasoningEffort?: string };
  enabled: boolean;
  fallbackPolicy: "never";
  resolvedEndpoint?: string;
  secret?: {
    installed?: boolean;
    required?: boolean;
    rejected?: boolean;
    fingerprintPrefix?: string;
  };
}
export interface Status {
  connectionMode?: "desktop" | "independent";
  pairing?: { configured: boolean; defaultRelayUrl: string };
  desiredProfile: string;
  activeProfile: string | null;
  observedProfile?: string | null;
  runtimeKind: string | null;
  blocking: string[];
  host: { wired: boolean };
  previousProfile?: string | null;
  client?: {
    connected: boolean;
    mode: "probe" | "native-switch";
    transport?: string;
    error?: { code: string; message: string };
    pairingConfirmed?: boolean;
    pairedInstanceId?: string;
    hostReachable: boolean;
    providerSwitchReady: boolean;
    runtime?: Record<string, unknown>;
  };
  activation?: Activation | null;
  installation?: {
    detected: boolean;
    ambiguous: boolean;
    integrationReady: boolean;
    installations: { path: string; executable: string; version: string }[];
  };
}
export interface Activation {
  id: string;
  status: "pending" | "verified" | "needs-attention" | "failed";
  phase: string;
  error?: string | { message?: string } | null;
  target: string;
  generation: number;
}
export type ActionResult = Partial<Activation> & {
  verified?: boolean;
  ok?: boolean;
};
export interface Plan {
  target?: string;
  id?: string;
  action?: string;
  protocol?: string;
  model?: string;
  resolvedEndpoint?: string;
  blocking?: string[];
  wired?: boolean;
  runtimeKind?: string;
  allowSyntheticApply?: boolean;
}
export interface Activity {
  at: string;
  type: string;
  profileId?: string;
}

export function csrfToken(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')
      ?.content || ""
  );
}
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!path.startsWith("/api/") || path.includes("://"))
    throw new Error("只允许本机 API");
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(signal ? { signal } : {}),
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      (typeof payload.error === "string"
        ? payload.error
        : payload.error?.message) || "请求失败",
    );
  return payload as T;
}
export const profilePath = (id: string) =>
  "/api/providers/" + encodeURIComponent(id);
export function endpointPreview(
  base: string,
  protocol: Protocol,
  path: string,
): string {
  const suffix = {
    "openai-chat": "/chat/completions",
    "openai-responses": "/responses",
    "anthropic-messages": "/messages",
  }[protocol];
  try {
    const url = new URL(base);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      return "";
    url.pathname = url.pathname.replace(/\/+$/, "") + (path || suffix);
    return url.href;
  } catch {
    return "";
  }
}
const labels: Record<string, string> = {
  "not-wired": "主机未接入",
  "needs-key": "未安装密钥",
  "secret-rejected": "密钥文件不安全",
  "busy-agent": "主机有任务运行中",
  "unknown-host-state": "当前云端版本或状态尚未支持，未执行切换",
  "unsupported-supervisor": "当前云端重启组件尚未支持",
  "host-unreachable": "暂时无法连接云端运行服务",
  "active-state-drift": "云端运行状态已变化，请检查后再切换",
  "activation-in-progress": "正在处理上一项切换，请先检查进度",
  "pending-command": "主机有待处理命令",
  "unknown-hash": "主机版本未验证",
  drift: "主机状态与配置不一致",
  "missing-receipt": "缺少切换回执",
  "snapshot-mismatch": "历史快照校验失败",
  "unsafe-endpoint": "地址未通过安全校验",
  disabled: "供应商已停用",
  "lab-runtime": "模拟切换未启用",
};
export function planBlockers(plan: Plan): string[] {
  const codes = new Set(plan.blocking || []);
  if (plan.wired === false) codes.add("not-wired");
  if (plan.runtimeKind === "lab-synthetic" && !plan.allowSyntheticApply)
    codes.add("lab-runtime");
  return [...codes].map((code) => labels[code] || "尚未满足切换条件：" + code);
}
