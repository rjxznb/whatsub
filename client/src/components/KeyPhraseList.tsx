import { useEffect, useMemo, useState } from "react";
import { Volume2 } from "lucide-react";
import type { KeyPhrase, Subtitle } from "../llm/types";
import { lookupPhonetic } from "../llm/phonetic";
import { ttsSpeak } from "../tutor/tts";
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
  // Edge neural voice (same as the tutor), not the OS TTS. ttsSpeak falls back
  // to Web Speech internally if edge is unreachable.
  const speak = (text: string) => {
    void ttsSpeak(text, { lang: "en-US" });
  };

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
