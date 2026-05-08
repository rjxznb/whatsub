import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useEditor,
  EditorContent,
  type Editor,
  type Content,
} from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Highlight } from "@tiptap/extension-highlight";
import { Color } from "@tiptap/extension-color";
import { TextStyle } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Placeholder } from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Highlighter,
  Type,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Link2,
  Heading,
  ChevronDown,
  Trash2,
  Check,
  X,
} from "lucide-react";

/**
 * Note editor for vocab cards. Spawned by Vocab.tsx when the user double-
 * clicks a card. Renders via React portal so the bubble can overflow the
 * card boundary (and the page's flex/grid container).
 *
 * Lifecycle:
 *   1. Mount with `mode='peek'` (60% opacity, blinking cursor, toolbar
 *      hidden) — this is the "preview before commitment" state the user
 *      asked for.
 *   2. User clicks anywhere inside the bubble → `mode='edit'` (full
 *      opacity + toolbar slides in from top).
 *   3. User clicks Done (✓) → `mode='folding'` for ~400ms while we play
 *      the fold-to-corner animation, then onDone() unmounts us and the
 *      parent shows a NoteBadge in the corner.
 *   4. User clicks Cancel (×) → mode='folding' but onDone(null) tells
 *      parent NOT to save changes.
 */

type Mode = "peek" | "edit" | "folding";

// Platform-aware shortcut display. Mac convention is the compact glyph
// form (⌘B, ⌘⇧X) where the modifier symbol implies the join; Win/Linux
// users expect the spelled-out word with a `+` separator (Ctrl+B,
// Ctrl+Shift+X). navigator.platform check stays correct in WebView2 +
// WKWebView; userAgent fallback covers the few platforms where platform
// is empty or generic.
const IS_MAC =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad/i.test(navigator.platform) ||
    /Mac/i.test(navigator.userAgent));
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const SHIFT = IS_MAC ? "⇧" : "Shift+";

interface Props {
  /** TipTap JSON document serialized as a string. Empty string for new notes. */
  initialNote: string;
  /** Pixel position + size of the source card so the bubble can anchor to
   *  it (and fold back into its top-right corner). Window-coordinate. */
  cardRect: { left: number; top: number; width: number; height: number };
  /** Save callback. `note=null` means user clicked the Trash icon = delete.
   *  Empty string means user clicked Done with empty content (treated same
   *  as null on the Rust side). */
  onDone: (note: string | null) => void;
  /** Cancel callback (× button). Doesn't save. */
  onCancel: () => void;
}

export function NoteBubble({ initialNote, cardRect, onDone, onCancel }: Props) {
  const [mode, setMode] = useState<Mode>("peek");
  const [pendingFold, setPendingFold] = useState<{
    save: boolean;
    deleted?: boolean;
  } | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // StarterKit defaults — keep heading levels conservative for short
        // notes. We disable codeBlock (multi-line) since these notes are
        // tiny; inline code (code mark) stays available via toolbar.
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
      }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: "note-link" },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        // The "click anywhere on the bubble to start editing" hint lives
        // in the peek-mode banner below. Keep the placeholder minimal so
        // it doesn't claim a different (and wrong — single click is
        // enough, not double) interaction model.
        placeholder: "写点什么...",
      }),
    ],
    content: parseInitialNote(initialNote),
    editorProps: {
      attributes: {
        // min-h-[200px] gives the user noticeable initial canvas to work
        // with; max-h-[50vh] caps growth so the bubble doesn't push past
        // the screen on long notes (the editor scrolls inside instead).
        class:
          "prose-note focus:outline-none min-h-[200px] max-h-[50vh] overflow-y-auto px-3 py-2",
      },
    },
    immediatelyRender: false,
  });

  // Auto-focus the editor as soon as it mounts so the cursor blinks
  // inside the peek-state bubble (matches the user's "光标闪烁" spec).
  useEffect(() => {
    if (editor && mode !== "folding") {
      editor.commands.focus("end");
    }
  }, [editor, mode]);

  // When user clicks anywhere in the bubble while in peek mode → enter edit.
  // We can't just rely on click on the editor itself because the user might
  // click on the bubble background outside the editable area.
  function handleBubbleClick() {
    if (mode === "peek") {
      setMode("edit");
    }
  }

  // After the fold animation finishes (`pendingFold` was set), notify
  // parent which then unmounts us. We use a single state machine + a
  // timeout instead of CSS animationend because the timing is tight
  // and AnimationEvent doesn't fire reliably across all transforms.
  useEffect(() => {
    if (!pendingFold) return;
    const t = setTimeout(() => {
      if (pendingFold.deleted) {
        onDone(null);
      } else if (pendingFold.save) {
        const json = editor?.getJSON();
        const isEmpty = isDocumentEmpty(json);
        onDone(isEmpty ? null : JSON.stringify(json));
      } else {
        onCancel();
      }
    }, 380);
    return () => clearTimeout(t);
  }, [pendingFold, editor, onDone, onCancel]);

  // Esc to cancel, Cmd/Ctrl+Enter to save — UX hooks people expect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode === "folding") return;
      if (e.key === "Escape") {
        e.preventDefault();
        setMode("folding");
        setPendingFold({ save: false });
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        setMode("folding");
        setPendingFold({ save: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  // ── Bubble geometry ──────────────────────────────────────────────────
  // Anchor: centered on the card horizontally, slightly above it.
  // We position via `left/top` (window coords) so the portal works.
  // The fold target is the card's top-right corner.
  //
  // Width is responsive with a 560px cap. The toolbar's natural width
  // (heading dropdown + 4 format btns + 3 highlight btns + 5 list/link
  // btns + ml-auto + 3 action btns + dividers + paddings) is ~470px;
  // 560 gives the editor comfortable side margins on top of that. On
  // viewports narrower than 592px we fall back to (viewport - 32) and
  // the toolbar's flex-wrap kicks in so nothing gets clipped.
  const bubbleW = Math.min(560, window.innerWidth - 32);
  // Clamp the horizontal anchor so the wider bubble can't drift off the
  // viewport edge on cards that sit near the screen's left/right.
  const idealAnchorX = cardRect.left + cardRect.width / 2 - bubbleW / 2;
  const bubbleAnchorX = Math.max(
    16,
    Math.min(idealAnchorX, window.innerWidth - bubbleW - 16),
  );
  // Try to place above the card; if no room (top < 16), place below.
  const placeAbove = cardRect.top > 320;
  const bubbleAnchorY = placeAbove
    ? cardRect.top - 16
    : cardRect.top + cardRect.height + 16;

  // Fold target: the card's top-right corner, where the badge will appear.
  const foldX = cardRect.left + cardRect.width - 24 - bubbleAnchorX - bubbleW;
  const foldY = cardRect.top - bubbleAnchorY;

  const containerStyle: React.CSSProperties = {
    position: "fixed",
    left: bubbleAnchorX,
    top: bubbleAnchorY,
    width: bubbleW,
    transform: placeAbove ? "translateY(-100%)" : "none",
    zIndex: 200,
  };

  const bubbleStyle: React.CSSProperties =
    mode === "folding"
      ? {
          opacity: 0,
          transform: `translate(${foldX}px, ${foldY}px) scale(0.08)`,
          transition:
            "opacity 280ms ease-out, transform 380ms cubic-bezier(0.55, 0, 0.55, 0.2)",
          transformOrigin: "top right",
          pointerEvents: "none",
        }
      : mode === "edit"
        ? {
            opacity: 1,
            transform: "scale(1)",
            transition: "opacity 200ms ease-out, transform 200ms ease-out",
          }
        : {
            // peek: semi-transparent + slightly smaller, with a gentle
            // breathing animation hinting "click me to start editing"
            opacity: 0.55,
            transform: "scale(0.96)",
            transition: "opacity 200ms ease-out, transform 200ms ease-out",
          };

  return createPortal(
    <>
      {/* Backdrop — covers both peek + edit modes so any outside click
          dismisses the bubble. The save-vs-cancel decision is mode-
          dependent: peek = nothing typed yet, just dismiss; edit = treat
          like a Done click and persist. */}
      {mode !== "folding" && (
        <div
          className="fixed inset-0 z-[150]"
          onClick={() => {
            setMode("folding");
            setPendingFold({ save: mode === "edit" });
          }}
        />
      )}

      <div ref={bubbleRef} style={containerStyle}>
        <div
          onClick={handleBubbleClick}
          // data-bubble: lets the heading dropdown walk the DOM up to
          // find this rect for positioning the carpet popup above the
          // bubble. Decouples HeadingDropdown from needing a ref prop
          // threaded through Toolbar.
          data-bubble="true"
          className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden"
          style={bubbleStyle}
        >
          {/* Toolbar — only visible in edit mode, slides down from top. */}
          {mode === "edit" && editor && (
            <Toolbar
              editor={editor}
              onDone={() => {
                setMode("folding");
                setPendingFold({ save: true });
              }}
              onCancel={() => {
                setMode("folding");
                setPendingFold({ save: false });
              }}
              onDelete={() => {
                setMode("folding");
                setPendingFold({ save: false, deleted: true });
              }}
            />
          )}

          <EditorContent editor={editor} />

          {/* Tiny hint text in peek mode telling the user to click. */}
          {mode === "peek" && (
            <div className="text-[11px] text-zinc-500 italic px-3 py-1.5 border-t border-zinc-800">
              点击此气泡开始编辑笔记，{MOD}Enter 保存，Esc 取消
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── Toolbar ────────────────────────────────────────────────────────────

interface ToolbarProps {
  editor: Editor;
  onDone: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

function Toolbar({ editor, onDone, onCancel, onDelete }: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-zinc-800 bg-zinc-950 animate-slide-down">
      {/* Heading dropdown — combines H1/H2/H3 + paragraph into one menu
          to free up toolbar space and group related options. */}
      <HeadingDropdown editor={editor} />
      <Divider />
      <ToolBtn
        icon={<Bold className="w-3.5 h-3.5" />}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title={`粗体 (${MOD}B)`}
      />
      <ToolBtn
        icon={<Italic className="w-3.5 h-3.5" />}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title={`斜体 (${MOD}I)`}
      />
      <ToolBtn
        icon={<UnderlineIcon className="w-3.5 h-3.5" />}
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title={`下划线 (${MOD}U)`}
      />
      <ToolBtn
        icon={<Strikethrough className="w-3.5 h-3.5" />}
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title={`删除线 (${MOD}${SHIFT}X)`}
      />
      <Divider />
      <ToolBtn
        icon={<Highlighter className="w-3.5 h-3.5" />}
        active={editor.isActive("highlight", { color: "#fde68a" })}
        onClick={() =>
          editor.chain().focus().toggleHighlight({ color: "#fde68a" }).run()
        }
        title="黄色高亮"
      />
      <ColorBtn
        editor={editor}
        color="#ef4444"
        title="红色文字（重点标记）"
      />
      <ColorBtn
        editor={editor}
        color="#3b82f6"
        title="蓝色文字"
      />
      <Divider />
      <ToolBtn
        icon={<List className="w-3.5 h-3.5" />}
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="无序列表"
      />
      <ToolBtn
        icon={<ListOrdered className="w-3.5 h-3.5" />}
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="有序列表"
      />
      <ToolBtn
        icon={<ListTodo className="w-3.5 h-3.5" />}
        active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        title="任务列表（带勾选框）"
      />
      <ToolBtn
        icon={<Quote className="w-3.5 h-3.5" />}
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="引用块"
      />
      <ToolBtn
        icon={<Link2 className="w-3.5 h-3.5" />}
        active={editor.isActive("link")}
        onClick={() => insertOrEditLink(editor)}
        title="插入 / 编辑链接"
      />

      <div className="ml-auto flex items-center gap-1">
        <ActionBtn
          icon={<Trash2 className="w-3.5 h-3.5" />}
          onClick={onDelete}
          title="删除整条笔记"
          className="text-rose-400 hover:bg-rose-500/15"
        />
        <ActionBtn
          icon={<X className="w-3.5 h-3.5" />}
          onClick={onCancel}
          title="取消（不保存，Esc）"
          className="text-zinc-400 hover:bg-zinc-800"
        />
        <ActionBtn
          icon={<Check className="w-3.5 h-3.5" />}
          onClick={onDone}
          title={`保存并关闭 (${MOD}Enter)`}
          className="text-emerald-400 hover:bg-emerald-500/15"
        />
      </div>

      <style>{`
        @keyframes slideDown {
          from { transform: translateY(-100%); opacity: 0; }
          to   { transform: translateY(0); opacity: 1; }
        }
        .animate-slide-down { animation: slideDown 200ms ease-out forwards; }
      `}</style>
    </div>
  );
}

/** Heading-level "carpet" popup. The trigger sits in the toolbar; clicking
 *  it unrolls a horizontal pill ABOVE the bubble (rendered via portal so
 *  the bubble's overflow:hidden doesn't clip it). The pill expands left→
 *  right via clip-path animation — like rolling out a red carpet — and
 *  its 4 chips become visible in sequence as the clip retracts past them.
 *
 *  Why portal instead of inline absolute: the bubble has overflow:hidden
 *  for its rounded corners, which would clip any popup that extends past
 *  the bubble's bounds. Rendering at document.body level sidesteps that
 *  constraint.
 *
 *  Why above the bubble (vs the original below-the-toolbar dropdown):
 *  the dropdown overlapped the editor content underneath, and clicking
 *  options had no visible effect because clicks landed on the editor's
 *  ProseMirror DOM (which intercepts and then re-issues focus events,
 *  collapsing the trigger's selection in a way that made toggleHeading
 *  appear to do nothing). Above-the-bubble + portal eliminates both. */
function HeadingDropdown({ editor }: { editor: Editor }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const [clickKey, setClickKey] = useState(0);

  const currentLevel = ([1, 2, 3] as const).find((l) =>
    editor.isActive("heading", { level: l }),
  );

  /** Walk up from the trigger to the bubble container (tagged with
   *  data-bubble="true"). Returns its rect so we can anchor the popup
   *  to the bubble's top edge + left edge for a clean banner look. */
  function findBubbleRect(): DOMRect | null {
    let el: HTMLElement | null = triggerRef.current;
    while (el) {
      if (el.dataset.bubble === "true") return el.getBoundingClientRect();
      el = el.parentElement;
    }
    return null;
  }

  function toggleOpen() {
    setClickKey((k) => k + 1);
    if (open) {
      setOpen(false);
      return;
    }
    const bubbleRect = findBubbleRect();
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (!triggerRect) return;
    const anchorTop = bubbleRect ? bubbleRect.top : triggerRect.top;
    const anchorLeft = bubbleRect ? bubbleRect.left : triggerRect.left;
    setPos({
      left: anchorLeft,
      // CSS `bottom` is measured from the viewport's bottom edge.
      // 4px gap so the carpet sits almost flush against the bubble's
      // top edge — visually reads as a single attached unit rather
      // than two floating pieces.
      bottom: window.innerHeight - anchorTop + 4,
    });
    setOpen(true);
  }

  // Outside-click handler. Must check both trigger AND popup since the
  // popup is in a portal (separate DOM subtree) — a single ref check
  // wouldn't cover both.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popupRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  function setLevel(level: 1 | 2 | 3 | null) {
    if (level === null) {
      editor.chain().focus().setParagraph().run();
    } else {
      editor.chain().focus().toggleHeading({ level }).run();
    }
    setOpen(false);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleOpen}
        title="标题级别（正文 / H1 / H2 / H3）"
        className={
          "p-1 rounded flex items-center gap-0.5 hover:bg-zinc-800 transition-colors " +
          (currentLevel ? "bg-blue-500/20 text-blue-300" : "text-zinc-400 hover:text-zinc-100")
        }
      >
        <span
          key={clickKey}
          className={
            "inline-flex items-center gap-0.5 " +
            (clickKey > 0 ? "animate-toolbar-pop" : "")
          }
        >
          <Heading className="w-3.5 h-3.5" />
          {currentLevel && (
            <span className="text-[10px] font-bold leading-none">
              {currentLevel}
            </span>
          )}
          <ChevronDown
            className={
              "w-2.5 h-2.5 transition-transform " + (open ? "rotate-180" : "")
            }
          />
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popupRef}
            className="fixed z-[210] flex items-stretch gap-1 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl animate-carpet-unroll"
            style={{ left: pos.left, bottom: pos.bottom }}
          >
            <HeadingChip
              label="正文"
              sample="正文"
              sampleClass="text-sm"
              active={!currentLevel}
              onClick={() => setLevel(null)}
            />
            <HeadingChip
              label="标题 1"
              sample="H1"
              sampleClass="text-lg font-bold"
              active={currentLevel === 1}
              onClick={() => setLevel(1)}
            />
            <HeadingChip
              label="标题 2"
              sample="H2"
              sampleClass="text-base font-bold"
              active={currentLevel === 2}
              onClick={() => setLevel(2)}
            />
            <HeadingChip
              label="标题 3"
              sample="H3"
              sampleClass="text-sm font-semibold"
              active={currentLevel === 3}
              onClick={() => setLevel(3)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/** One chip in the heading carpet. Stacks a sample (H1/H2/H3/正文) over
 *  a small label so users see both the visual style preview AND its
 *  name at a glance — matches the original dropdown's two-column layout
 *  but in vertical stack form for the horizontal chip. */
function HeadingChip({
  label,
  sample,
  sampleClass,
  active,
  onClick,
}: {
  label: string;
  sample: string;
  sampleClass?: string;
  active: boolean;
  onClick: () => void;
}) {
  const [clickKey, setClickKey] = useState(0);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setClickKey((k) => k + 1);
        onClick();
      }}
      title={label}
      className={
        "px-3 py-1 rounded text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 transition-colors flex flex-col items-center justify-center gap-0.5 min-w-[56px] " +
        (active ? "!bg-blue-500/20 !text-blue-300" : "")
      }
    >
      <span
        key={clickKey}
        className={
          "inline-flex flex-col items-center gap-0.5 " +
          (clickKey > 0 ? "animate-toolbar-pop" : "")
        }
      >
        <span className={"leading-none " + (sampleClass ?? "")}>{sample}</span>
        <span className="text-[10px] text-zinc-500 leading-none">{label}</span>
      </span>
    </button>
  );
}

function ToolBtn({
  icon,
  active,
  onClick,
  title,
}: {
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  // Click counter drives a `key` re-mount of the icon-wrapping span on
  // every click so the `animate-toolbar-pop` keyframe replays. Without
  // this, repeated clicks of the same button (e.g. toggling bold on/off)
  // wouldn't show any visible feedback when the button's `active` state
  // is the only thing that changes — and in some cases (toggling a mark
  // with no text selected) even that doesn't change.
  const [clickKey, setClickKey] = useState(0);
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // Don't blur the editor when clicking a toolbar button.
        e.preventDefault();
      }}
      onClick={() => {
        setClickKey((k) => k + 1);
        onClick();
      }}
      title={title}
      className={
        "p-1 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors " +
        (active ? "!bg-blue-500/20 !text-blue-300" : "")
      }
    >
      <span
        key={clickKey}
        className={clickKey > 0 ? "animate-toolbar-pop" : "inline-flex"}
      >
        {icon}
      </span>
    </button>
  );
}

function ColorBtn({
  editor,
  color,
  title,
}: {
  editor: Editor;
  color: string;
  title: string;
}) {
  const active = editor.isActive("textStyle", { color });
  const [clickKey, setClickKey] = useState(0);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setClickKey((k) => k + 1);
        if (active) {
          editor.chain().focus().unsetColor().run();
        } else {
          editor.chain().focus().setColor(color).run();
        }
      }}
      title={title}
      className={
        "p-1 rounded hover:bg-zinc-800 transition-colors " +
        (active ? "!bg-blue-500/20" : "")
      }
    >
      <span
        key={clickKey}
        className={clickKey > 0 ? "animate-toolbar-pop" : "inline-flex"}
      >
        <Type className="w-3.5 h-3.5" style={{ color }} />
      </span>
    </button>
  );
}

/** Small action button used for Trash / Cancel / Done at the right end
 *  of the toolbar. Same click-pop pattern as ToolBtn, but no `active`
 *  state — these are momentary actions, not toggles. */
function ActionBtn({
  icon,
  onClick,
  title,
  className,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  title: string;
  className: string;
}) {
  const [clickKey, setClickKey] = useState(0);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        setClickKey((k) => k + 1);
        onClick();
      }}
      title={title}
      className={"p-1 rounded transition-colors " + className}
    >
      <span
        key={clickKey}
        className={clickKey > 0 ? "animate-toolbar-pop" : "inline-flex"}
      >
        {icon}
      </span>
    </button>
  );
}

function Divider() {
  return <div className="w-px h-4 bg-zinc-800 mx-0.5" />;
}

function insertOrEditLink(editor: Editor) {
  const previousUrl = editor.getAttributes("link").href as string | undefined;
  // Use a simple prompt — TipTap doesn't ship a link UI by default. For our
  // scope (vocab notes) a prompt is fine; full inline UI would be over-
  // engineering.
  const url = window.prompt("链接 URL", previousUrl ?? "https://");
  if (url === null) return;
  if (url === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Parse a stored note string into a TipTap doc. Empty → undefined so
 *  the placeholder + cursor render correctly (Tiptap accepts undefined
 *  as "no initial content"). */
function parseInitialNote(s: string): Content {
  if (!s || !s.trim()) return undefined as unknown as Content;
  try {
    return JSON.parse(s) as Content;
  } catch {
    // Old stored notes might be HTML rather than JSON (if the user ever
    // had a contentEditable version). Fall back to plain text content.
    return {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: s }] }],
    } as Content;
  }
}

/** True if the document has no meaningful content (just empty paragraphs). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isDocumentEmpty(doc: any): boolean {
  if (!doc || !Array.isArray(doc.content)) return true;
  if (doc.content.length === 0) return true;
  // Walk to find any actual text node.
  return !hasText(doc);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasText(node: any): boolean {
  if (!node) return false;
  if (node.type === "text" && typeof node.text === "string" && node.text.length > 0) {
    return true;
  }
  if (Array.isArray(node.content)) {
    return node.content.some(hasText);
  }
  return false;
}
