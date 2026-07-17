import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { useSettings } from "../store/settings";

// A fresh install ships with the 极速 (tiny) whisper model, whose transcription
// is noticeably less accurate. On the Player we nudge the user toward a bigger
// model + a one-click jump to the Settings download section (highlighted there
// via ?highlight=whisper-model).

const DISMISS_KEY = "hideTinyModelHint";

export function tinyHintDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "true";
  } catch {
    return false;
  }
}

function persistDismiss(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "true");
  } catch {
    /* ignore */
  }
}

/** Whether to show the "switch off tiny" nudge. Only once real subtitles exist
 *  (so it's about THIS video's transcription, not shown mid-transcribe), and
 *  never after the user opts out. Pure so it can be unit-tested. */
export function shouldShowTinyHint(
  modelSize: string,
  hasSubtitles: boolean,
  dismissed: boolean,
): boolean {
  return modelSize === "tiny" && hasSubtitles && !dismissed;
}

/** Deep-link the Settings page straight to the whisper-model section and flag
 *  it for the highlight pulse. Shared with any other caller that wants to send
 *  the user to download a model. */
export const SETTINGS_MODEL_LINK = "/settings?highlight=whisper-model";

export function TinyModelHint({ hasSubtitles }: { hasSubtitles: boolean }) {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(tinyHintDismissed);

  if (!shouldShowTinyHint(settings.whisperModel, hasSubtitles, dismissed)) {
    return null;
  }

  return (
    <div className="px-4 pt-2">
      <div className="flex items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="flex-1 leading-relaxed">
          当前使用的是「极速」模型，字幕识别可能不够准确。换用更大的模型识别效果更好。
        </span>
        <button
          type="button"
          onClick={() => navigate(SETTINGS_MODEL_LINK)}
          className="shrink-0 inline-flex items-center gap-1 rounded bg-amber-400 px-2.5 py-1 text-xs font-medium text-black hover:bg-amber-300 transition-colors"
        >
          下载更大的模型 <ArrowRight className="h-3 w-3" />
        </button>
        <button
          type="button"
          title="不再提示"
          aria-label="不再提示"
          onClick={() => {
            persistDismiss();
            setDismissed(true);
          }}
          className="shrink-0 text-amber-300/70 hover:text-amber-100 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
