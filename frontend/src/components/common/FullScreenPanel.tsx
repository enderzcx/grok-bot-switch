// Adapted from CC Switch FullScreenPanel.tsx (MIT, Jason Young).
// Web port: Radix focus/scroll lifecycle replaces Tauri drag regions and motion.
import { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function FullScreenPanel({
  title,
  onClose,
  children,
  footer,
  pending = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  pending?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        variant="fullscreen"
        aria-describedby="panel-description"
        onEscapeKeyDown={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <div className="flex-shrink-0 flex items-center h-16 border-b border-border bg-background">
          <div className="px-6 w-full flex items-center gap-4">
            <Button
              variant="outline"
              size="icon"
              aria-label="返回供应商"
              disabled={pending}
              onClick={onClose}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription id="panel-description" className="sr-only">
              供应商配置，密钥单独保存。
            </DialogDescription>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="px-6 py-6 space-y-6 w-full max-w-4xl mx-auto">
            {children}
          </div>
        </div>
        {footer && (
          <div className="flex-shrink-0 py-4 border-t border-border bg-background">
            <div className="px-6 flex items-center justify-end gap-3 max-w-4xl mx-auto">
              {footer}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
