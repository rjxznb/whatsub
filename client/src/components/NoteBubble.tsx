import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useEditor,
  EditorContent,
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
// Footer-only icons. The full TipTap toolbar (and its 14 icon imports)
// was removed when the bubble shrank to a sticky-note size — keyboard
// shortcuts (⌘B / ⌘I / etc) still work via StarterKit, and the format
// surface will move to the system menu bar on macOS.
import { Trash2, Check } from "lucide-react";

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

// ── User-tunable layout / opacity knobs ─────────────────────────────────
// Edit these to adjust the peek-mode look without touching the geometry
// math below. PEEK_OPACITY controls how transparent the bubble is on
// first appearance (before the user clicks to start editing); edit mode
// always paints at full opacity regardless. OVERLAP_X / OVERLAP_Y control
// how far the bubble's top-left corner sits INSIDE the card's bottom-
// right area on a double-click: bigger numbers = more overlap.
//
// Common tweaks:
//   - Want the peek bubble more visible? Bump PEEK_OPACITY toward 1.0.
//   - Want the bubble fully off the card (no overlap)? Set both
//     OVERLAP_* to 0 or even negative (negative pushes it FURTHER away).
//   - Want it overlapping more? Increase the OVERLAP_* values.
const PEEK_OPACITY = 0.7;
const OVERLAP_X = 80; // bubble's left edge sits this many px inside card's right edge
const OVERLAP_Y = 40; // bubble's top edge sits this many px inside card's bottom edge

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
  // `entering` is the inbound mirror of folding. On mount the bubble is
  // painted at the same shrunken-into-corner position as the close
  // animation's end state; after two RAFs we flip the flag and CSS
  // transitions the bubble out to its natural peek-mode resting size.
  // Result: the bubble looks like it's pulled OUT of the card's blue
  // corner bracket, then sucked back in when the user finishes — Genie-
  // style minimize/restore.
  const [entering, setEntering] = useState(true);
  const bubbleRef = useRef<HTMLDivElement>(null);

  // Two RAFs so the browser definitely paints the entering-state styles
  // before we trigger the transition to peek. Single RAF can race in
  // some browsers (Chromium especially under heavy load) — paint may
  // not complete inside one rAF window, and then the transition
  // attaches with both endpoints already at the final state, snapping
  // visibly. Two rAFs guarantees a paint between mount and toggle.
  useEffect(() => {
    let id1 = 0;
    let id2 = 0;
    id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => setEntering(false));
    });
    return () => {
      cancelAnimationFrame(id1);
      cancelAnimationFrame(id2);
    };
  }, []);

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
        // Editor fills whatever vertical space the resizable container
        // gives it (handled by the flex layout in the bubble shell).
        // h-full keeps the cursor reachable to the bottom edge so a
        // user double-clicking on an empty line at the bottom of the
        // bubble can land focus there rather than only the top.
        class:
          "prose-note focus:outline-none h-full px-3 py-2",
      },
    },
    // onUpdate fires whenever the doc actually changes (typed character,
    // paste, formatting toggle — but not arrow keys or selection). We
    // use it as the implicit "user committed to editing" signal so a
    // user who just starts typing in the half-transparent peek bubble
    // gets promoted to the fully-opaque edit state without having to
    // click first. setMode is idempotent against non-peek states so
    // subsequent keystrokes don't churn this.
    onUpdate: () => {
      setMode((m) => (m === "peek" ? "edit" : m));
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
  // Anchor: bottom-right of the source card, with the bubble's top-left
  // corner sitting INSIDE the card by (OVERLAP_X, OVERLAP_Y) — produces
  // the "card → expands diagonally into a note" feel from the user's
  // sketch. The bubble extends down + right past the card. To tune the
  // overlap amount edit OVERLAP_X / OVERLAP_Y at the top of this file.
  //
  // Default shape is a small square sticky-note (~280×260px). The
  // browser's `resize: both` handle (bottom-right corner) lets the user
  // drag the bubble bigger when they need more room. Min/max bounds
  // keep the bubble usable: too small loses the editor; too big runs
  // off-screen.
  const DEFAULT_W = 280;
  const DEFAULT_H = 260;
  const MIN_W = 220;
  const MIN_H = 180;
  const bubbleW = Math.min(DEFAULT_W, window.innerWidth - 32);
  const bubbleH = DEFAULT_H;
  const maxW = Math.max(MIN_W, window.innerWidth - 32);
  const maxH = Math.max(MIN_H, window.innerHeight - 80);

  // Horizontal: bubble's left edge sits OVERLAP_X px inside the card's
  // right edge. Clamp to keep the wide bubble inside the viewport when
  // the card is near the screen's right edge.
  const idealAnchorX = cardRect.left + cardRect.width - OVERLAP_X;
  const bubbleAnchorX = Math.max(
    16,
    Math.min(idealAnchorX, window.innerWidth - bubbleW - 16),
  );

  // Vertical: default below-and-overlapping (top edge sits OVERLAP_Y px
  // inside the card's bottom edge). If there's not enough room below
  // (card near viewport bottom), flip so the bubble sits ABOVE with
  // mirrored overlap on the card's top edge — same "diagonal expansion"
  // shape, just reflected. ESTIMATED_BUBBLE_H is a heuristic since the
  // bubble's actual height isn't known until after layout.
  const ESTIMATED_BUBBLE_H = 280;
  const placeBelow =
    cardRect.top + cardRect.height + ESTIMATED_BUBBLE_H - OVERLAP_Y <
    window.innerHeight - 16;
  const bubbleAnchorY = placeBelow
    ? cardRect.top + cardRect.height - OVERLAP_Y
    : cardRect.top + OVERLAP_Y;
  // When flipped above, translateY(-100%) pulls the bubble up by its own
  // height so the "anchor" line ends up being the bubble's BOTTOM edge.
  const transformY = placeBelow ? "none" : "translateY(-100%)";

  // Fold target: the card's top-right corner, where the blue door-frame
  // bracket sits. With transform-origin "top right" + scale 0.08, the
  // bubble shrinks to a tiny blob centered on its own top-right point;
  // we translate that point to the bracket's CENTER so the suction
  // visually terminates inside the L-shape rather than next to it.
  // Bracket geometry: positioned at right:-1, top:-1 with rest size 22,
  // so center is ~(cardRect.right - 12, cardRect.top + 10). These two
  // numbers are the only coupling between this file and NoteBadge.tsx —
  // change them in lockstep if NoteBadge's geometry constants change.
  const BRACKET_CENTER_X_OFFSET = 12;
  const BRACKET_CENTER_Y_OFFSET = 10;
  const foldX =
    cardRect.left + cardRect.width - BRACKET_CENTER_X_OFFSET - bubbleAnchorX - bubbleW;
  const foldY = cardRect.top + BRACKET_CENTER_Y_OFFSET - bubbleAnchorY;

  // Container is the user-resizable shell (sticky-note feel: starts
  // small, draggable larger). `resize: both` puts the standard browser
  // resize handle at the bottom-right corner; `overflow: hidden` is
  // required for the handle to render. The animated bubble sits inside
  // and scales to fill 100% of whatever size the container becomes,
  // so resize works at any animation state.
  const containerStyle: React.CSSProperties = {
    position: "fixed",
    left: bubbleAnchorX,
    top: bubbleAnchorY,
    width: bubbleW,
    height: bubbleH,
    minWidth: MIN_W,
    minHeight: MIN_H,
    maxWidth: maxW,
    maxHeight: maxH,
    resize: "both",
    overflow: "hidden",
    transform: transformY,
    zIndex: 200,
  };

  // Genie minimize/restore animation. Both directions share the same
  // (foldX, foldY) shrink target — the card's top-right corner where
  // the blue door-frame indicator sits — so closing looks like the
  // bubble is being sucked into the corner, and opening is the exact
  // reverse (bubble pulled out of the corner, expanding to full size).
  //
  // Easing: close uses a strong ease-IN (slow start, fast end) so the
  // last frames of the shrink accelerate, mimicking the "vacuum pull"
  // of macOS's Genie. Open uses the inverse — strong ease-OUT — so the
  // bubble springs decisively out of the corner then settles.
  // transformOrigin stays "top right" across all states so the scale
  // anchors at the same corner point in every transition (no jump).
  const GENIE_DURATION = 480;
  const FOLD_TRANSFORM = `translate(${foldX}px, ${foldY}px) scale(0.08)`;
  const bubbleStyle: React.CSSProperties =
    mode === "folding"
      ? {
          opacity: 0,
          transform: FOLD_TRANSFORM,
          transition:
            `opacity 320ms cubic-bezier(0.32, 0, 0.67, 0), ` +
            `transform ${GENIE_DURATION}ms cubic-bezier(0.32, 0, 0.67, 0)`,
          transformOrigin: "top right",
          pointerEvents: "none",
        }
      : entering
        ? {
            // Initial paint frame: bubble is positioned AT the corner
            // bracket, scaled to a dot, fully transparent. transition is
            // None so this state snaps in with no animation; after two
            // RAFs we flip `entering` to false and the transitions on
            // peek/edit below take over to tween out of this state.
            opacity: 0,
            transform: FOLD_TRANSFORM,
            transformOrigin: "top right",
            transition: "none",
            pointerEvents: "none",
          }
        : mode === "edit"
          ? {
              opacity: 1,
              transform: "scale(1)",
              transformOrigin: "top right",
              transition:
                `opacity 280ms ease-out, ` +
                `transform ${GENIE_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            }
          : {
              // peek: semi-transparent, hinting "click me to start
              // editing". Adjust transparency by editing PEEK_OPACITY
              // at the top of this file (currently 0.55).
              opacity: PEEK_OPACITY,
              transform: "scale(1)",
              transformOrigin: "top right",
              transition:
                `opacity 280ms ease-out, ` +
                `transform ${GENIE_DURATION}ms cubic-bezier(0.16, 1, 0.3, 1)`,
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

      <div ref={bubbleRef} className="note-bubble-shell" style={containerStyle}>
        <div
          onClick={handleBubbleClick}
          // data-bubble: walked-up DOM target used by HeadingDropdown
          // (kept for future re-introduction). Currently only used as
          // a stable ref point.
          data-bubble="true"
          // Open + close animations are driven by the React-state
          // transition in `bubbleStyle` (Genie-style suck into / pop out
          // of the card's blue corner bracket). The inner div fills its
          // resizable parent so dragging the parent's bottom-right
          // resize handle reflows the editor + footer naturally.
          className="bg-zinc-900 border border-zinc-700 rounded-lg shadow-2xl overflow-hidden w-full h-full flex flex-col"
          style={bubbleStyle}
        >
          {/* Editor body. flex-1 + min-h-0 lets it claim all space the
              container can spare while still scrolling internally on
              long content. The inline TipTap toolbar is intentionally
              gone — keyboard shortcuts (⌘B / ⌘I / etc) still work
              because StarterKit binds them, and we'll wire up format
              actions to a Mac menu bar separately. */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <EditorContent editor={editor} />
          </div>

          {/* Footer: tiny action strip with Trash + Save. Cancel is
              implicit (Esc / click backdrop), kept off the strip so
              the layout stays balanced and the sticky-note feels
              uncluttered. Only shown in edit mode — peek mode gets the
              hint banner instead. */}
          {mode === "edit" && (
            <div className="flex items-center justify-end gap-1 px-2 py-1 border-t border-zinc-800 bg-zinc-950/60">
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setMode("folding");
                  setPendingFold({ save: false, deleted: true });
                }}
                title="删除整条笔记"
                className="flex h-6 w-6 items-center justify-center rounded text-rose-400 hover:bg-rose-500/15 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setMode("folding");
                  setPendingFold({ save: true });
                }}
                title={`保存并关闭 (${MOD}Enter)`}
                className="flex h-6 w-6 items-center justify-center rounded text-emerald-400 hover:bg-emerald-500/15 transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Tiny hint text in peek mode telling the user to click or
              just start typing. */}
          {mode === "peek" && (
            <div className="text-[11px] text-zinc-500 italic px-3 py-1.5 border-t border-zinc-800">
              点击气泡或直接输入开始编辑，{MOD}Enter 保存，Esc 取消
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
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
