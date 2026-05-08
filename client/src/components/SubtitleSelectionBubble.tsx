import { useEffect, useRef, useState } from "react";
import { Search, Star, Loader2, AlertCircle } from "lucide-react";
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
}: Props) {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [meaningZh, setMeaningZh] = useState("");
  const [usage, setUsage] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  const [suggestion, setSuggestion] = useState<{
    meaningZh: string;
    usage: string;
  } | null>(null);
  const [hoverPreview, setHoverPreview] = useState<
    null | "replace" | "append"
  >(null);
  const lookupAbortRef = useRef<AbortController | null>(null);
  const { entries, has, toggle, add } = useVocabulary();
  const { settings } = useSettings();

  // On selection change: restore from vocab (top priority), then draft, else collapsed default.
  useEffect(() => {
    if (!info) return;
    setLookup({ kind: "idle" });
    setSuggestion(null);
    setHoverPreview(null);
    lookupAbortRef.current?.abort();

    const id = makeVocabId(info.expression);
    const existing = entries.find((e) => e.id === id);
    if (existing) {
      // Already-saved: auto-expand with vocab values; debounce-upsert active.
      setMeaningZh(existing.meaningZh);
      setUsage(existing.usage);
      setExpanded(true);
      return;
    }
    const draft = loadDraft(info.expression);
    if (draft) {
      setMeaningZh(draft.meaningZh);
      setUsage(draft.usage);
      setExpanded(true);
      return;
    }
    // Fresh, no draft, no vocab — collapsed default.
    setMeaningZh("");
    setUsage("");
    setExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.expression]);

  // Detect selection (unchanged from Task 7).
  useEffect(() => {
    if (disabled) return;
    const list = listRef.current;
    if (!list) return;
    const onMouseUp = () => {
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
  useEffect(() => {
    if (!info) return;
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) closeBubble();
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, saved, meaningZh, usage]);

  if (!info) return null;

  const onLookup = async () => {
    lookupAbortRef.current?.abort();
    const ctrl = new AbortController();
    lookupAbortRef.current = ctrl;
    setExpanded(true);
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
    setInfo(null);
    window.getSelection()?.removeAllRanges();
  };

  const previewMeaning =
    hoverPreview === "replace"
      ? suggestion?.meaningZh ?? meaningZh
      : hoverPreview === "append" && suggestion?.meaningZh
      ? joinWithBreak(meaningZh, suggestion.meaningZh)
      : meaningZh;

  const previewUsage =
    hoverPreview === "replace"
      ? suggestion?.usage ?? usage
      : hoverPreview === "append" && suggestion?.usage
      ? joinWithBreak(usage, suggestion.usage)
      : usage;

  const showingPreview = hoverPreview !== null;

  const top = Math.max(
    8,
    info.rect.top - (expanded ? (suggestion ? 330 : 200) : 44),
  );
  const left = clampLeft(info.rect.left + info.rect.width / 2 - BUBBLE_WIDTH / 2);

  const llmReady = isProviderReady(settings);

  const closeBubble = () => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
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
      style={{ position: "fixed", top, left, width: BUBBLE_WIDTH }}
      className="z-50 flex flex-col rounded-lg border border-zinc-700 bg-zinc-900/95 shadow-xl backdrop-blur"
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800">
        <span
          className="flex-1 truncate text-sm text-zinc-100"
          title={info.expression}
        >
          {info.expression}
        </span>
        <button
          type="button"
          onClick={onLookup}
          disabled={!llmReady || lookup.kind === "loading"}
          title={llmReady ? "LLM 查词" : "请先在设置里配置 AI 翻译服务"}
          className="flex h-7 items-center gap-1 rounded px-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {lookup.kind === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          {expanded ? "重新查" : "查词"}
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
      </div>

      {/* Inputs (expanded) */}
      {expanded && (
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
            <span className="text-xs text-zinc-500">📖 中文释义</span>
            <textarea
              value={previewMeaning}
              onChange={(e) => setMeaningZh(e.target.value)}
              rows={2}
              readOnly={showingPreview}
              className={
                "w-full rounded border px-2 py-1 text-sm focus:outline-none resize-none " +
                (showingPreview
                  ? "border-amber-500/40 bg-amber-950/20 text-amber-100/80 italic"
                  : "border-zinc-700 bg-zinc-950 text-zinc-100 focus:border-blue-400")
              }
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">💬 用法</span>
            <textarea
              value={previewUsage}
              onChange={(e) => setUsage(e.target.value)}
              rows={2}
              readOnly={showingPreview}
              className={
                "w-full rounded border px-2 py-1 text-sm focus:outline-none resize-none " +
                (showingPreview
                  ? "border-amber-500/40 bg-amber-950/20 text-amber-100/80 italic"
                  : "border-zinc-700 bg-zinc-950 text-zinc-100 focus:border-blue-400")
              }
            />
          </label>
          {suggestion && (
            <div className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-950/20 p-2">
              <div className="text-xs font-medium text-amber-300">AI 建议</div>
              <div className="text-xs text-amber-100/80">
                <div>📖 {suggestion.meaningZh || "（空）"}</div>
                <div>💬 {suggestion.usage || "（空）"}</div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onMouseEnter={() => setHoverPreview("replace")}
                  onMouseLeave={() => setHoverPreview(null)}
                  onClick={() => {
                    setMeaningZh(suggestion.meaningZh);
                    setUsage(suggestion.usage);
                    setSuggestion(null);
                    setHoverPreview(null);
                  }}
                  className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
                >
                  替换
                </button>
                <button
                  type="button"
                  onMouseEnter={() => setHoverPreview("append")}
                  onMouseLeave={() => setHoverPreview(null)}
                  onClick={() => {
                    setMeaningZh(joinWithBreak(meaningZh, suggestion.meaningZh));
                    setUsage(joinWithBreak(usage, suggestion.usage));
                    setSuggestion(null);
                    setHoverPreview(null);
                  }}
                  className="flex-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
                >
                  追加
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSuggestion(null);
                    setHoverPreview(null);
                  }}
                  className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                >
                  忽略
                </button>
              </div>
            </div>
          )}
        </div>
      )}
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
  return `${a}\n\n${b}`;
}
