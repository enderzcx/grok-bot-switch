// Grok Bot data adapter for the CC Switch full-screen provider form and controls.
import { FormEvent, useState } from "react";
import { Save } from "lucide-react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ApiKeyInput from "./forms/ApiKeyInput";
import { RequestHeadersEditor } from "./forms/RequestHeadersEditor";
import { normalizeRequestHeaders } from "./forms/helpers/requestHeaders";
import {
  api,
  endpointPreview,
  profilePath,
  type Profile,
  type Protocol,
} from "@/lib/api";

export function Choice({
  id,
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
  disabled?: boolean;
}) {
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
  initial,
  onClose,
  onSaved,
}: {
  initial?: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState(initial?.id || "");
  const [name, setName] = useState(initial?.displayName || "");
  const [protocol, setProtocol] = useState<Protocol>(
    initial?.protocol || "openai-chat",
  );
  const [base, setBase] = useState(initial?.baseUrl || "");
  const [path, setPath] = useState(initial?.endpointPath || "");
  const [model, setModel] = useState(initial?.model || "");
  const [auth, setAuth] = useState(initial?.auth.type || "bearer");
  const [adapter, setAdapter] = useState(initial?.auth.adapter || "");
  const [headers, setHeaders] = useState(initial?.headers || {});
  const [max, setMax] = useState(String(initial?.parameters.maxTokens || ""));
  const [effort, setEffort] = useState(
    initial?.parameters.reasoningEffort || "unset",
  );
  const [key, setKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const endpoint = endpointPreview(base, protocol, path);
  const title = initial ? "编辑供应商" : "添加供应商";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (protocol === "anthropic-messages" && effort !== "unset") {
      setError("Messages 不支持此推理强度参数，请选择“不设置”。");
      return;
    }
    setPending(true);
    setError("");
    const secret = key;
    setKey("");
    const parameters = { ...initial?.parameters };
    if (max) parameters.maxTokens = Number(max);
    else delete parameters.maxTokens;
    if (effort !== "unset") parameters.reasoningEffort = effort;
    else delete parameters.reasoningEffort;
    const profile = {
      schemaVersion: 1,
      id,
      displayName: name,
      protocol,
      baseUrl: base,
      model,
      ...(path ? { endpointPath: path } : {}),
      auth: { type: auth, ...(auth === "oauth-adapter" ? { adapter } : {}) },
      headers: normalizeRequestHeaders(headers),
      parameters,
      enabled: initial?.enabled ?? true,
      fallbackPolicy: "never",
    };
    try {
      // A secret error after creation must not make retry create the profile twice.
      const target = initial?.id || savedId;
      const saved = await api<Profile>(
        target ? profilePath(target) + "/update" : "/api/providers",
        profile,
      );
      if (!initial) setSavedId(saved.id);
      if (!initial && secret)
        await api(profilePath(saved.id) + "/secret", { secret });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法保存");
    } finally {
      setPending(false);
    }
  }

  return (
    <FullScreenPanel
      title={title}
      onClose={onClose}
      pending={pending}
      footer={
        <>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="provider-form" disabled={pending}>
            <Save className="h-4 w-4" />
            {pending ? "保存中" : "保存"}
          </Button>
        </>
      }
    >
      <form id="provider-form" onSubmit={submit} className="space-y-6">
        <fieldset disabled={pending} className="contents">
          <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            {initial
              ? "修改配置不会读取或替换已有密钥。正在使用或保留用于恢复的通道不可修改。"
              : "配置与密钥分开保存。填写你的供应商地址和模型，保存不会发送推理请求。"}
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-200 p-3"
            >
              {error}
              {savedId
                ? " 配置已保存；如需安装密钥，请重新输入后保存，或返回列表管理密钥。"
                : ""}
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="provider-id">编号</Label>
              <Input
                id="provider-id"
                value={id}
                onChange={(e) => setId(e.target.value)}
                required
                pattern="[a-z][a-z0-9-]*"
                readOnly={!!initial || !!savedId}
                placeholder="custom-provider"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider-name">名称</Label>
              <ImeSafeInput
                id="provider-name"
                value={name}
                onValueChange={setName}
                required
                placeholder="我的供应商"
              />
            </div>
            <Choice
              id="protocol"
              label="API 协议"
              value={protocol}
              onChange={(value) => setProtocol(value as Protocol)}
              options={[
                ["openai-chat", "OpenAI Chat Completions"],
                ["openai-responses", "OpenAI Responses"],
                ["anthropic-messages", "Anthropic Messages"],
              ]}
            />
            <Choice
              id="auth"
              label="认证方式"
              value={auth}
              onChange={setAuth}
              options={[
                ["bearer", "Bearer API Key"],
                ["x-api-key", "x-api-key"],
                ["none", "无需认证"],
                ["oauth-adapter", "OAuth 适配器（尚未接入）"],
              ]}
            />
            <div className="space-y-2">
              <Label htmlFor="base-url">根地址</Label>
              <Input
                id="base-url"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                required
                type="url"
                placeholder="https://api.example.com/v1"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model">模型</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                required
                placeholder="供应商提供的模型 ID"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="max-tokens">
                输出 token 上限
                {protocol === "anthropic-messages" ? "（必填）" : "（可选）"}
              </Label>
              <Input
                id="max-tokens"
                value={max}
                onChange={(e) => setMax(e.target.value)}
                type="number"
                min={1}
                max={1000000}
                step={1}
                required={protocol === "anthropic-messages"}
                placeholder="8192"
              />
            </div>
            <Choice
              id="reasoning"
              label="推理强度（OpenAI 协议）"
              value={effort}
              onChange={setEffort}
              options={[
                "unset",
                "none",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ].map((value) => [value, value === "unset" ? "不设置" : value])}
            />
            {auth === "oauth-adapter" && (
              <div className="space-y-2">
                <Label htmlFor="adapter">适配器编号</Label>
                <Input
                  id="adapter"
                  value={adapter}
                  onChange={(e) => setAdapter(e.target.value)}
                  required
                />
              </div>
            )}
          </div>
          {!initial && auth !== "none" && (
            <ApiKeyInput
              value={key}
              onChange={setKey}
              disabled={pending}
              label="API Key（可稍后安装）"
            />
          )}
          {initial && (
            <p className="text-sm text-muted-foreground">
              密钥：
              {initial.secret?.installed
                ? "已安装 · " + initial.secret.fingerprintPrefix
                : "未安装"}
              。如需修改，请返回列表选择“管理密钥”。
            </p>
          )}
          <RequestHeadersEditor
            headers={headers}
            onHeadersChange={setHeaders}
          />
          <details className="space-y-3 rounded-lg border border-border p-4">
            <summary className="cursor-pointer font-medium">
              高级：接口路径
            </summary>
            <Label htmlFor="endpoint-path">接口后缀（覆盖协议默认值）</Label>
            <Input
              id="endpoint-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="留空使用协议默认路径"
            />
            <p className="text-xs text-muted-foreground">
              追加到根地址路径，query 参数保留在末尾。
            </p>
          </details>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              实际请求地址
            </p>
            <p className="endpoint rounded-lg bg-muted p-3 font-mono text-xs">
              {endpoint ? "POST " + endpoint : "填写有效地址后显示"}
            </p>
          </div>
        </fieldset>
      </form>
    </FullScreenPanel>
  );
}
