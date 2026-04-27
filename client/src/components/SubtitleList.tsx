import { useEffect, useRef, type ReactNode } from "react";
import type { Subtitle } from "../llm/types";
import { HighlightWord } from "./HighlightWord";
import { formatTime } from "../utils/time";
import { useAnalysis } from "../store/analysis";

interface Props {
  subtitles: Subtitle[];
  currentIdx: number;
  onJump: (timeSec: number) => void;
}

export function SubtitleList({ subtitles, currentIdx, onJump }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const { phase } = useAnalysis();

  useEffect(() => {
    if (currentIdx < 0) return;
    const el = listRef.current?.querySelector(`[data-idx="${currentIdx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentIdx]);

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
      {subtitles.map((s, i) => (
        <div
          key={i}
          data-idx={i}
          onClick={() => onJump(s.time)}
          className={
            "px-3 py-2 border-b border-zinc-800 cursor-pointer hover:bg-zinc-800/50 " +
            (i === currentIdx ? "bg-blue-500/10 border-l-2 border-l-blue-400 pl-[10px]" : "")
          }
        >
          <div className="text-zinc-500 text-[10px]">
            {formatTime(s.time)} → {formatTime(s.endTime)}
          </div>
          <div className="text-sm leading-relaxed text-zinc-100">
            {renderEnglishWithHighlights(s)}
          </div>
          <div className="text-zinc-400 text-xs mt-0.5">
            {renderTranslationWithHighlights(s)}
          </div>
        </div>
      ))}
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
