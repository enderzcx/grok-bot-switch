// Adapted from CC Switch ProviderActions.tsx (MIT, Jason Young).
import { Activity, Check, Copy, Edit, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ProviderActions({
  active,
  official,
  busy,
  switching,
  onUse,
  onEdit,
  onTest,
  onDuplicate,
  onDelete,
}: {
  active: boolean;
  official: boolean;
  busy: boolean;
  switching: boolean;
  onUse: () => void;
  onEdit?: () => void;
  onTest?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
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
      {!official && (
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" disabled={busy} onClick={onEdit} aria-label="编辑" title="编辑" className={iconButtonClass}>
            <Edit className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" disabled={busy} onClick={onTest} aria-label="测试" title="发一条测试请求" className={iconButtonClass}>
            <Activity className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" disabled={busy} onClick={onDuplicate} aria-label="复制" title="复制为新来源（保留 key，改模型即可）" className={iconButtonClass}>
            <Copy className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={busy || active}
            onClick={onDelete}
            aria-label="删除"
            title={active ? "使用中的来源不能删除" : "删除"}
            className={iconButtonClass + " hover:text-red-500"}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
