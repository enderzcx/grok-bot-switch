// Adapted from CC Switch ProviderActions.tsx (MIT, Jason Young).
// Only Grok Bot actions remain; activation performs a silent server preflight.
import { Activity, Check, Edit, KeyRound, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ProviderActions({
  active,
  official,
  busy,
  switching,
  onUse,
  onEdit,
  onSecret,
  onTest,
  onDelete,
}: {
  active: boolean;
  official: boolean;
  busy: boolean;
  switching: boolean;
  onUse: () => void;
  onEdit: () => void;
  onSecret: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const iconButtonClass = "h-8 w-8 p-1";
  return (
    <div className="provider-actions flex items-center gap-1.5">
      <Button
        size="sm"
        variant={active ? "secondary" : "default"}
        disabled={busy || active}
        onClick={onUse}
        className="w-fit px-2.5"
      >
        {active ? <Check className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        {switching ? "切换中" : active ? "使用中" : "使用"}
      </Button>
      <div className="flex items-center gap-1">
        {!official && (
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            onClick={onEdit}
            aria-label="编辑供应商"
            title="编辑"
            className={iconButtonClass}
          >
            <Edit className="h-4 w-4" />
          </Button>
        )}
        {!official && (
          <Button
            size="icon"
            variant="ghost"
            disabled={busy}
            onClick={onSecret}
            aria-label="管理密钥"
            title="管理密钥"
            className={iconButtonClass}
          >
            <KeyRound className="h-4 w-4" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          disabled={busy}
          onClick={onTest}
          aria-label="测试配置"
          title="测试配置，不发送推理请求"
          className={iconButtonClass}
        >
          <Activity className="h-4 w-4" />
        </Button>
        {!official && (
          <Button
            size="icon"
            variant="ghost"
            disabled={busy || active}
            onClick={onDelete}
            aria-label="删除供应商"
            title="删除"
            className={iconButtonClass + " hover:text-red-500"}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
