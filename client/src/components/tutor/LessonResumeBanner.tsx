import { useEffect, useState } from "react";
import type { LessonState } from "../../tutor/types";
import { loadLessonState, clearLessonState } from "../../tutor/lessonState";

interface Props {
  videoId: string;
  onResume: (state: LessonState) => void;
}

export function LessonResumeBanner({ videoId, onResume }: Props) {
  const [pending, setPending] = useState<LessonState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const state = await loadLessonState();
      if (cancelled) return;
      // Only surface pending lessons for THIS video. State from a different
      // video gets ignored here; user can resume by re-opening that video.
      if (state && state.videoId === videoId) {
        setPending(state);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  if (!pending || dismissed) return null;

  const completed = pending.history.length;
  const total = pending.plan.anchors.length;

  return (
    <div
      data-tutor-resume
      className="bg-sky-500/10 border border-sky-500/30 rounded-md px-4 py-3 mb-3 flex items-center gap-3"
    >
      <div className="text-sm text-sky-100 flex-1">
        上次精讲到 <span className="font-medium">{completed} / {total}</span>
      </div>
      <button
        type="button"
        onClick={() => onResume(pending)}
        className="px-3 py-1 rounded text-sm bg-sky-500 hover:bg-sky-400 text-white"
      >
        继续
      </button>
      <button
        type="button"
        onClick={async () => {
          await clearLessonState();
          setDismissed(true);
        }}
        className="px-3 py-1 rounded text-sm text-sky-200 hover:bg-white/5"
      >
        重新开始
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="px-2 py-1 text-sm text-sky-300 hover:text-sky-100"
      >
        关掉
      </button>
    </div>
  );
}
