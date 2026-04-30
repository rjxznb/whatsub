import { useEffect, useMemo, useState } from "react";
import { Volume2 } from "lucide-react";
import type { KeyPhrase, Subtitle } from "../llm/types";
import { lookupPhonetic } from "../llm/phonetic";
import { useSpeech } from "../hooks/useSpeech";
import { StarButton } from "./StarButton";

interface Props {
  phrases: KeyPhrase[];
  /** Used to resolve the first source cue for each phrase (for deep-linking
   *  back to that moment from the vocabulary page). */
  subtitles: Subtitle[];
  videoId: string;
  videoTitle: string;
}

/** Resolves IPA for all phrases once the list arrives. Missing entries stay
 *  null and are simply not rendered. */
function usePhonetics(phrases: KeyPhrase[]): Record<string, string | null> {
  const [map, setMap] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      phrases.map(async (p) => {
        try {
          const ipa = await lookupPhonetic(p.expression);
          return [p.expression, ipa] as const;
        } catch {
          return [p.expression, null] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setMap(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [phrases]);
  return map;
}

export function KeyPhraseList({ phrases, subtitles, videoId, videoTitle }: Props) {
  const phoneticMap = usePhonetics(phrases);
  const { voices, voiceURI, setVoiceURI, speak, hasEnglish } = useSpeech();
  const [showInstallHint, setShowInstallHint] = useState(false);

  // Build a map: expression → first cue containing it (by highlightWords).
  // Falls back to a substring scan of cue text when the LLM didn't list this
  // exact phrase in highlightWords. Recomputed when subtitles change.
  const cueContextMap = useMemo(() => {
    const map: Record<string, { time: number; text: string }> = {};
    for (const p of phrases) {
      const expr = p.expression;
      let hit = subtitles.find((s) => s.highlightWords.includes(expr));
      if (!hit) {
        const lower = expr.toLowerCase();
        hit = subtitles.find((s) => s.text.toLowerCase().includes(lower));
      }
      if (hit) map[expr] = { time: hit.time, text: hit.text };
    }
    return map;
  }, [phrases, subtitles]);

  if (phrases.length === 0) {
    return <div className="p-4 text-zinc-500 text-sm">分析完成后这里会显示重点短语...</div>;
  }

  return (
    <div className="overflow-y-auto h-full flex flex-col">
      {/* Voice selector header — always visible so the user can see the feature
          even if voices haven't loaded yet, and learn why if loading failed. */}
      <div className="sticky top-0 bg-zinc-950 z-10 border-b border-zinc-800">
        <div className="flex items-center gap-2 px-3 py-2">
          {!hasEnglish && voices.length > 0 && (
            <button
              type="button"
              onClick={() => setShowInstallHint((v) => !v)}
              className="text-[10px] text-amber-300 hover:text-amber-200 underline mr-auto"
              title="点击查看如何安装英语 TTS 语音包"
            >
              ⚠ 未装英语音色
            </button>
          )}
          <span className="text-[10px] text-zinc-500 ml-auto">音色</span>
          {voices.length > 0 ? (
            <select
              value={voiceURI ?? ""}
              onChange={(e) => setVoiceURI(e.target.value)}
              className="text-xs bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 max-w-[200px]"
              title="选择 TTS 音色"
            >
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[10px] text-zinc-500 italic">
              系统未提供任何 TTS 音色
            </span>
          )}
        </div>
        {showInstallHint && (
          <div className="px-3 pb-3 text-[11px] text-zinc-300 leading-relaxed bg-zinc-900/40 border-t border-zinc-800">
            <div className="text-amber-300 font-medium mt-2 mb-1">
              安装英语 TTS 语音包（一次性，免费）
            </div>
            <ol className="list-decimal list-inside space-y-0.5 text-zinc-400">
              <li>Win + I 打开 Windows 设置</li>
              <li>左栏「时间和语言」→「语言和区域」→「添加语言」选 English (US/UK/...)</li>
              <li>点新加的语言旁边的「...」→「语言选项」→ 在「语音」里勾选下载</li>
              <li>下载完成后回到这里，重启 app 就能看到 Microsoft Zira / David / Mark 等英语音色</li>
            </ol>
            <div className="text-zinc-500 italic mt-2">
              注：用中文音色读英文会按拼音乱读，建议先装英语包再用 🔊 功能。
            </div>
          </div>
        )}
      </div>

      <div className="p-3 space-y-3">
        {phrases.map((p, i) => {
          const ipa = phoneticMap[p.expression];
          return (
            <div
              key={i}
              className="border border-zinc-800 rounded-md p-3 bg-zinc-900/40"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-amber-300 font-semibold text-sm">
                  {p.expression}
                </span>
                {ipa && (
                  <span className="font-ipa text-zinc-300 text-sm">{ipa}</span>
                )}
                <StarButton
                  expression={p.expression}
                  meaningZh={p.meaningZh}
                  usage={p.usage}
                  videoId={videoId}
                  videoTitle={videoTitle}
                  cueTime={cueContextMap[p.expression]?.time}
                  cueText={cueContextMap[p.expression]?.text}
                  className="ml-auto"
                />
                <button
                  type="button"
                  onClick={() => speak(p.expression)}
                  title="朗读 (Read aloud)"
                  className="flex h-6 w-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-blue-300 transition-colors"
                >
                  <Volume2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="text-zinc-100 text-xs mt-1.5">{p.meaningZh}</div>
              <div className="text-zinc-400 text-xs mt-1 italic">{p.usage}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
