// Same-origin adapter to the grok-switch panel API served by dist/grok-switch.cjs.
// The per-run token comes from the URL the CLI printed (?t=...).

export type Protocol = "openai-chat" | "openai-responses" | "anthropic-messages";
export type AuthType = "bearer" | "x-api-key" | "none" | "codex";

export interface Provider {
  protocol: Protocol;
  baseUrl: string;
  model: string;
  authType?: AuthType;
  endpointPath?: string;
  headers?: Record<string, string>;
  parameters?: { reasoningEffort?: string; maxTokens?: number; anthropicVersion?: string };
  hasKey: boolean;
  summary: string;
  valid: boolean;
}

export interface HostState {
  path: string;
  exists: boolean;
  version: string | null;
  patched: boolean;
  patchVersion: string | null;
  backupExists: boolean;
  process: { pid: number; startedAtMs: number | null } | null;
  runningCurrentBundle: boolean | null;
  supervisor: { busy: boolean; pending: { id: string } | null };
}

export interface Job {
  status: "running" | "done" | "failed";
  url: string | null;
  code: string | null;
  error: string | null;
  output: string;
}

export interface UsageTotal {
  requests: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  lastUsedAt: string | null;
}

export interface LogEntry {
  ts?: string;
  provider?: string;
  model?: string;
  kind?: string;
  status?: number;
  ms?: number;
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
  raw?: string;
}

export interface State {
  version: string;
  host: HostState;
  active: string | null;
  route: "official" | "external" | "error";
  routeError: string | null;
  providers: Record<string, Provider>;
  usage: Record<string, UsageTotal>;
  recent: LogEntry[];
  codex: {
    installed: boolean;
    loggedIn: boolean;
    account: string | null;
    defaultModel: string | null;
    jobs: Record<string, Job>;
  };
  configPath: string;
}

export interface Probe {
  ok: boolean;
  ms: number;
  text: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  error: string | null;
}

export interface ProviderInput {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  authType?: string;
  endpointPath?: string;
  headers?: string[];
  reasoning?: string;
  maxTokens?: string;
  test?: boolean;
}

export const DEFAULT_PATHS: Record<Protocol, string> = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
};

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  "openai-chat": "OpenAI Chat Completions（推荐，兼容最广）",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages（Claude）",
};

export function endpointPreview(protocol: Protocol, baseUrl: string, endpointPath?: string): string {
  const base = (baseUrl || "https://api.example.com/v1").replace(/\/+$/, "");
  return base + (endpointPath && endpointPath.trim() ? endpointPath.trim() : DEFAULT_PATHS[protocol]);
}

const token = new URLSearchParams(window.location.search).get("t") ?? "";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-gs-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? response.statusText);
  return json as T;
}

export const api = {
  state: () => call<State>("/api/state"),
  saveProvider: (input: ProviderInput) => call<{ saved: string; probe: Probe | null; state: State }>("/api/providers", input),
  deleteProvider: (name: string) => call<{ lines: string[]; state: State }>("/api/providers/delete", { name }),
  test: (name: string) => call<{ probe: Probe }>("/api/test", { name }),
  use: (name: string) => call<{ lines: string[]; state: State }>("/api/use", { name }),
  official: () => call<{ lines: string[]; state: State }>("/api/official", {}),
  restart: () => call<{ lines: string[]; state: State }>("/api/restart", {}),
  restore: () => call<{ lines: string[]; state: State }>("/api/restore", {}),
  codexInstall: () => call<{ state: State }>("/api/codex/install", {}),
  codexLogin: (name: string, model: string) => call<{ state: State }>("/api/codex/login", { name, model }),
  codexCancel: () => call<{ state: State }>("/api/codex/cancel", {}),
};
