// Adapted from CC Switch ProviderCard.tsx (MIT, Jason Young).
// Preserves the provider row layout: icon, title, badges, endpoint, actions.
import { Bot, Globe, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Provider } from "@/lib/api";
import { ProviderStatusBadge } from "./ProviderStatusBadge";
import { ProviderActions } from "./ProviderActions";

const PROTOCOL_BADGE: Record<string, string> = {
  "openai-chat": "Chat",
  "openai-responses": "Responses",
  "anthropic-messages": "Anthropic",
};

export function ProviderCard({
  name,
  provider,
  active,
  busy,
  switching,
  onUse,
  onEdit,
  onTest,
  onDuplicate,
  onDelete,
}: {
  name: string;
  provider: Provider | null;
  active: boolean;
  busy: boolean;
  switching: boolean;
  onUse: () => void;
  onEdit?: () => void;
  onTest?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const official = provider == null;
  const codex = provider?.authType === "codex";
  const endpoint = provider ? (provider.valid ? "POST " + provider.summary.split(" ")[1] : provider.summary) : "Grok Bot 原生推理，走你的 Grok 额度";
  return (
    <article
      aria-label={name}
      className={cn(
        "provider-card relative overflow-hidden rounded-xl border border-border p-4 bg-card text-card-foreground group shadow-sm",
        active && "border-blue-500/60 shadow-blue-500/10",
      )}
    >
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="h-9 w-9 flex-shrink-0 rounded-lg bg-muted flex items-center justify-center border border-border">
            {official ? <Bot size={20} /> : codex ? <Sparkles size={20} /> : <Globe size={20} />}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2 min-h-7">
              <h3 className="text-base font-semibold leading-snug break-words">{official ? "官方 Grok" : name}</h3>
              <ProviderStatusBadge label={official ? "原厂通道" : PROTOCOL_BADGE[provider.protocol] ?? provider.protocol} tone={official ? "muted" : "info"} />
              {active && <ProviderStatusBadge label="使用中" tone="success" />}
              {provider && !provider.valid && <ProviderStatusBadge label="配置无效" tone="warning" title={provider.summary} />}
            </div>
            <p className="endpoint text-xs text-muted-foreground font-mono break-all">{endpoint}</p>
            {provider && (
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{provider.model}</span>
                <span>{codex ? "ChatGPT 登录" : provider.authType === "none" ? "无需密钥" : provider.hasKey ? "已保存密钥" : "未填密钥"}</span>
                {provider.parameters?.reasoningEffort && <span>reasoning {provider.parameters.reasoningEffort}</span>}
              </div>
            )}
          </div>
        </div>
        <ProviderActions active={active} official={official} busy={busy} switching={switching} onUse={onUse} onEdit={onEdit} onTest={onTest} onDuplicate={onDuplicate} onDelete={onDelete} />
      </div>
    </article>
  );
}
