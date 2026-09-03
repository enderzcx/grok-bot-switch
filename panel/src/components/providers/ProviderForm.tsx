// Grok Bot data adapter for the CC Switch full-screen provider form and controls.
import { FormEvent, useMemo, useState } from "react";
import { Play, Save } from "lucide-react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ApiKeyInput from "./forms/ApiKeyInput";
import { RequestHeadersEditor } from "./forms/RequestHeadersEditor";
import { normalizeRequestHeaders } from "./forms/helpers/requestHeaders";
import { cn } from "@/lib/utils";
import { api, endpointPreview, PROTOCOL_LABELS, type Probe, type Protocol, type Provider, type ProviderInput, type State } from "@/lib/api";

interface Preset {
  id: string;
  label: string;
  protocol: Protocol;
  url: string;
  model: string;
  note?: string;
}

const PRESETS: Preset[] = [
  { id: "custom", label: "自定义 / 中转站", protocol: "openai-chat", url: "", model: "", note: "填中转站给你的根地址，一般以 /v1 结尾" },
  { id: "openai", label: "OpenAI", protocol: "openai-chat", url: "https://api.openai.com/v1", model: "gpt-5" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai-chat", url: "https://api.deepseek.com", model: "deepseek-chat" },
  { id: "xai", label: "xAI", protocol: "openai-chat", url: "https://api.x.ai/v1", model: "grok-4" },
  { id: "kimi", label: "Kimi", protocol: "openai-chat", url: "https://api.moonshot.cn/v1", model: "kimi-k2-0905-preview" },
  { id: "qwen", label: "通义千问", protocol: "openai-chat", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-max" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai-chat", url: "https://openrouter.ai/api/v1", model: "openai/gpt-5" },
  { id: "anthropic", label: "Anthropic", protocol: "anthropic-messages", url: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
];

const PROTOCOLS = Object.keys(PROTOCOL_LABELS) as Protocol[];

export function Choice({ id, label, value, onChange, options, disabled = false }: { id: string; label: string; value: string; onChange: (value: string) => void; options: [string, string][]; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ProviderForm({
  editing,
  initial,
  takenNames,
  onClose,
  onSaved,
}: {
  editing: string | null;
  initial: Provider | null;
  takenNames: string[];
  onClose: () => void;
  onSaved: (state: State, name: string, probe: Probe | null, useNow: boolean) => void;
}) {
  const [preset, setPreset] = useState<string>(editing ? "" : "custom");
  const [name, setName] = useState(editing ?? "");
  const [protocol, setProtocol] = useState<Protocol>(initial?.protocol ?? "openai-chat");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [authType, setAuthType] = useState(initial?.authType && initial.authType !== "codex" ? initial.authType : "default");
  const [endpointPath, setEndpointPath] = useState(initial?.endpointPath ?? "");
  const [reasoning, setReasoning] = useState(initial?.parameters?.reasoningEffort ?? "");
  const [maxTokens, setMaxTokens] = useState(initial?.parameters?.maxTokens ? String(initial.parameters.maxTokens) : "");
  const [headers, setHeaders] = useState<Record<string, string>>(initial?.headers ?? {});
  const [advanced, setAdvanced] = useState(Boolean(initial?.endpointPath || initial?.parameters || (initial?.headers && Object.keys(initial.headers).length)));
  const [pending, setPending] = useState<"save" | "use" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const codex = initial?.authType === "codex";
  const nameError = useMemo(() => {
    if (editing) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return name ? "只能用英文、数字、点、下划线、横线" : null;
    if (takenNames.includes(name)) return "已有同名来源，保存会覆盖它";
    return null;
  }, [name, editing, takenNames]);

  function applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    setPreset(id);
    if (!p) return;
    setProtocol(p.protocol);
    if (p.url) setBaseUrl(p.url);
    if (p.model) setModel(p.model);
    if (!name && id !== "custom") setName(id);
  }

  async function submit(event: FormEvent | null, useNow: boolean) {
    event?.preventDefault();
    setError(null);
    const input: ProviderInput = {
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey,
      authType: codex ? "codex" : authType === "default" ? "" : authType,
      endpointPath: endpointPath.trim(),
      reasoning: reasoning.trim(),
      maxTokens: maxTokens.trim(),
      headers: Object.entries(normalizeRequestHeaders(headers)).map(([k, v]) => `${k}: ${v}`),
    };
    if (!input.name) return setError("请填写名字");
    if (!input.baseUrl) return setError("请填写接口根地址");
    if (!input.model) return setError("请填写模型");
    if (!editing && !codex && authType !== "none" && !apiKey) return setError("请填写 API key（不需要的话把认证方式改成“无”）");
    setPending(useNow ? "use" : "save");
    try {
      const result = await api.saveProvider(input);
      if (result.probe && !result.probe.ok) {
        setError("已保存，但测试请求失败：" + result.probe.error + "。请检查地址、key、模型。");
        onSaved(result.state, input.name, result.probe, false);
        return;
      }
      onSaved(result.state, input.name, result.probe, useNow);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  return (
    <FullScreenPanel
      title={editing ? `编辑 ${editing}` : "添加模型来源"}
      onClose={onClose}
      pending={busy}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void submit(null, false)}>
            <Save className="h-4 w-4" />
            {pending === "save" ? "测试中…" : "测试并保存"}
          </Button>
          <Button disabled={busy} onClick={() => void submit(null, true)}>
            <Play className="h-4 w-4" />
            {pending === "use" ? "测试中…" : "测试、保存并使用"}
          </Button>
        </>
      }
    >
      <form id="provider-form" className="space-y-6" onSubmit={(e) => void submit(e, true)}>
        {!editing && (
          <div className="space-y-2">
            <Label>快速填入</Label>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    preset === p.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted/40 text-foreground hover:border-primary/60",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {PRESETS.find((p) => p.id === preset)?.note && <p className="text-xs text-muted-foreground">{PRESETS.find((p) => p.id === preset)?.note}</p>}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="name">名字（聊天里用 /gs use 名字）</Label>
            <ImeSafeInput id="name" value={name} onValueChange={setName} placeholder="myapi" disabled={Boolean(editing)} autoComplete="off" />
            {nameError && <p className="text-xs text-amber-600 dark:text-amber-400">{nameError}</p>}
          </div>
          <Choice id="protocol" label="协议" value={protocol} onChange={(v) => setProtocol(v as Protocol)} options={PROTOCOLS.map((p) => [p, PROTOCOL_LABELS[p]])} disabled={codex} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="baseUrl">接口根地址</Label>
          <ImeSafeInput id="baseUrl" value={baseUrl} onValueChange={setBaseUrl} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} disabled={codex} />
          <p className="text-xs text-muted-foreground font-mono break-all">实际请求 {endpointPreview(protocol, baseUrl, endpointPath)}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="model">模型</Label>
            <ImeSafeInput id="model" value={model} onValueChange={setModel} placeholder="gpt-5" autoComplete="off" spellCheck={false} />
          </div>
          {codex ? (
            <div className="space-y-2">
              <Label>认证</Label>
              <p className="text-sm text-muted-foreground pt-2">ChatGPT 登录，不需要 API key</p>
            </div>
          ) : (
            <ApiKeyInput id="apiKey" value={apiKey} onChange={setApiKey} label={editing ? "API key（留空 = 不改）" : "API key"} placeholder={editing ? "留空则保留已保存的 key" : "sk-..."} disabled={authType === "none"} />
          )}
        </div>

        <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "▾ 收起高级选项" : "▸ 高级选项（认证方式、自定义路径、reasoning、请求头）"}
        </button>

        {advanced && (
          <div className="space-y-6 rounded-xl border border-border bg-muted/20 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {!codex && (
                <Choice
                  id="authType"
                  label="认证方式"
                  value={authType}
                  onChange={setAuthType}
                  options={[
                    ["default", "按协议默认"],
                    ["bearer", "Authorization: Bearer"],
                    ["x-api-key", "x-api-key"],
                    ["none", "无"],
                  ]}
                />
              )}
              <div className="space-y-2">
                <Label htmlFor="endpointPath">自定义请求路径</Label>
                <Input id="endpointPath" value={endpointPath} onChange={(e) => setEndpointPath(e.target.value)} placeholder={"默认 " + endpointPreview(protocol, "", "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/v1/, "")} autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reasoning">reasoning effort（OpenAI 协议）</Label>
                <Input id="reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value)} placeholder="low / medium / high" autoComplete="off" disabled={protocol === "anthropic-messages"} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxTokens">max tokens</Label>
                <Input id="maxTokens" type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder={protocol === "anthropic-messages" ? "默认 8192" : "不限制"} />
              </div>
            </div>
            <RequestHeadersEditor headers={headers} onHeadersChange={setHeaders} />
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-300 break-words">
            {error}
          </p>
        )}
      </form>
    </FullScreenPanel>
  );
}
