import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Star,
  Loader2,
  AlertCircle,
  X,
  Save,
  Check,
} from "lucide-react";
import type { Subtitle } from "../llm/types";
import { useVocabulary } from "../store/vocab";
import { makeVocabId } from "../types/vocab";
import { useSettings } from "../store/settings";
import type { Settings } from "../types/settings";
import { normalizeExpression } from "../utils/normalizeExpression";
import { lookupExpression } from "../llm/lookupExpression";
import { getProvider } from "../llm/providers";
import { friendlyError } from "../utils/friendlyError";
import { loadDraft, saveDraft, clearDraft, type VocabDraft } from "../store/vocabDraft";

const BUBBLE_WIDTH = 400;

interface SelectionInfo {
  expression: string;
  cueIdx: number;
  cueText: string;
  cueTime: number;
  rect: DOMRect;
}

interface Props {
  /** The list container the bubble watches for selection events. */
  listRef: React.RefObject<HTMLDivElement | null>;
  subtitles: Subtitle[];
  videoId: string;
  videoTitle: string;
  /** Disable the bubble entirely (e.g. in subtitle edit mode). */
  disabled: boolean;
  /** Fires whenever the bubble opens or closes. SubtitleList uses this
   *  to suspend its auto-scroll while a selection is being annotated:
   *  open → freeze the scroll indefinitely; close → reset the standard
   *  2 s wheel/touch grace timer so the user has a beat to keep
   *  reading the cue they just edited before auto-scroll resumes. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Floating bubble that appears above any text the user drag-selects inside
 * the subtitle list. Lets them ⭐ directly save with empty meaning, or click
 * 🔍 to fetch a Chinese gloss + usage from the LLM (added in Task 8).
 */
type LookupState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string };

export function SubtitleSelectionBubble({
  listRef,
  subtitles,
  videoId,
  videoTitle,
  disabled,
  onOpenChange,
}: Props) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const [meaningZh, setMeaningZh] = useState("");
  const [usage, setUsage] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  const [suggestion, setSuggestion] = useState<{
    meaningZh: string;
    usage: string;
  } | null>(null);
  const [mounted, setMounted] = useState(false);
  // Visual ack after the user clicks the explicit save button — Save
  // icon flips into a green Check and STAYS that way until the user
  // edits the inputs again (or selects a different word). That way
  // the user has a persistent "yes it's saved" indicator while
  // browsing, and as soon as they make a change the icon reverts to
  // Save to signal "you have unsaved edits". `lastSavedValuesRef`
  // snapshots the meaningZh/usage at save time; the watcher effect
  // flips the flash off the moment those values diverge.
  const [savedFlash, setSavedFlash] = useState(false);
  const lastSavedValuesRef = useRef<{ meaningZh: string; usage: string } | null>(null);
  const lookupAbortRef = useRef<AbortController | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const { entries, has, toggle, add } = useVocabulary();
  const { settings } = useSettings();

  // Notify the parent (SubtitleList) whenever the bubble's open state
  // flips, so it can pause/resume auto-scroll. We fire on every change
  // so close → bumpInteraction() runs even when the same expression is
  // re-selected within the same render commit. The check that wraps
  // the call avoids a no-op fire on the first render where info is
  // null and onOpenChange's previous value was also null/undefined.
  useEffect(() => {
    onOpenChange?.(info !== null);
  }, [info, onOpenChange]);

  // On selection change: restore from vocab (top priority), then draft, else collapsed default.
  useEffect(() => {
    if (!info) return;
    setLookup({ kind: "idle" });
    setSuggestion(null);
    lookupAbortRef.current?.abort();

    const id = makeVocabId(info.expression);
    const existing = entries.find((e) => e.id === id);
    if (existing) {
      // Already-saved: pre-fill from vocab; debounce-upsert active.
      setMeaningZh(existing.meaningZh);
      setUsage(existing.usage);
      return;
    }
    const draft = loadDraft(info.expression);
    if (draft) {
      setMeaningZh(draft.meaningZh);
      setUsage(draft.usage);
      return;
    }
    // Fresh, no draft, no vocab — empty inputs.
    setMeaningZh("");
    setUsage("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.expression]);

  // Detect selection. Mouseup events that originate INSIDE the bubble
  // (e.g., clicking a textarea or button) bubble up to listRef and would
  // otherwise re-read the document selection — which by then has been
  // cleared by the textarea taking focus, returning null and closing
  // the bubble. Skip those.
  useEffect(() => {
    if (disabled) return;
    const list = listRef.current;
    if (!list) return;
    const onMouseUp = (e: MouseEvent) => {
      if (bubbleRef.current?.contains(e.target as Node)) return;
      setTimeout(() => setInfo(readSelection(list, subtitles)), 0);
    };
    list.addEventListener("mouseup", onMouseUp);
    return () => list.removeEventListener("mouseup", onMouseUp);
  }, [listRef, subtitles, disabled]);

  const saved = info ? has(info.expression) : false;

  // Debounce-upsert when the user edits inputs while the entry is in vocab.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!info) return;
    if (!saved) return;            // only auto-update entries already in vocab
    if (suggestion) return;        // user is mid-suggestion-decision; don't fire yet

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      add({
        id: makeVocabId(info.expression),
        expression: info.expression,
        meaningZh,
        usage,
        videoId,
        videoTitle,
        cueTime: info.cueTime,
        cueText: info.cueText,
        addedAt:
          entries.find((e) => e.id === makeVocabId(info.expression))
            ?.addedAt ?? new Date().toISOString(),
      }).catch((e) => console.error("debounced vocab upsert failed", e));
    }, 500);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meaningZh, usage, saved, info?.expression, suggestion]);

  // Hide on collapsed selection.
  // Bubble close paths: outside-click (mousedown) + ESC + explicit X button.
  // We deliberately do NOT close on selectionchange-collapsed because clicking
  // ANY focusable element inside the bubble (textareas, buttons, the AI 重新查
  // ...) collapses the document-level selection on the cue text, racing focus
  // changes with selectionchange events in browser-specific ways. Every guard
  // we tried (textarea-only / any-focus-in-bubble / deferred activeElement)
  // had false-positive closes for legitimate bubble interactions. Outside-click
  // already handles "user clicked elsewhere"; we don't need a second mechanism.

  // Block wheel + touchmove on the list while bubble is visible — prevents
  // scrolling the selection out from under the bubble.
  useEffect(() => {
    if (!info) return;
    const list = listRef.current;
    if (!list) return;
    const block = (e: Event) => e.preventDefault();
    list.addEventListener("wheel", block, { passive: false });
    list.addEventListener("touchmove", block, { passive: false });
    return () => {
      list.removeEventListener("wheel", block);
      list.removeEventListener("touchmove", block);
    };
  }, [info, listRef]);

  // Outside-click close.
  useEffect(() => {
    if (!info) return;
    const onDown = (e: MouseEvent) => {
      if (!bubbleRef.current) return;
      if (bubbleRef.current.contains(e.target as Node)) return;
      // Click on selection itself — let it stand; selectionchange will close
      // if it collapses.
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        const x = e.clientX, y = e.clientY;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
      }
      closeBubble();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, saved, meaningZh, usage]);

  // ESC closes.
  useEffect(() => {
    if (!info) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeBubble();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, saved, meaningZh, usage]);

  // Fade-in animation: mounted flips on next animation frame.
  useEffect(() => {
    if (!info) {
      setMounted(false);
      return;
    }
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [info?.expression]);

  // Watcher: if savedFlash is on and the user has since changed the
  // inputs (typed, AI lookup populated them, etc.), flip flash off
  // so the icon reverts from green Check to Save — visual cue that
  // there are now unsaved edits. Comparing against
  // lastSavedValuesRef captures the snapshot taken at click-save
  // time, so re-typing the EXACT same characters (rare) doesn't
  // unflash spuriously.
  useEffect(() => {
    if (!savedFlash) return;
    const snap = lastSavedValuesRef.current;
    if (!snap) return;
    if (snap.meaningZh !== meaningZh || snap.usage !== usage) {
      setSavedFlash(false);
    }
  }, [meaningZh, usage, savedFlash]);

  // Reset save state whenever the user selects a different word —
  // the new word starts fresh, no carry-over green check.
  useEffect(() => {
    setSavedFlash(false);
    lastSavedValuesRef.current = null;
  }, [info?.expression]);

  // ── Unmount safety net ──────────────────────────────────────────────
  // closeBubble (× / Esc / outside-click) is the ONLY happy path that
  // persists in-progress edits to disk. If the bubble unmounts via any
  // OTHER path — user navigates back to library, switches videos,
  // closes the app window — those pre-cleanup hooks don't run and the
  // user's draft would be lost.
  //
  // We mirror the latest persist-on-exit closure into a ref every
  // render so the [] -deps cleanup below can call the LATEST version
  // (a closure captured in the [] -deps useEffect itself would freeze
  // at the initial mount values, defeating the point). On unmount we
  // run it once: drafts → localStorage, saved entries → vocab.json
  // flush, empty inputs on an unsaved word → clearDraft so a stale
  // draft doesn't ghost-restore on next selection.
  const persistOnUnmountRef = useRef<() => void>(() => {});
  useEffect(() => {
    persistOnUnmountRef.current = () => {
      if (!info) return;
      if (saved) {
        // Saved entries: flush latest edits to vocab.json. Fire-and-
        // forget — the cleanup chain can't await, and an IO error
        // here mustn't crash the unmount.
        void add({
          id: makeVocabId(info.expression),
          expression: info.expression,
          meaningZh,
          usage,
          videoId,
          videoTitle,
          cueTime: info.cueTime,
          cueText: info.cueText,
          addedAt:
            entries.find((e) => e.id === makeVocabId(info.expression))?.addedAt ??
            new Date().toISOString(),
        }).catch((e) => console.warn("unmount-time vocab flush failed", e));
        return;
      }
      if (meaningZh.trim() || usage.trim()) {
        saveDraft({
          expression: info.expression,
          meaningZh,
          usage,
          cueText: info.cueText,
          cueTime: info.cueTime,
          videoId,
          videoTitle,
          updatedAt: new Date().toISOString(),
        });
      } else {
        // Empty inputs on an unsaved word — wipe any stale draft so
        // it doesn't ghost-restore next time.
        clearDraft(info.expression);
      }
    };
  });
  useEffect(() => {
    return () => persistOnUnmountRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!info) return null;

  const onLookup = async () => {
    lookupAbortRef.current?.abort();
    const ctrl = new AbortController();
    lookupAbortRef.current = ctrl;
    setLookup({ kind: "loading" });
    try {
      const provider = getProvider(settings);
      const result = await lookupExpression(
        info.expression,
        info.cueText,
        provider,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      const userHasContent = meaningZh.trim() || usage.trim();
      if (userHasContent) {
        // Don't overwrite — show suggestion card instead.
        setSuggestion(result);
      } else {
        setMeaningZh(result.meaningZh);
        setUsage(result.usage);
      }
      setLookup({ kind: "idle" });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setLookup({ kind: "error", message: friendlyError(String(e), "analyzing").title });
    }
  };

  // Explicit "save progress" — persists the user's current draft
  // WITHOUT committing the word to the vocab list. Distinct from ⭐
  // (which adds/removes from vocab):
  //   - Unsaved entry: write to localStorage draft store. Subtitle
  //     gets a dashed underline; user can come back later and keep
  //     editing, then ⭐ to commit.
  //   - Already-saved entry: flush the current edits to vocab.json
  //     (immediate version of the 500ms debounce). The entry stays
  //     in vocab; this just makes the latest typed text durable.
  // The button flashes a tick for 1.2s either way as a "yes that
  // landed" cue, since the auto-save / draft-on-close behaviors are
  // both invisible to the user without it.
  const onSaveNow = async () => {
    if (!info) return;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    try {
      if (saved) {
        await add({
          id: makeVocabId(info.expression),
          expression: info.expression,
          meaningZh,
          usage,
          videoId,
          videoTitle,
          cueTime: info.cueTime,
          cueText: info.cueText,
          addedAt:
            entries.find((e) => e.id === makeVocabId(info.expression))?.addedAt ??
            new Date().toISOString(),
        });
      } else {
        // Persist as draft only — don't add to vocab. Stash the same
        // shape closeBubble would write on dismissal so a fresh open
        // restores exactly what the user typed.
        const draft: VocabDraft = {
          expression: info.expression,
          meaningZh,
          usage,
          cueText: info.cueText,
          cueTime: info.cueTime,
          videoId,
          videoTitle,
          updatedAt: new Date().toISOString(),
        };
        saveDraft(draft);
      }
    } catch (e) {
      console.error("explicit save failed", e);
      return;
    }
    lastSavedValuesRef.current = { meaningZh, usage };
    setSavedFlash(true);
  };

  const onStar = async () => {
    lookupAbortRef.current?.abort();
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (saved) {
      // Cancel any pending upsert FIRST so it doesn't race with the remove.
      await toggle({
        expression: info.expression,
        meaningZh,
        usage,
        videoId,
        videoTitle,
        cueTime: info.cueTime,
        cueText: info.cueText,
      });
      // Stay open in expanded state (user might re-edit and re-save).
      return;
    }
    await add({
      id: makeVocabId(info.expression),
      expression: info.expression,
      meaningZh,
      usage,
      videoId,
      videoTitle,
      cueTime: info.cueTime,
      cueText: info.cueText,
      addedAt: new Date().toISOString(),
    });
    clearDraft(info.expression);
    // Stay open after save — ⭐ flips to filled (saved=true derives from
    // useVocabulary().has on next render), inputs remain editable, and any
    // further edits will debounce-upsert. User dismisses via the explicit
    // X close button, ESC, or by clicking outside.
  };

  // Position the bubble so it never overlaps the selected phrase. We
  // prefer "above the selection" — feels like the bubble is anchored
  // to the words it describes — but if the selection is too close to
  // the top of the viewport for the bubble to fit, we drop the bubble
  // BELOW the selection instead. The hardcoded estimate matches the
  // bubble's natural height in the two visible states (with /
  // without the AI-suggestion strip); off-by-a-few-px is fine since
  // the gap below absorbs it.
  const ESTIMATED_HEIGHT = suggestion ? 330 : 200;
  const VIEWPORT_PADDING = 8;
  const SELECTION_GAP = 10;
  const aboveTop = info.rect.top - ESTIMATED_HEIGHT - SELECTION_GAP;
  const belowTop = info.rect.bottom + SELECTION_GAP;
  let top: number;
  if (aboveTop >= VIEWPORT_PADDING) {
    // Room above — preferred placement.
    top = aboveTop;
  } else if (belowTop + ESTIMATED_HEIGHT <= window.innerHeight - VIEWPORT_PADDING) {
    // Not enough room above; drop below the selection. The bubble's
    // top edge is SELECTION_GAP px below the selection bottom so the
    // selected phrase stays visible AND the bubble doesn't crowd it.
    top = belowTop;
  } else {
    // Edge case: viewport too short for the bubble in either slot.
    // Whichever side has more room wins, then clamp into the viewport.
    const roomAbove = info.rect.top - VIEWPORT_PADDING;
    const roomBelow = window.innerHeight - VIEWPORT_PADDING - info.rect.bottom;
    top =
      roomAbove >= roomBelow
        ? Math.max(VIEWPORT_PADDING, info.rect.top - ESTIMATED_HEIGHT - SELECTION_GAP)
        : Math.min(
            window.innerHeight - ESTIMATED_HEIGHT - VIEWPORT_PADDING,
            info.rect.bottom + SELECTION_GAP,
          );
  }
  const left = clampLeft(info.rect.left + info.rect.width / 2 - BUBBLE_WIDTH / 2);

  const llmReady = isProviderReady(settings);

  const closeBubble = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      // For saved entries: flush the latest typed content synchronously so
      // a quick close (within the 500ms debounce window) doesn't lose the edit.
      if (info && saved) {
        add({
          id: makeVocabId(info.expression),
          expression: info.expression,
          meaningZh,
          usage,
          videoId,
          videoTitle,
          cueTime: info.cueTime,
          cueText: info.cueText,
          addedAt:
            entries.find((e) => e.id === makeVocabId(info.expression))
              ?.addedAt ?? new Date().toISOString(),
        }).catch((e) => console.error("flush-on-close vocab upsert failed", e));
      }
    }
    if (info && !saved && (meaningZh.trim() || usage.trim())) {
      const draft: VocabDraft = {
        expression: info.expression,
        meaningZh,
        usage,
        cueText: info.cueText,
        cueTime: info.cueTime,
        videoId,
        videoTitle,
        updatedAt: new Date().toISOString(),
      };
      saveDraft(draft);
    } else if (info && !saved) {
      // User cleared inputs (or never typed) on an unsaved word — wipe any
      // stale draft so it doesn't ghost-restore on next selection.
      clearDraft(info.expression);
    }
    setInfo(null);
  };

  return (
    <div
      ref={bubbleRef}
      style={{ position: "fixed", top, left, width: BUBBLE_WIDTH }}
      className={
        "z-50 flex flex-col rounded-lg border border-zinc-700 bg-zinc-900/95 shadow-xl backdrop-blur " +
        "transition-all duration-150 ease-out " +
        (mounted ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-1 scale-95")
      }
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        {/* Expression + save button as a tight pair (gap-1 = 4px),
            wrapped in their own flex group that takes the remaining
            space. min-w-0 + flex-1 lets the expression text truncate
            without pushing the save button off the row, and the
            save sits flush against the title — eye-flow reads "this
            is the word, save it" as one unit, with AI / ⭐ / × as
            secondary actions on the right. */}
        <div className="flex items-center gap-1 flex-1 min-w-0">
          <span
            className="truncate text-sm text-zinc-100"
            title={info.expression}
          >
            {info.expression}
          </span>
          <button
            type="button"
            onClick={onSaveNow}
            title={
              savedFlash
                ? "已保存 ✓ — 继续编辑会变回保存"
                : saved
                  ? "保存当前修改"
                  : "保存进度（不收藏，下次接着写）"
            }
            className={
              // Compact 5×5 button (vs 7×7 elsewhere) so it sits next
              // to the title text without dominating. Slight scale-up
              // on hover for a friendly bounce; the saved state pops
              // a 1.10× scale once and stays there until the user
              // edits — a subtle "happy" cue that doesn't distract.
              // Saved state has NO background fill so the green check
              // reads as a clean inline glyph next to the word title,
              // not a button-press chip.
              "shrink-0 flex h-5 w-5 items-center justify-center rounded-md transition-all duration-200 " +
              (savedFlash
                ? "text-emerald-400 scale-110"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-emerald-300 hover:scale-110")
            }
          >
            {savedFlash ? (
              <Check className="h-3 w-3" strokeWidth={3} />
            ) : (
              <Save className="h-3 w-3" strokeWidth={2} />
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={onLookup}
          disabled={!llmReady || lookup.kind === "loading"}
          title={llmReady ? "AI 查词" : "请先在设置里配置 AI 翻译服务"}
          className="flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-white bg-gradient-to-r from-indigo-500 to-purple-500 shadow-sm shadow-purple-500/30 hover:from-indigo-400 hover:to-purple-400 hover:shadow-purple-500/50 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:from-indigo-500 disabled:hover:to-purple-500"
        >
          {lookup.kind === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          {(meaningZh || usage).trim() ? "AI 重新查" : "AI 查词"}
        </button>
        <button
          type="button"
          onClick={onStar}
          title={saved ? "已收藏 · 点击移除" : "收藏到我的词汇本"}
          className={
            "flex h-7 w-7 items-center justify-center rounded-full transition-colors " +
            (saved
              ? "text-amber-300 hover:bg-amber-900/30"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-amber-300")
          }
        >
          <Star className="h-4 w-4" fill={saved ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          onClick={closeBubble}
          title="关闭"
          className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Inputs (always visible) */}
      <div className="flex flex-col gap-2 px-3 py-2">
        {lookup.kind === "error" && (
          <div className="flex items-center gap-2 rounded bg-red-900/30 px-2 py-1 text-xs text-red-300">
            <AlertCircle className="h-3.5 w-3.5" />
            <span className="flex-1 truncate">查询失败：{lookup.message}</span>
            <button
              type="button"
              onClick={onLookup}
              className="rounded px-2 py-0.5 hover:bg-red-900/40"
            >
              重试
            </button>
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">中文释义</span>
          <textarea
            value={meaningZh}
            onChange={(e) => setMeaningZh(e.target.value)}
            rows={2}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-400 resize-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">用法</span>
          <textarea
            value={usage}
            onChange={(e) => setUsage(e.target.value)}
            rows={2}
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-400 resize-none"
          />
        </label>
        {suggestion && (
          <div className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-950/20 p-2">
            <div className="text-xs font-medium text-amber-300">AI 建议</div>
            {/* LLM raw result — fixed height, never changes on hover. Stable
             *  layout above the buttons so hovering can't push buttons out
             *  from under the cursor and trigger mouseEnter/Leave flicker. */}
            <div className="text-xs text-amber-100/90 max-h-32 overflow-y-auto whitespace-pre-wrap leading-relaxed">
              <div className="mb-1">
                <span className="text-amber-300">📖 </span>
                {suggestion.meaningZh || "（空）"}
              </div>
              <div>
                <span className="text-amber-300">💬 </span>
                {suggestion.usage || "（空）"}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setMeaningZh(suggestion.meaningZh);
                  setUsage(suggestion.usage);
                  setSuggestion(null);
                }}
                className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
              >
                替换
              </button>
              <button
                type="button"
                onClick={() => {
                  setMeaningZh(joinWithBreak(meaningZh, suggestion.meaningZh));
                  setUsage(joinWithBreak(usage, suggestion.usage));
                  setSuggestion(null);
                }}
                className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
              >
                追加
              </button>
              <button
                type="button"
                onClick={() => setSuggestion(null)}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                忽略
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function isProviderReady(settings: Settings): boolean {
  switch (settings.llmProvider) {
    case "openai-compatible":
      return !!settings.openaiCompatible.apiKey && !!settings.openaiCompatible.baseUrl;
    case "claude":
      return !!settings.claude.apiKey;
    case "gemini":
      return !!settings.gemini.apiKey;
    default:
      return false;
  }
}

/**
 * Read the current selection. Returns null if:
 *  - no selection / collapsed
 *  - normalized text is empty
 *  - anchor and focus aren't inside the same cue
 */
function readSelection(
  list: HTMLDivElement,
  subtitles: Subtitle[],
): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  // Both ends must be within the list.
  if (
    !list.contains(range.startContainer) ||
    !list.contains(range.endContainer)
  )
    return null;

  const startCue = closestCue(range.startContainer);
  const endCue = closestCue(range.endContainer);
  if (!startCue || !endCue || startCue !== endCue) return null;

  const idxStr = startCue.getAttribute("data-idx");
  if (!idxStr) return null;
  const cueIdx = Number(idxStr);
  const sub = subtitles[cueIdx];
  if (!sub) return null;

  const expression = normalizeExpression(sel.toString());
  if (!expression) return null;

  const rect = range.getBoundingClientRect();
  return {
    expression,
    cueIdx,
    cueText: sub.text,
    cueTime: sub.time,
    rect,
  };
}

function closestCue(node: Node): HTMLElement | null {
  let n: Node | null = node;
  while (n && n.nodeType !== Node.ELEMENT_NODE) n = n.parentNode;
  if (!n) return null;
  const el = n as HTMLElement;
  return el.closest<HTMLElement>("[data-idx]");
}

function clampLeft(x: number): number {
  const min = 8;
  const max = (typeof window !== "undefined" ? window.innerWidth : 1200) - BUBBLE_WIDTH - 8;
  return Math.max(min, Math.min(x, max));
}

function joinWithBreak(a: string, b: string): string {
  if (!a.trim()) return b;
  if (!b.trim()) return a;
  return `${a}\n${b}`;
}
