import { useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type { Subtitle } from "../llm/types";
import { HighlightWord } from "./HighlightWord";
import { VocabHighlight } from "./VocabHighlight";
import { SubtitleSelectionBubble } from "./SubtitleSelectionBubble";
import { formatTime, formatEditTime, parseEditTime } from "../utils/time";
import { useAnalysis } from "../store/analysis";

/** Per-vocab-entry data shown when the user hovers a thin-yellow vocab span. */
export interface VocabHighlightInfo {
  meaningZh: string;
  usage: string;
}

interface Props {
  subtitles: Subtitle[];
  currentIdx: number;
  onJump: (timeSec: number) => void;
  autoScroll: boolean;
  editing: boolean;
  onChanged?: () => void;
  /** Map keyed by lowercased+trimmed expression (= VocabEntry.id) → meaning/usage,
   *  for rendering thin-yellow vocab highlights with hover tooltips on
   *  already-saved words. Computed in Player.tsx via useMemo over
   *  useVocabulary().entries filtered by videoId. */
  vocabMap: Map<string, VocabHighlightInfo>;
  /** Used by SubtitleSelectionBubble to record which video an entry came from. */
  videoId: string;
  videoTitle: string;
}

function emptyCueAfter(idx: number, subs: Subtitle[]): Subtitle {
  const cur = subs[idx];
  const next = subs[idx + 1];
  const startTime = cur ? cur.endTime : 0;
  const endTime = next ? Math.max(startTime + 0.001, next.time) : startTime + 2;
  return {
    time: startTime,
    endTime,
    text: "",
    translation: "",
    isKeyPoint: false,
    highlightWords: [],
    keyNotes: {},
    highlightTranslations: {},
  };
}

const USER_SCROLL_RESUME_MS = 2000;

export function SubtitleList({
  subtitles,
  currentIdx,
  onJump,
  autoScroll,
  editing,
  onChanged,
  vocabMap,
  videoId,
  videoTitle,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const { phase, updateSubtitle, deleteSubtitle, insertSubtitle, reorderSubtitles } =
    useAnalysis();
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const notify = () => {
    onChanged?.();
  };

  // Auto-scroll freeze model — two independent signals OR'd together:
  //
  //   1. hoveringHighlight: user's cursor is currently over a highlight span.
  //      Holds freeze for the full duration of the hover, no timer.
  //   2. interacting: user did SOMETHING in the last 2s — scrolled, touched,
  //      OR just-left-a-highlight (we treat the post-hover moment as still-
  //      reading and grant 2s grace before snapping back). Any new
  //      scroll/wheel/touch within the 2s extends it.
  //
  // ref is for synchronous read inside the effect (avoids the wheel-vs-
  // currentIdx batching race); state mirror is in the deps array so the
  // effect re-runs when the timer flips false (otherwise the snap-back
  // wouldn't happen until the next currentIdx tick — broken on a paused
  // video).
  const [hoveringHighlight, setHoveringHighlight] = useState(false);
  const interactingRef = useRef(false);
  const [interacting, setInteracting] = useState(false);
  const interactingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while one of OUR scrollIntoView animations is in progress. The
  // 'scroll' listener consults this to avoid mistaking our own scroll for
  // user input.
  const programmaticScrollRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Bump = "user just did something, freeze for 2s, reset on every new
  // event". Called from scroll/wheel/touchmove AND from highlight mouseout
  // (so leaving a highlight starts the same 2s grace before snap-back).
  const bumpInteraction = () => {
    interactingRef.current = true;
    setInteracting(true);
    // User trumps any in-flight programmatic scroll animation.
    programmaticScrollRef.current = false;
    if (interactingTimerRef.current) clearTimeout(interactingTimerRef.current);
    interactingTimerRef.current = setTimeout(() => {
      interactingRef.current = false;
      setInteracting(false);
    }, USER_SCROLL_RESUME_MS);
  };

  useEffect(() => {
    if (!autoScroll) return;
    if (editing) return;
    if (hoveringHighlight) return;       // still reading a tooltip
    if (interactingRef.current) return;  // within 2s grace from last interaction
    if (currentIdx < 0) return;
    const el = listRef.current?.querySelector(`[data-idx="${currentIdx}"]`);
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    // Smooth scroll generates a burst of 'scroll' events for ~300-500 ms.
    // Hold the flag long enough to cover that window, then release so future
    // user scrolls are detected.
    if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    programmaticTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 800);
    // `interacting` state is in the dep list (not just the ref) so when its
    // timer flips false, the effect re-runs and snaps to current cue —
    // important on a paused video where currentIdx isn't advancing.
  }, [currentIdx, hoveringHighlight, interacting, autoScroll, editing]);

  // Highlight hover: enter freezes; exit DOES NOT immediately release —
  // instead it bumps the 2s interaction timer so the user can move away
  // (e.g. to compare with the next phrase) without the cue snapping back
  // mid-thought. Subsequent scroll/wheel/hover within 2s resets the timer.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-highlight="true"]')) setHoveringHighlight(true);
    };
    const onOut = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('[data-highlight="true"]')) return;
      // Moving directly to another highlight: stay hovering, no grace timer.
      const related = e.relatedTarget as HTMLElement | null;
      if (related?.closest?.('[data-highlight="true"]')) return;
      setHoveringHighlight(false);
      bumpInteraction();
    };
    list.addEventListener("mouseover", onOver);
    list.addEventListener("mouseout", onOut);
    return () => {
      list.removeEventListener("mouseover", onOver);
      list.removeEventListener("mouseout", onOut);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect user-initiated scroll. We listen on:
  //  - 'scroll' on the container: catches wheel, scrollbar drag, keyboard,
  //    touch — anything that moves scrollTop. Discriminated against our own
  //    scrollIntoView via programmaticScrollRef.
  //  - 'wheel'/'touchmove' as a belt-and-braces signal that ALWAYS marks
  //    user intent, even if it lands during a programmatic animation
  //    (so the user can interrupt our auto-scroll mid-animation).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      bumpInteraction();
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("wheel", bumpInteraction, { passive: true });
    list.addEventListener("touchmove", bumpInteraction, { passive: true });
    return () => {
      list.removeEventListener("scroll", onScroll);
      list.removeEventListener("wheel", bumpInteraction);
      list.removeEventListener("touchmove", bumpInteraction);
      if (interactingTimerRef.current) clearTimeout(interactingTimerRef.current);
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Container always renders (even with 0 subtitles) so that listRef.current
  // is set on the very first mount. Otherwise, when SubtitleList mounts while
  // an LLM analysis is still streaming the first cue, the hover/scroll
  // listener effect runs once with listRef.current === null and silently
  // never re-attaches when cues finally arrive — leading to "auto-scroll
  // doesn't freeze on hover" for first-time analysis.
  return (
    <div ref={listRef} className="overflow-y-auto h-full">
      {subtitles.length === 0 ? (
        phase === "analyzing" ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center">
            <div className="w-10 h-10 border-3 border-blue-400 border-t-transparent rounded-full animate-spin mb-4" />
            <div className="text-sm text-zinc-200 font-medium mb-2">AI 正在解析字幕...</div>
            <div className="text-xs text-zinc-500 max-w-xs leading-relaxed">
              LLM 正在为这个视频生成中文翻译和重点短语标注。<br />
              字幕会一行一行出现，无需等待全部完成——视频可以立即播放。<br />
              首批字幕通常 5-15 秒内开始出现。
            </div>
          </div>
        ) : phase === "complete" ? (
          <div className="p-4 text-zinc-500 text-sm">
            没有字幕（LLM 输出可能格式有误，可以尝试重新解析）
          </div>
        ) : (
          <div className="p-4 text-zinc-500 text-sm">等待字幕...</div>
        )
      ) : (
        subtitles.map((s, i) => {
        if (!editing) {
          return (
            <div
              key={i}
              data-idx={i}
              onClick={() => onJump(s.time)}
              className={
                "px-3 py-2 border-b border-zinc-800 cursor-pointer hover:bg-zinc-800/50 " +
                (i === currentIdx
                  ? "bg-blue-500/10 border-l-2 border-l-blue-400 pl-[10px]"
                  : "")
              }
            >
              <div className="text-zinc-500 text-[11px]">
                {formatTime(s.time)} → {formatTime(s.endTime)}
              </div>
              <div className="text-base leading-relaxed text-zinc-100 selection:bg-amber-400/40 selection:text-amber-50">
                {renderEnglishWithHighlights(s, vocabMap)}
              </div>
              <div className="text-zinc-400 text-sm mt-0.5 selection:bg-amber-400/30 selection:text-amber-100">
                {renderTranslationWithHighlights(s)}
              </div>
            </div>
          );
        }
        return (
          <EditableRow
            key={i}
            idx={i}
            subtitle={s}
            isCurrent={i === currentIdx}
            isDragged={draggedIdx === i}
            isDragOver={dragOverIdx === i}
            onUpdateField={(partial) => {
              updateSubtitle(i, partial);
              notify();
            }}
            onDelete={() => {
              deleteSubtitle(i);
              notify();
            }}
            onInsertBelow={() => {
              insertSubtitle(i + 1, emptyCueAfter(i, subtitles));
              notify();
            }}
            onDragStart={(e) => {
              setDraggedIdx(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(i));
            }}
            onDragOver={(e) => {
              // ALWAYS preventDefault during a drag — without it the
              // browser's default action is "no drop allowed" and the
              // cursor shows the forbidden symbol. Same-row drops are
              // filtered later in onDrop. Use the bubble phase here for
              // the visual highlight, but the capture-phase variant below
              // is what guarantees the cursor stays "move".
              if (draggedIdx === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (draggedIdx !== i) setDragOverIdx(i);
            }}
            // Capture phase fires BEFORE any nested textarea/input has a
            // chance to claim the dragover with its native text-drop
            // behavior. Without this, dragging over a textarea inside a
            // row caused the browser to set "forbidden" cursor regardless
            // of the row's bubble-phase handler.
            onDragOverCapture={(e) => {
              if (draggedIdx === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDragLeave={() =>
              setDragOverIdx((cur) => (cur === i ? null : cur))
            }
            onDrop={(e) => {
              e.preventDefault();
              const from = draggedIdx;
              setDraggedIdx(null);
              setDragOverIdx(null);
              if (from === null || from === i) return;
              reorderSubtitles(from, i);
              notify();
            }}
            onDropCapture={(e) => {
              // Same as above: claim the drop in capture phase so a child
              // textarea/input can't insert the dragged text/plain payload
              // ("3" or whatever the source idx is) into its own value.
              if (draggedIdx !== null) e.preventDefault();
            }}
            onDragEnd={() => {
              setDraggedIdx(null);
              setDragOverIdx(null);
            }}
          />
        );
        })
      )}
      <SubtitleSelectionBubble
        listRef={listRef}
        subtitles={subtitles}
        videoId={videoId}
        videoTitle={videoTitle}
        disabled={editing}
      />
    </div>
  );
}

interface EditableRowProps {
  idx: number;
  subtitle: Subtitle;
  isCurrent: boolean;
  isDragged: boolean;
  isDragOver: boolean;
  onUpdateField: (partial: Partial<Subtitle>) => void;
  onDelete: () => void;
  onInsertBelow: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragOverCapture: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onDropCapture: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}

function EditableRow({
  idx,
  subtitle,
  isCurrent,
  isDragged,
  isDragOver,
  onUpdateField,
  onDelete,
  onInsertBelow,
  onDragStart,
  onDragOver,
  onDragOverCapture,
  onDragLeave,
  onDrop,
  onDropCapture,
  onDragEnd,
}: EditableRowProps) {
  const [startStr, setStartStr] = useState(formatEditTime(subtitle.time));
  const [endStr, setEndStr] = useState(formatEditTime(subtitle.endTime));

  // Re-sync local string state when an external update changes the cue (e.g.
  // after reorder, or when this same idx now points at a different cue).
  useEffect(() => {
    setStartStr(formatEditTime(subtitle.time));
    setEndStr(formatEditTime(subtitle.endTime));
  }, [subtitle.time, subtitle.endTime]);

  const commitTime = (key: "time" | "endTime", raw: string) => {
    const v = parseEditTime(raw);
    if (v === null) {
      // Restore last good value visually.
      if (key === "time") setStartStr(formatEditTime(subtitle.time));
      else setEndStr(formatEditTime(subtitle.endTime));
      return;
    }
    if (v !== subtitle[key]) onUpdateField({ [key]: v });
  };

  const rowRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={rowRef}
      data-idx={idx}
      onDragOver={onDragOver}
      onDragOverCapture={onDragOverCapture}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDropCapture={onDropCapture}
      className={
        "px-2 py-2 border-b border-zinc-800 transition-colors " +
        (isDragged
          ? "opacity-40 "
          : isDragOver
          ? "bg-blue-500/10 border-t-2 border-t-blue-400 "
          : "") +
        (isCurrent && !isDragged ? "bg-blue-500/5 " : "")
      }
    >
      <div className="flex items-center gap-1.5">
        <span
          draggable
          onDragStart={(e) => {
            // Use the whole row as the drag image so the user sees what they're
            // moving, not just the tiny grip icon.
            if (rowRef.current) {
              const r = rowRef.current.getBoundingClientRect();
              e.dataTransfer.setDragImage(rowRef.current, 20, r.height / 2);
            }
            onDragStart(e);
          }}
          onDragEnd={onDragEnd}
          className="cursor-grab text-zinc-500 hover:text-zinc-200 active:cursor-grabbing select-none p-1 -m-1 rounded hover:bg-zinc-800"
          title="拖拽改变顺序"
        >
          <GripVertical className="h-4 w-4" />
        </span>
        <span className="text-zinc-500 text-[10px] font-mono">#{idx + 1}</span>
        <input
          type="text"
          value={startStr}
          onChange={(e) => setStartStr(e.target.value)}
          onBlur={(e) => commitTime("time", e.target.value)}
          spellCheck={false}
          className="w-24 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-blue-400"
          title="开始时间 (m:ss.ms)"
        />
        <span className="text-zinc-500 text-xs">→</span>
        <input
          type="text"
          value={endStr}
          onChange={(e) => setEndStr(e.target.value)}
          onBlur={(e) => commitTime("endTime", e.target.value)}
          spellCheck={false}
          className="w-24 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-blue-400"
          title="结束时间 (m:ss.ms)"
        />
        <div className="flex-1" />
        <button
          type="button"
          onClick={onInsertBelow}
          title="在下方插入空字幕"
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-blue-300 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="删除此字幕段"
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-red-400 transition-colors"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        value={subtitle.text}
        onChange={(e) => onUpdateField({ text: e.target.value })}
        rows={2}
        spellCheck={false}
        placeholder="English"
        className="mt-1.5 w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-base leading-snug text-zinc-100 resize-y focus:outline-none focus:border-blue-400"
      />
      <textarea
        value={subtitle.translation}
        onChange={(e) => onUpdateField({ translation: e.target.value })}
        rows={2}
        spellCheck={false}
        placeholder="中文翻译"
        className="mt-1 w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-sm leading-snug text-zinc-300 resize-y focus:outline-none focus:border-blue-400"
      />
    </div>
  );
}

export function renderEnglishWithHighlights(
  s: Subtitle,
  vocabMap: Map<string, VocabHighlightInfo>,
): ReactNode {
  // Pass 1: LLM highlightWords (yellow + keyNote tooltip).
  const llmWords = [...s.highlightWords].sort(
    (a, b) => s.text.indexOf(a) - s.text.indexOf(b)
  );
  const tokens = sliceWithSpans(s.text, llmWords, (w) => (
    <HighlightWord key={`${w}-${s.text.indexOf(w)}`} word={w} note={s.keyNotes[w]} />
  ));

  // Pass 2: in each plain-text token, find vocab matches (case-insensitive,
  // longest first to handle phrase before single-word).
  if (vocabMap.size === 0) return tokens;
  const vocabPhrases = [...vocabMap.keys()].sort((a, b) => b.length - a.length);
  return tokens.flatMap((tok, i) => {
    if (typeof tok !== "string") return [tok];
    return spliceVocabUnderlines(tok, vocabPhrases, vocabMap, i);
  });
}

/**
 * Wraps each non-overlapping case-insensitive match of `phrasesLowercased`
 * inside `text` with a thin-yellow VocabHighlight (with hover tooltip).
 * CALLER CONTRACT: phrases must already be lowercased AND pre-sorted
 * longest-first — internal comparison is `text.toLowerCase().indexOf(phrase)`,
 * so non-lowercased input silently misses case-mismatched entries; the
 * longest-first order is what makes multi-word phrases pre-empt their
 * single-word components via the conflict check below.
 *
 * Phrases that match are looked up in `vocabMap` to surface the saved
 * meaning/usage in the tooltip.
 */
function spliceVocabUnderlines(
  text: string,
  phrasesLowercased: string[],
  vocabMap: Map<string, VocabHighlightInfo>,
  baseKey: number,
): ReactNode[] {
  const lower = text.toLowerCase();
  type Hit = { start: number; end: number; phrase: string };
  const hits: Hit[] = [];
  for (const phrase of phrasesLowercased) {
    let from = 0;
    while (true) {
      const idx = lower.indexOf(phrase, from);
      if (idx === -1) break;
      const end = idx + phrase.length;
      const conflicts = hits.some((h) => idx < h.end && end > h.start);
      if (!conflicts) hits.push({ start: idx, end, phrase });
      from = end;
    }
  }
  hits.sort((a, b) => a.start - b.start);
  if (hits.length === 0) return [text];
  const out: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((h, i) => {
    if (h.start > cursor) out.push(text.slice(cursor, h.start));
    const info = vocabMap.get(h.phrase);
    out.push(
      <VocabHighlight
        key={`vocab-${baseKey}-${i}`}
        word={text.slice(h.start, h.end)}
        meaningZh={info?.meaningZh}
        usage={info?.usage}
      />
    );
    cursor = h.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function renderTranslationWithHighlights(s: Subtitle): ReactNode {
  // highlightTranslations is keyed by English phrase; values are Chinese substrings of translation
  const zhPhrases = s.highlightWords
    .map((w) => s.highlightTranslations[w])
    .filter((zh): zh is string => Boolean(zh));
  if (zhPhrases.length === 0) return s.translation;

  // Sort by their occurrence so left-to-right scan can splice non-overlapping matches.
  const sorted = [...zhPhrases].sort(
    (a, b) => s.translation.indexOf(a) - s.translation.indexOf(b)
  );
  return sliceWithSpans(s.translation, sorted, (zh, key) => (
    // data-highlight="true" lets the SubtitleList's hover delegation freeze
    // auto-scroll on the Chinese highlight too — same as the English ones
    // (HighlightWord component sets the same attribute). Without it, hovering
    // on a Chinese highlight wouldn't pause auto-scroll and the cue would
    // jump out from under the cursor.
    <span
      key={key}
      data-highlight="true"
      className="bg-amber-300/30 text-amber-100 px-0.5 rounded"
    >
      {zh}
    </span>
  ));
}

/**
 * Walk `text` left to right, wrapping each occurrence of `phrases` in turn with `wrap()`.
 * Skips phrases not found in text or that overlap a previously placed wrap.
 */
function sliceWithSpans(
  text: string,
  phrases: string[],
  wrap: (phrase: string, key: string) => ReactNode
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const p of phrases) {
    if (!p) continue;
    const idx = text.indexOf(p, cursor);
    if (idx === -1) continue;
    if (idx > cursor) out.push(text.slice(cursor, idx));
    out.push(wrap(p, `${p}-${idx}`));
    cursor = idx + p.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
