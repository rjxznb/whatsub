import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, RotateCcw, Play, Pause } from "lucide-react";
import type { LessonRuntime } from "../../tutor/lessonRuntime";
import {
  ttsSpeak,
  ttsCancel,
  ttsPause,
  ttsResume,
  ttsSetRate,
  getTtsVoiceZh,
  getTtsVoiceEn,
  setTtsVoiceZh,
  setTtsVoiceEn,
  isTtsEnabled,
  setTtsEnabled,
  getTtsRate,
  TTS_RATE_MIN,
  TTS_RATE_MAX,
} from "../../tutor/tts";
import { EDGE_VOICE_GROUPS } from "../../tutor/edgeTts";
import { MarkdownText } from "../agent/markdown";
import {
  TUTOR_CARD,
  TUTOR_EYEBROW,
  TUTOR_INSET,
  TUTOR_TEXTAREA,
  ICON_BTN,
  BTN_PRIMARY,
  BTN_SUBTLE,
} from "./styles";

interface Props {
  runtime: LessonRuntime;
  onContinue: () => void;
  onRetry: () => void;
  onReplayCue: () => void;
  onSubmitAnswer: (answer: string) => void;
  /** Stop the video (pause). Called when leaving the "listen" step so the cue
   *  audio doesn't talk over the tutor's TTS. Optional for tests. */
  onStopVideo?: () => void;
}

/** Renders the current step of the lesson runtime. The tutor "speaks" its
 *  explanation / question / feedback aloud via OS-native TTS (so a lesson
 *  feels like a class, not a wall of text); step 1's 重听 replays the real
 *  video audio (the English the learner should listen to), the spoken
 *  Chinese coaching is steps 2/3/5. A header toggle mutes the voice. */
export function LessonStepView({
  runtime,
  onContinue,
  onRetry,
  onReplayCue,
  onSubmitAnswer,
  onStopVideo,
}: Props) {
  const [draft, setDraft] = useState("");
  const [muted, setMuted] = useState(() => !isTtsEnabled());
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(() => getTtsRate());
  const [voiceZh, setVoiceZh] = useState(() => getTtsVoiceZh());
  const [voiceEn, setVoiceEn] = useState(() => getTtsVoiceEn());

  const {
    currentStep,
    currentExplainText,
    currentQuestion,
    currentFeedback,
    canRetry,
    answerRevealed,
    currentAnchorIdx,
  } = runtime.state;
  const totalAnchors = runtime.state.plan.anchors.length;
  const anchor = runtime.state.plan.anchors[currentAnchorIdx];

  // The line the tutor should read aloud for the current step.
  const spokenLine =
    currentStep === 2
      ? currentExplainText
      : currentStep === 3
        ? currentQuestion?.question ?? ""
        : currentStep === 5
          ? currentFeedback?.feedback ?? ""
          : "";

  // Auto-speak the current step's coaching line when it appears (unless
  // muted). Re-runs when the step or its text changes; cancels on cleanup so
  // advancing/closing never leaves a voice droning over the next screen.
  const lastSpokenRef = useRef<string>("");
  useEffect(() => {
    if (muted || !spokenLine) {
      ttsCancel();
      setSpeaking(false);
      setPaused(false);
      return;
    }
    if (lastSpokenRef.current === spokenLine) return; // don't re-read on unrelated re-renders
    lastSpokenRef.current = spokenLine;
    void ttsSpeak(spokenLine, {
      onStart: () => {
        setSpeaking(true);
        setPaused(false);
      },
      onEnd: () => {
        setSpeaking(false);
        setPaused(false);
      },
    });
    return () => {
      ttsCancel();
      setSpeaking(false);
      setPaused(false);
    };
  }, [spokenLine, muted]);

  // Drive the video to match the step. Step 1 (listen) auto-plays this anchor's
  // original cue once — so entering 精讲 immediately plays the sentence instead
  // of sitting paused until the user clicks 重听原句. Any later step stops the
  // video so the cue doesn't keep playing under the tutor's TTS. Keyed on
  // step+anchor so it fires exactly once per transition.
  const videoStepRef = useRef<string>("");
  useEffect(() => {
    const key = `${currentAnchorIdx}:${currentStep === 1 ? "listen" : "coach"}`;
    if (videoStepRef.current === key) return;
    videoStepRef.current = key;
    if (currentStep === 1) onReplayCue();
    else onStopVideo?.();
    // onReplayCue / onStopVideo are stable side-effects; we intentionally only
    // re-run on a real step/anchor transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, currentAnchorIdx]);

  const replaySpoken = () => {
    if (!spokenLine) return;
    lastSpokenRef.current = ""; // allow re-speak of the same line
    void ttsSpeak(spokenLine, {
      onStart: () => {
        setSpeaking(true);
        setPaused(false);
      },
      onEnd: () => {
        setSpeaking(false);
        setPaused(false);
      },
    });
  };

  // Pause / resume the CURRENT utterance in place (not a restart).
  const togglePauseResume = () => {
    if (paused) {
      ttsResume();
      setPaused(false);
    } else {
      ttsPause();
      setPaused(true);
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    setTtsEnabled(!next);
    if (next) {
      ttsCancel();
      setSpeaking(false);
      setPaused(false);
    }
  };

  return (
    <div className={`${TUTOR_CARD} w-full max-w-[640px] p-7`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className={TUTOR_EYEBROW}>
            教学点 {currentAnchorIdx + 1} / {totalAnchors}
          </span>
          <span className="text-sm text-zinc-400 truncate">{anchor?.topic}</span>
        </div>
        {/* Transport: rate slider + pause/resume + replay + mute. */}
        <div className="flex items-center gap-2 shrink-0">
          {!muted && (
            <div className="flex items-center gap-1.5" title="语速">
              <input
                type="range"
                min={TTS_RATE_MIN}
                max={TTS_RATE_MAX}
                step={0.02}
                value={rate}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setRate(v);
                  ttsSetRate(v); // live: retunes the playing audio in place
                }}
                className="w-20 accent-blue-500 cursor-pointer"
                aria-label="语速"
              />
              <span className="text-[10px] text-zinc-500 tabular-nums w-8">
                {rate.toFixed(2)}x
              </span>
            </div>
          )}
          {!muted && speaking ? (
            <button
              type="button"
              onClick={togglePauseResume}
              title={paused ? "继续" : "暂停"}
              className={ICON_BTN}
            >
              {paused ? (
                <Play size={15} className="text-blue-400" />
              ) : (
                <Pause size={15} className="text-blue-400" />
              )}
            </button>
          ) : null}
          {!muted && spokenLine ? (
            <button
              type="button"
              onClick={replaySpoken}
              title="重读"
              className={ICON_BTN}
            >
              <RotateCcw size={15} className={speaking && !paused ? "text-blue-400" : ""} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={toggleMute}
            title={muted ? "开启朗读" : "静音"}
            className={ICON_BTN}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} className={speaking ? "text-blue-400" : ""} />}
          </button>
        </div>
      </div>

      {/* Voice combo: one Chinese + one English voice. Mixed lines read each
          language's runs in its own voice (a lone English voice skips Chinese). */}
      {!muted && (
        <div className="flex items-center gap-3 mb-5 text-[11px]">
          <span className="text-zinc-500 shrink-0">朗读音色</span>
          <label className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="text-zinc-400 shrink-0">中文</span>
            <select
              value={voiceZh}
              onChange={(e) => {
                const v = e.target.value;
                setVoiceZh(v);
                setTtsVoiceZh(v);
                replaySpoken();
              }}
              title="中文朗读音色"
              aria-label="中文语音"
              className="min-w-0 flex-1 bg-zinc-800/80 text-zinc-200 rounded-md px-1.5 py-1 border border-zinc-700/70 focus:outline-none focus:border-blue-500/60 cursor-pointer"
            >
              {EDGE_VOICE_GROUPS.filter((g) => g.lang === "zh").map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="text-zinc-400 shrink-0">英文</span>
            <select
              value={voiceEn}
              onChange={(e) => {
                const v = e.target.value;
                setVoiceEn(v);
                setTtsVoiceEn(v);
                replaySpoken();
              }}
              title="英文朗读音色"
              aria-label="英文语音"
              className="min-w-0 flex-1 bg-zinc-800/80 text-zinc-200 rounded-md px-1.5 py-1 border border-zinc-700/70 focus:outline-none focus:border-blue-500/60 cursor-pointer"
            >
              {EDGE_VOICE_GROUPS.filter((g) => g.lang === "en").map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
      )}

      {currentStep === 1 && (
        <div className="space-y-5">
          <p className="text-[15px] text-zinc-300 leading-relaxed">
            先听这一句，试着理解它在说什么。
          </p>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onReplayCue} className={BTN_SUBTLE}>
              <span className="inline-flex items-center gap-1.5">
                <Play size={13} /> 重听原句
              </span>
            </button>
            <button type="button" onClick={onContinue} className={BTN_PRIMARY}>
              我准备好了
            </button>
          </div>
        </div>
      )}

      {currentStep === 2 && (
        <div className="space-y-5">
          {currentExplainText ? (
            <div className="text-[15px] text-zinc-200 leading-7">
              <MarkdownText text={currentExplainText} />
            </div>
          ) : (
            <div className="text-[15px] text-zinc-600">老师正在讲解…</div>
          )}
          {currentExplainText && (
            <div className="flex justify-end">
              <button type="button" onClick={onContinue} className={BTN_PRIMARY}>
                下一步
              </button>
            </div>
          )}
        </div>
      )}

      {currentStep === 3 && currentQuestion && (
        <div className="space-y-4">
          <div className={TUTOR_EYEBROW}>提问</div>
          <div className="text-[15px] text-zinc-100 leading-relaxed">
            <MarkdownText text={currentQuestion.question} />
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="用英文作答…"
            rows={3}
            className={TUTOR_TEXTAREA}
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (draft.trim().length === 0) return;
                const answer = draft;
                setDraft("");
                onSubmitAnswer(answer);
              }}
              disabled={draft.trim().length === 0}
              className={BTN_PRIMARY}
            >
              提交答案
            </button>
          </div>
        </div>
      )}

      {currentStep === 5 && currentFeedback && (
        <div className="space-y-4">
          <div
            className={
              "text-sm font-medium " +
              (currentFeedback.verdict === "correct"
                ? "text-emerald-400"
                : currentFeedback.verdict === "partial"
                  ? "text-amber-400"
                  : "text-rose-400")
            }
          >
            {currentFeedback.verdict === "correct"
              ? "✓ 答对了"
              : currentFeedback.verdict === "partial"
                ? "≈ 基本正确"
                : "✗ 还差一点"}
          </div>
          <div className="text-[15px] text-zinc-200 leading-7">
            <MarkdownText text={currentFeedback.feedback} />
          </div>
          {answerRevealed && currentQuestion && (
            <div className={`${TUTOR_INSET} p-3`}>
              <div className={`${TUTOR_EYEBROW} mb-1.5`}>参考答案</div>
              <div className="text-sm text-zinc-300">
                {currentQuestion.expectedAnswer}
              </div>
            </div>
          )}
          <div className="flex gap-2 justify-end">
            {canRetry && (
              <button type="button" onClick={onRetry} className={BTN_SUBTLE}>
                再试一次
              </button>
            )}
            <button type="button" onClick={onContinue} className={BTN_PRIMARY}>
              {runtime.hasNextAnchor() ? "下一个教学点" : "结课"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
