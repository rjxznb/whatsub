import { useEffect, useRef, useState } from "react";
import { Plus, MoreHorizontal, X, ChevronDown, Mic } from "lucide-react";
import { confirmDialog } from "../../store/appDialog";
import { useAgent } from "../../store/agent";
import { useVoiceMode } from "../../store/voiceMode";

interface Props {
  onClose: () => void;
}

// Shared visual language for floating menus (conversation dropdown + ☰ menu).
// Matches the caption-settings menu in VideoPlayer.tsx: translucent + blurred
// "frosted glass" surface with a faint inner border, rounded-xl, soft drop
// shadow. Avoids the previous flat-black-on-zinc-700-border look which felt
// out of place against the panel's already-blurred backdrop.
// Origin-top works for both popovers since the dropdown anchors at top-left
// of the header and the ☰ menu anchors at top-right — both scale-up "from
// underneath the trigger," which is the natural feel for a header popover.
const FLOATING_MENU =
  "absolute top-10 bg-zinc-900/70 backdrop-blur-2xl ring-1 ring-white/10 " +
  "rounded-xl shadow-2xl shadow-black/40 overflow-hidden z-20 " +
  "origin-top animate-agent-popover-in";

export function ConversationHeader({ onClose }: Props) {
  const history = useAgent((s) => s.history);
  const openVoice = useVoiceMode((s) => s.openVoice);
  const activeConv = history.conversations.find(
    (c) => c.id === history.activeConversationId,
  );
  const title = activeConv?.title ?? "新对话";

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Outside-click dismissal — one document-level pointerdown listener while
  // either popover is open. Each popover has a wrapper ref that includes the
  // trigger button + the floating panel; a pointerdown landing outside both
  // wrappers closes whichever is open. pointerdown (not click) so the dismiss
  // fires BEFORE the click reaches an underlying element, matching the
  // behavior of native menus.
  //
  // Why two refs vs one shared ref: each popover anchors to a different
  // trigger, and we want clicking the dropdown's own trigger to toggle that
  // dropdown (not be treated as "outside" and instantly re-open in the
  // useEffect race). Two refs means the trigger's own click path is naturally
  // inside its own wrapper.
  const dropdownWrapRef = useRef<HTMLDivElement>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen && !menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (
        dropdownOpen &&
        dropdownWrapRef.current &&
        target &&
        !dropdownWrapRef.current.contains(target)
      ) {
        setDropdownOpen(false);
      }
      if (
        menuOpen &&
        menuWrapRef.current &&
        target &&
        !menuWrapRef.current.contains(target)
      ) {
        setMenuOpen(false);
      }
    }
    // Esc closes too — same expectation as every native dropdown.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setDropdownOpen(false);
        setMenuOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [dropdownOpen, menuOpen]);

  // Opening one popover closes the other — only one should be visible at a
  // time, matches the macOS menubar feel.
  const openDropdown = () => {
    setMenuOpen(false);
    setDropdownOpen((v) => !v);
  };
  const openMenu = () => {
    setDropdownOpen(false);
    setMenuOpen((v) => !v);
  };

  return (
    <div className="h-10 flex items-center px-2 border-b border-white/5 gap-1 relative">
      {/* Title + dropdown chevron — capped at a max-width so the action
          buttons (⊕ ☰ ✕) have room and the title never balloons to fill
          the entire panel header. Truncates with ellipsis when too long.
          The wrapper ref covers both the trigger and the floating dropdown
          so outside-click detection treats them as a single unit. */}
      <div ref={dropdownWrapRef} className="flex items-center min-w-0">
        <button
          type="button"
          onClick={openDropdown}
          className={
            "flex items-center gap-1 text-sm text-zinc-100 px-2 py-1 rounded-md text-left max-w-[240px] min-w-0 " +
            "transition-colors " +
            (dropdownOpen ? "bg-white/10" : "hover:bg-white/5")
          }
          aria-label="选择会话"
          aria-haspopup="menu"
          aria-expanded={dropdownOpen}
        >
          <ChevronDown
            size={14}
            className={
              "text-zinc-400 shrink-0 transition-transform " +
              (dropdownOpen ? "rotate-180" : "")
            }
          />
          <span className="truncate">{title}</span>
        </button>

        {/* Dropdown: list of conversations */}
        {dropdownOpen && (
          <div
            role="menu"
            aria-label="会话列表"
            className={FLOATING_MENU + " left-2 w-[280px] max-h-[320px] overflow-y-auto py-1"}
          >
            {history.conversations.length === 0 ? (
              <div className="px-3 py-2 text-xs text-zinc-500">还没有会话</div>
            ) : (
              history.conversations.map((c) => {
                const isActive = c.id === history.activeConversationId;
                return (
                  <div
                    key={c.id}
                    role="menuitem"
                    className={
                      "group mx-1 px-2.5 py-1.5 rounded-md flex items-center gap-2 text-sm cursor-pointer transition-colors " +
                      (isActive
                        ? "bg-white/10 text-zinc-50"
                        : "text-zinc-200 hover:bg-white/5")
                    }
                    onClick={() => {
                      useAgent.getState().switchActive(c.id);
                      setDropdownOpen(false);
                    }}
                  >
                    {/* Subtle blue dot for the active conversation —
                        replaces the all-blue text from before, which clashed
                        with the panel's neutral palette. */}
                    <span
                      className={
                        "h-1.5 w-1.5 rounded-full shrink-0 " +
                        (isActive ? "bg-sky-400" : "bg-transparent")
                      }
                    />
                    <span className="flex-1 truncate">{c.title}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        useAgent.getState().deleteConversation(c.id);
                      }}
                      className="text-zinc-500 hover:text-rose-400 text-sm opacity-0 group-hover:opacity-100 transition-opacity leading-none"
                      aria-label={`删除会话 ${c.title}`}
                    >
                      ×
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Spacer pushes the buttons right; replaces the flex-1 on the title
          button so the title hugs its content + cap instead of stretching. */}
      <div className="flex-1" />

      {/* 🎤 Voice — switch to voice mode. */}
      <button
        type="button"
        onClick={openVoice}
        aria-label="语音模式"
        title="切换到语音模式"
        className="h-7 w-7 grid place-items-center rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
      >
        <Mic size={16} />
      </button>

      {/* ⊕ New — one-shot action, no popover, no outside-click concern. */}
      <button
        type="button"
        onClick={() => {
          const pathname =
            typeof window !== "undefined" ? window.location.pathname : "/";
          useAgent.getState().createConversation({ pathname });
        }}
        aria-label="新对话"
        title="新对话"
        className="h-7 w-7 grid place-items-center rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
      >
        <Plus size={16} />
      </button>

      {/* ☰ Menu — same wrapper-ref pattern as the title dropdown so an
          outside pointerdown closes it. */}
      <div ref={menuWrapRef} className="relative">
        <button
          type="button"
          onClick={openMenu}
          aria-label="菜单"
          title="菜单"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={
            "h-7 w-7 grid place-items-center rounded-md text-zinc-400 hover:text-zinc-100 transition-colors " +
            (menuOpen ? "bg-white/10 text-zinc-100" : "hover:bg-white/5")
          }
        >
          <MoreHorizontal size={16} />
        </button>

        {/* ☰ Menu options */}
        {menuOpen && (
          <div
            role="menu"
            aria-label="操作菜单"
            className={FLOATING_MENU + " right-0 w-[200px] py-1"}
          >
            <MenuItem
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
            </MenuItem>
            <MenuItem
              tone="danger"
              onClick={async () => {
                const ok = await confirmDialog(
                  "确认清空所有 AI 助手历史？此操作不可撤销。",
                  { title: "清空历史", okText: "清空", danger: true },
                );
                if (ok) useAgent.getState().clearAll();
                setMenuOpen(false);
              }}
            >
              清空所有历史
            </MenuItem>
            {/* Visual divider between conversation ops and export. */}
            <div className="h-px bg-white/5 my-1 mx-2" />
            <MenuItem
              onClick={() => {
                const json = useAgent.getState().exportHistory();
                navigator.clipboard?.writeText(json).catch(() => {});
                setMenuOpen(false);
              }}
            >
              导出为 JSON（复制到剪贴板）
            </MenuItem>
          </div>
        )}
      </div>

      {/* ✕ Close — one-shot, no popover. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        title="关闭"
        className="h-7 w-7 grid place-items-center rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
      >
        <X size={16} />
      </button>
    </div>
  );
}

// Small row used inside the ☰ menu — same visual language as the
// conversation dropdown rows, with an optional `danger` tone for destructive
// actions (清空所有历史). Extracted because three callsites was already enough
// repetition for the spacing/hover tokens to drift across them otherwise.
function MenuItem({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "danger";
}) {
  const colors =
    tone === "danger"
      ? "text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
      : "text-zinc-200 hover:bg-white/5";
  // Wrapper provides the horizontal inset (so the hover background doesn't
  // touch the popover border); the button fills the inset region.
  return (
    <div className="px-1">
      <button
        type="button"
        onClick={onClick}
        role="menuitem"
        className={
          "w-full text-left px-2.5 py-1.5 rounded-md text-sm transition-colors " +
          colors
        }
      >
        {children}
      </button>
    </div>
  );
}
