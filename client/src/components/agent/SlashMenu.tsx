// src/components/agent/SlashMenu.tsx
//
// Slash-command autocomplete shown while the user types "/..." in the chat
// input, with inline create / edit / delete (no separate settings page).
// Portaled to <body> (data-agent-popover so it doesn't collapse the panel),
// positioned above the anchor. Keyboard nav (↑/↓/Enter) is driven by InputBox
// for list mode; the form steals focus so it handles its own keys.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useSlashCommands, type SlashCommand } from "../../store/slashCommands";

interface Props {
  open: boolean;
  anchorEl: HTMLElement | null;
  /** Filtered command list (kept in sync with InputBox keyboard nav). */
  items: SlashCommand[];
  highlight: number;
  onHover: (i: number) => void;
  onPick: (cmd: SlashCommand) => void;
  onClose: () => void;
  /** Called after the create/edit form closes so InputBox can refocus input. */
  onAfterEdit?: () => void;
}

type Mode = { kind: "list" } | { kind: "form"; editing: SlashCommand | null };

export function SlashMenu({
  open,
  anchorEl,
  items,
  highlight,
  onHover,
  onPick,
  onClose,
  onAfterEdit,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const add = useSlashCommands((s) => s.add);
  const update = useSlashCommands((s) => s.update);
  const remove = useSlashCommands((s) => s.remove);

  useLayoutEffect(() => {
    if (!open || !anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const width = 320;
    const margin = 8;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
    const bottom = window.innerHeight - r.top + 8;
    setPos({ left, bottom, width });
  }, [open, anchorEl, mode]);

  // Reset to the list whenever the menu closes.
  useEffect(() => {
    if (!open) setMode({ kind: "list" });
  }, [open]);

  // Esc (in list mode) + outside-click close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode.kind === "list") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorEl?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [open, anchorEl, onClose, mode]);

  if (!open || !pos) return null;

  const closeForm = () => {
    setMode({ kind: "list" });
    onAfterEdit?.();
  };

  return createPortal(
    <div
      ref={panelRef}
      data-no-drag
      data-agent-popover
      role="dialog"
      aria-label="快捷指令"
      className="fixed z-[120] flex flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900/98 shadow-2xl backdrop-blur-xl"
      style={{ left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: "min(60vh, 440px)" }}
    >
      {mode.kind === "list" ? (
        <>
          <div className="shrink-0 border-b border-zinc-800 px-3 py-2 text-[12px] text-zinc-400">
            快捷指令 · 选中后补参数回车运行
          </div>
          <div className="min-h-0 overflow-y-auto py-1">
            {items.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-zinc-500">没有匹配的快捷指令</div>
            )}
            {items.map((c, i) => (
              <div
                key={c.id}
                onMouseEnter={() => onHover(i)}
                className={
                  "group mx-1 flex items-center gap-2 rounded px-2 py-1 " +
                  (i === highlight ? "bg-white/10" : "hover:bg-white/5")
                }
              >
                <button type="button" onClick={() => onPick(c)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-1 text-[13px] text-zinc-100">
                    <span className="text-zinc-500">/</span>
                    <span className="truncate">{c.name}</span>
                  </div>
                  <div className="truncate text-[11px] text-zinc-500">{c.description}</div>
                </button>
                <button
                  type="button"
                  title="编辑"
                  onClick={() => setMode({ kind: "form", editing: c })}
                  className="p-1 text-zinc-500 opacity-0 transition hover:text-zinc-200 group-hover:opacity-100"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => remove(c.id)}
                  className="p-1 text-zinc-500 opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setMode({ kind: "form", editing: null })}
            className="flex shrink-0 items-center gap-1.5 border-t border-zinc-800 px-3 py-2 text-[12px] text-zinc-300 hover:bg-white/5"
          >
            <Plus size={13} /> 新建快捷指令
          </button>
        </>
      ) : (
        <CommandForm
          editing={mode.editing}
          onCancel={closeForm}
          onSave={(data) => {
            if (mode.editing) update(mode.editing.id, data);
            else add(data);
            closeForm();
          }}
        />
      )}
    </div>,
    document.body,
  );
}

function CommandForm({
  editing,
  onCancel,
  onSave,
}: {
  editing: SlashCommand | null;
  onCancel: () => void;
  onSave: (data: Omit<SlashCommand, "id">) => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [template, setTemplate] = useState(editing?.template ?? "");
  const valid = name.trim().length > 0 && template.trim().length > 0;

  return (
    <div className="space-y-2 p-3">
      <div className="text-[12px] text-zinc-400">{editing ? "编辑快捷指令" : "新建快捷指令"}</div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value.replace(/[\s/]/g, ""))}
        placeholder="指令名（无空格，如 找视频）"
        className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[13px] text-zinc-100 focus:outline-none focus:border-zinc-500"
      />
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="一句话描述"
        className="w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[12px] text-zinc-100 focus:outline-none focus:border-zinc-500"
      />
      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        rows={4}
        placeholder="提示词模板，用 $ARGUMENTS 代表参数"
        className="w-full resize-none rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[12px] leading-snug text-zinc-100 focus:outline-none focus:border-zinc-500"
      />
      <div className="text-[10px] text-zinc-500">
        用 <span className="text-zinc-300">$ARGUMENTS</span> 代表 /命令 后面输入的内容。
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-1 text-[12px] text-zinc-400 hover:text-zinc-200"
        >
          取消
        </button>
        <button
          type="button"
          disabled={!valid}
          onClick={() =>
            onSave({ name: name.trim(), description: description.trim(), template: template.trim() })
          }
          className="rounded bg-blue-500 px-3 py-1 text-[12px] font-medium text-black transition-colors hover:bg-blue-400 disabled:opacity-50"
        >
          保存
        </button>
      </div>
    </div>
  );
}
