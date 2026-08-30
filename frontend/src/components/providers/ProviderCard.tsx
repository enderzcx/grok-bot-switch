// Adapted from CC Switch ProviderCard.tsx (MIT, Jason Young).
// Preserve the provider row, title/icon/status/actions layout. Remove native
// client config, usage-query, auth-binding and failover integrations.
import { Bot, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Profile } from "@/lib/api";
import { ProviderStatusBadge } from "./ProviderStatusBadge";
import { ProviderActions } from "./ProviderActions";

export function ProviderCard({
  provider,
  active,
  busy,
  onAction,
}: {
  provider: Profile;
  active: boolean;
  busy: boolean;
  onAction: (
    action: "plan" | "edit" | "secret" | "test" | "delete",
    profile: Profile,
  ) => void;
}) {
  const official = provider.id === "official";
  const secret = provider.secret || {};
  return (
    <article
      aria-label={provider.displayName}
      className={cn(
        "provider-card relative overflow-hidden rounded-xl border border-border p-4 bg-card text-card-foreground group shadow-sm",
        active && "border-blue-500/60 shadow-blue-500/10",
      )}
    >
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="h-9 w-9 flex-shrink-0 rounded-lg bg-muted flex items-center justify-center border border-border">
            {official ? <Bot size={20} /> : <Globe size={20} />}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2 min-h-7">
              <h3 className="text-base font-semibold leading-snug break-words">
                {provider.displayName}
              </h3>
              <ProviderStatusBadge
                label={official ? "官方通道" : provider.protocol || "自定义"}
                tone={official ? "muted" : "info"}
              />
              {!provider.enabled && (
                <ProviderStatusBadge label="已停用" tone="warning" />
              )}
            </div>
            <p className="endpoint text-xs text-muted-foreground font-mono">
              {provider.resolvedEndpoint
                ? "POST " + provider.resolvedEndpoint
                : "Grok Bot 原生推理"}
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{provider.model || provider.id}</span>
              <span>
                {official || provider.auth.type === "none"
                  ? "无需密钥"
                  : secret.rejected
                    ? "密钥不可用"
                    : secret.installed
                      ? "已安装密钥 · " + secret.fingerprintPrefix
                      : "未安装密钥"}
              </span>
              {!official && <span>失败不回退</span>}
            </div>
          </div>
        </div>
        <ProviderActions
          active={active}
          official={official}
          busy={busy}
          onPlan={() => onAction("plan", provider)}
          onEdit={() => onAction("edit", provider)}
          onSecret={() => onAction("secret", provider)}
          onTest={() => onAction("test", provider)}
          onDelete={() => onAction("delete", provider)}
        />
      </div>
    </article>
  );
}
