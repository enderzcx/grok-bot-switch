// Model id input with a fetched list, in the spirit of CC Switch's model
// selector: once URL and key are filled the provider's /models endpoint is
// queried and the ids are offered as a filterable list. Typing a custom id
// always works.
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Label } from "@/components/ui/label";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, type ModelsQuery } from "@/lib/api";

export function ModelPicker({
  value,
  onChange,
  query,
  canFetch,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  query: ModelsQuery;
  canFetch: boolean;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const fetchedFor = useRef<string>("");
  const wrapper = useRef<HTMLDivElement>(null);

  const signature = JSON.stringify([query.baseUrl, query.protocol, query.authType, query.apiKey ? "k" : "", query.name ?? ""]);

  async function load(force = false) {
    if (!canFetch || loading) return;
    if (!force && fetchedFor.current === signature) return;
    setLoading(true);
    setNote(null);
    try {
      const result = await api.models(query);
      fetchedFor.current = signature;
      setModels(result.models);
      if (result.note) setNote(result.note);
      else if (result.models.length === 0) setNote("接口没有返回模型列表，请直接填写模型名");
      else setOpen(true);
    } catch (e) {
      setModels(null);
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Inputs changed: drop the stale list, refetch lazily on next focus.
    if (fetchedFor.current !== signature) setModels(null);
  }, [signature]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    if (!models) return [];
    const needle = value.trim().toLowerCase();
    const list = needle ? models.filter((m) => m.toLowerCase().includes(needle)) : models;
    return list.slice(0, 40);
  }, [models, value]);

  return (
    <div className="space-y-2" ref={wrapper}>
      <div className="flex items-center justify-between">
        <Label htmlFor="model">模型</Label>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={!canFetch || loading || disabled} onClick={() => void load(true)} title={canFetch ? "从接口拉取可用模型" : "先填接口根地址和 API key"}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {models ? `${models.length} 个模型` : "获取模型列表"}
        </Button>
      </div>
      <div className="relative">
        <ImeSafeInput
          id="model"
          value={value}
          onValueChange={(v) => {
            onChange(v);
            if (models) setOpen(true);
          }}
          onFocus={() => {
            if (models) setOpen(true);
            else void load();
          }}
          placeholder="gpt-5"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className="pr-9"
        />
        {models && models.length > 0 && (
          <button type="button" className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)} aria-label="展开模型列表">
            <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
          </button>
        )}
        {open && models && filtered.length > 0 && (
          <ul role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg py-1">
            {filtered.map((m) => (
              <li key={m}>
                <button
                  type="button"
                  role="option"
                  aria-selected={m === value}
                  className={cn("w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-muted", m === value && "bg-muted")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(m);
                    setOpen(false);
                  }}
                >
                  {m}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {note && <p className="text-xs text-muted-foreground break-all">{note}</p>}
    </div>
  );
}
