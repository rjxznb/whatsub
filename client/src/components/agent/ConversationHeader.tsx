import { useState } from "react";
import { Plus, MoreHorizontal, X, ChevronDown } from "lucide-react";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { useAgent } from "../../store/agent";

interface Props {
  onClose: () => void;
}

export function ConversationHeader({ onClose }: Props) {
  const history = useAgent((s) => s.history);
  const activeConv = history.conversations.find(
    (c) => c.id === history.activeConversationId,
  );
  const title = activeConv?.title ?? "新对话";

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="h-10 flex items-center px-2 border-b border-zinc-800 gap-1 relative">
      {/* Title + dropdown chevron */}
      <button
        type="button"
        onClick={() => setDropdownOpen((v) => !v)}
        className="flex items-center gap-1 text-sm text-zinc-100 hover:bg-zinc-800 px-2 py-1 rounded flex-1 truncate text-left"
        aria-label="选择会话"
      >
        <ChevronDown size={14} className="text-zinc-400 shrink-0" />
        <span className="truncate">{title}</span>
      </button>

      {/* ⊕ New */}
      <button
        type="button"
        onClick={() => {
          const pathname =
            typeof window !== "undefined" ? window.location.pathname : "/";
          useAgent.getState().createConversation({ pathname });
        }}
        aria-label="新对话"
        title="新对话"
        className="h-7 w-7 grid place-items-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
      >
        <Plus size={16} />
      </button>

      {/* ☰ Menu */}
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="菜单"
        title="菜单"
        className="h-7 w-7 grid place-items-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
      >
        <MoreHorizontal size={16} />
      </button>

      {/* ✕ Close */}
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        title="关闭"
        className="h-7 w-7 grid place-items-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
      >
        <X size={16} />
      </button>

      {/* Dropdown: list of conversations */}
      {dropdownOpen && (
        <div
          role="menu"
          aria-label="会话列表"
          className="absolute top-10 left-2 w-[280px] max-h-[300px] overflow-y-auto bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-10"
        >
          {history.conversations.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500">还没有会话</div>
          ) : (
            history.conversations.map((c) => (
              <div
                key={c.id}
                className={
                  "px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800 cursor-pointer " +
                  (c.id === history.activeConversationId
                    ? "text-blue-400"
                    : "text-zinc-200")
                }
                onClick={() => {
                  useAgent.getState().switchActive(c.id);
                  setDropdownOpen(false);
                }}
              >
                <span className="flex-1 truncate">{c.title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    useAgent.getState().deleteConversation(c.id);
                  }}
                  className="text-zinc-500 hover:text-rose-400 text-xs"
                  aria-label={`删除会话 ${c.title}`}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ☰ Menu options */}
      {menuOpen && (
        <div
          role="menu"
          aria-label="操作菜单"
          className="absolute top-10 right-12 w-[180px] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-10"
        >
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
            onClick={() => {
              if (history.activeConversationId) {
                useAgent
                  .getState()
                  .deleteConversation(history.activeConversationId);
                const pathname =
                  typeof window !== "undefined"
                    ? window.location.pathname
                    : "/";
                useAgent.getState().createConversation({ pathname });
              }
              setMenuOpen(false);
            }}
          >
            清空当前会话
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-rose-300 hover:bg-zinc-800"
            onClick={async () => {
              // Tauri v2 webview's native window.confirm is unreliable
              // (CLAUDE.md "踩过的坑"). Use plugin-dialog's confirm instead.
              try {
                const ok = await tauriConfirm(
                  "确认清空所有 AI 助手历史？此操作不可撤销。",
                );
                if (ok) useAgent.getState().clearAll();
              } catch {
                // Dialog plugin can throw in non-Tauri contexts (e.g. tests).
                // In that case do nothing — safer than wiping silently.
              }
              setMenuOpen(false);
            }}
          >
            清空所有历史
          </button>
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
            onClick={() => {
              const json = useAgent.getState().exportHistory();
              navigator.clipboard?.writeText(json).catch(() => {});
              setMenuOpen(false);
            }}
          >
            导出为 JSON（复制到剪贴板）
          </button>
        </div>
      )}
    </div>
  );
}
