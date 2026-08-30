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
  desiredProfile: string;
  activeProfile: string | null;
  observedProfile?: string | null;
  runtimeKind: string | null;
  blocking: string[];
  host: { wired: boolean };
}
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
export async function api<T>(path: string, body?: unknown): Promise<T> {
  if (!path.startsWith("/api/") || path.includes("://"))
    throw new Error("只允许本机 API");
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "请求失败");
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
