import { useEffect, useRef, useState } from "react";
import { Search, Star, Loader2, AlertCircle } from "lucide-react";
import type { Subtitle } from "../llm/types";
import { useVocabulary } from "../store/vocab";
import { useSettings } from "../store/settings";
import type { Settings } from "../types/settings";
import { normalizeExpression } from "../utils/normalizeExpression";
import { lookupExpression } from "../llm/lookupExpression";
import { getProvider } from "../llm/providers";

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
  const lookupAbortRef = useRef<AbortController | null>(null);
  const { has, toggle, add } = useVocabulary();
  const { settings } = useSettings();

  // Reset bubble state every time a new selection is made.
  useEffect(() => {
    if (!info) return;
    setExpanded(false);
    setMeaningZh("");
    setUsage("");
    setLookup({ kind: "idle" });
    lookupAbortRef.current?.abort();
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

  // Hide on collapsed selection.
  useEffect(() => {
    if (!info) return;
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setInfo(null);
    };
    document.addEventListener("selectionchange", onSelChange);
    return () => document.removeEventListener("selectionchange", onSelChange);
  }, [info]);

  if (!info) return null;

  const saved = has(info.expression);

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
      setMeaningZh(result.meaningZh);
      setUsage(result.usage);
      setLookup({ kind: "idle" });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setLookup({ kind: "error", message: String(e) });
    }
  };

  const onStar = async () => {
    if (saved) {
      // Toggle behavior — remove and stay open so user can re-edit + re-save.
      await toggle({
        expression: info.expression,
        meaningZh,
        usage,
        videoId,
        videoTitle,
        cueTime: info.cueTime,
        cueText: info.cueText,
      });
      return;
    }
    await add({
      id: info.expression.toLowerCase().trim(),
      expression: info.expression,
      meaningZh,
      usage,
      videoId,
      videoTitle,
      cueTime: info.cueTime,
      cueText: info.cueText,
      addedAt: new Date().toISOString(),
    });
    setInfo(null);
    window.getSelection()?.removeAllRanges();
  };

  const top = Math.max(8, info.rect.top - (expanded ? 200 : 44));
  const left = clampLeft(info.rect.left + info.rect.width / 2 - 200);

  const llmReady = isProviderReady(settings);

  return (
    <div
      style={{ position: "fixed", top, left, width: 400 }}
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
              value={meaningZh}
              onChange={(e) => setMeaningZh(e.target.value)}
              rows={2}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-400 resize-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500">💬 用法</span>
            <textarea
              value={usage}
              onChange={(e) => setUsage(e.target.value)}
              rows={2}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-blue-400 resize-none"
            />
          </label>
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
  const max = (typeof window !== "undefined" ? window.innerWidth : 1200) - 248;
  return Math.max(min, Math.min(x, max));
}
