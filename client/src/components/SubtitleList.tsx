import { useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type { Subtitle } from "../llm/types";
import { HighlightWord } from "./HighlightWord";
import { formatTime, formatEditTime, parseEditTime } from "../utils/time";
import { useAnalysis } from "../store/analysis";

interface Props {
  subtitles: Subtitle[];
  currentIdx: number;
  onJump: (timeSec: number) => void;
  autoScroll: boolean;
  editing: boolean;
  onChanged?: () => void;
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
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const { phase, updateSubtitle, deleteSubtitle, insertSubtitle, reorderSubtitles } =
    useAnalysis();
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const notify = () => {
    onChanged?.();
  };
  // Freeze auto-scroll while the user is reading a HighlightWord tooltip.
  // When they leave the highlight, the effect re-runs and snaps back to the
  // current cue so playback stays in sync.
  const [scrollFrozen, setScrollFrozen] = useState(false);
  // Frozen while the user is actively scrolling the list. The ref is read
  // synchronously in the auto-scroll effect to dodge React's state-update
  // batching (otherwise a wheel event happening in the same tick as a
  // currentIdx update could race and lose). The state mirror is just to
  // re-trigger the effect when the freeze releases.
  const userScrollingRef = useRef(false);
  const [, setUserScrolling] = useState(false);
  // True while one of OUR scrollIntoView animations is in progress. The
  // 'scroll' listener consults this to avoid mistaking our own scroll for
  // user input.
  const programmaticScrollRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!autoScroll) return;
    if (editing) return;
    if (scrollFrozen || userScrollingRef.current) return;
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
  }, [currentIdx, scrollFrozen, autoScroll, editing]);

  // Event-delegated hover detection: any [data-highlight="true"] descendant
  // (set by HighlightWord) freezes the scroll. Avoids drilling props through.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('[data-highlight="true"]')) setScrollFrozen(true);
    };
    const onOut = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('[data-highlight="true"]')) return;
      // Moving directly to another highlight: stay frozen.
      const related = e.relatedTarget as HTMLElement | null;
      if (related?.closest?.('[data-highlight="true"]')) return;
      setScrollFrozen(false);
    };
    list.addEventListener("mouseover", onOver);
    list.addEventListener("mouseout", onOut);
    return () => {
      list.removeEventListener("mouseover", onOver);
      list.removeEventListener("mouseout", onOut);
    };
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
    const bump = () => {
      userScrollingRef.current = true;
      setUserScrolling(true);
      // User overrides any in-flight programmatic scroll.
      programmaticScrollRef.current = false;
      if (userScrollTimerRef.current) clearTimeout(userScrollTimerRef.current);
      userScrollTimerRef.current = setTimeout(() => {
        userScrollingRef.current = false;
        setUserScrolling(false);
      }, USER_SCROLL_RESUME_MS);
    };
    const onScroll = () => {
      if (programmaticScrollRef.current) return;
      bump();
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("wheel", bump, { passive: true });
    list.addEventListener("touchmove", bump, { passive: true });
    return () => {
      list.removeEventListener("scroll", onScroll);
      list.removeEventListener("wheel", bump);
      list.removeEventListener("touchmove", bump);
      if (userScrollTimerRef.current) clearTimeout(userScrollTimerRef.current);
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    };
  }, []);

  // Empty state explaining what's happening — most important when LLM is still
  // streaming the first cue. Once subtitles arrive this branch goes away.
  if (subtitles.length === 0) {
    if (phase === "analyzing") {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="w-10 h-10 border-3 border-blue-400 border-t-transparent rounded-full animate-spin mb-4" />
          <div className="text-sm text-zinc-200 font-medium mb-2">AI 正在解析字幕...</div>
          <div className="text-xs text-zinc-500 max-w-xs leading-relaxed">
            LLM 正在为这个视频生成中文翻译和重点短语标注。<br />
            字幕会一行一行出现，无需等待全部完成——视频可以立即播放。<br />
            首批字幕通常 5-15 秒内开始出现。
          </div>
        </div>
      );
    }
    if (phase === "complete") {
      return (
        <div className="p-4 text-zinc-500 text-sm">
          没有字幕（LLM 输出可能格式有误，可以尝试重新解析）
        </div>
      );
    }
    return (
      <div className="p-4 text-zinc-500 text-sm">等待字幕...</div>
    );
  }

  return (
    <div ref={listRef} className="overflow-y-auto h-full">
      {subtitles.map((s, i) => {
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
              <div className="text-base leading-relaxed text-zinc-100">
                {renderEnglishWithHighlights(s)}
              </div>
              <div className="text-zinc-400 text-sm mt-0.5">
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
              if (draggedIdx === null || draggedIdx === i) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverIdx(i);
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
            onDragEnd={() => {
              setDraggedIdx(null);
              setDragOverIdx(null);
            }}
          />
        );
      })}
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
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
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
  onDragLeave,
  onDrop,
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
      onDragLeave={onDragLeave}
      onDrop={onDrop}
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

function renderEnglishWithHighlights(s: Subtitle): ReactNode {
  if (s.highlightWords.length === 0) return s.text;
  const words = [...s.highlightWords].sort(
    (a, b) => s.text.indexOf(a) - s.text.indexOf(b)
  );
  return renderWithSpans(s.text, words, (w) => (
    <HighlightWord key={`${w}-${s.text.indexOf(w)}`} word={w} note={s.keyNotes[w]} />
  ));
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
  return renderWithSpans(s.translation, sorted, (zh, key) => (
    <span key={key} className="bg-amber-300/30 text-amber-100 px-0.5 rounded">
      {zh}
    </span>
  ));
}

/**
 * Walk `text` left to right, wrapping each occurrence of `phrases` in turn with `wrap()`.
 * Skips phrases not found in text or that overlap a previously placed wrap.
 */
function renderWithSpans(
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
