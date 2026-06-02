import { useState } from "react";
import type { RoleplayRuntime } from "../../tutor/roleplayRuntime";
import { LessonOverlay } from "./LessonOverlay";
import { TUTOR_CARD, TUTOR_EYEBROW, TUTOR_TEXTAREA, BTN_PRIMARY } from "./styles";
import { VoiceDictationButton } from "../voice/VoiceDictationButton";

interface Props {
  runtime: RoleplayRuntime;
  onFinishAndReport: () => void;
  onClose: () => void;
}

export function RoleplayOverlay({ runtime, onFinishAndReport, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const [version, setVersion] = useState(0);

  return (
    <LessonOverlay open={true} onClose={onClose}>
      <div className={`${TUTOR_CARD} w-full max-w-[640px] h-[80vh] flex flex-col p-6`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3 pb-3 border-b border-zinc-800">
          <div>
            <div className={TUTOR_EYEBROW}>角色扮演</div>
            <div className="text-sm text-zinc-200 mt-1">
              你: {runtime.state.scenario.userRole} · 我: {runtime.state.scenario.agentRole}
            </div>
          </div>
          <button
            type="button"
            onClick={onFinishAndReport}
            className="px-3 py-1.5 rounded text-xs bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
          >
            结束并复盘
          </button>
        </div>

        {/* Turn list */}
        <div className="flex-1 overflow-y-auto space-y-3 mb-3">
          {runtime.state.turns.map((t, i) => (
            <div
              key={i}
              className={t.role === "user" ? "flex justify-end" : "flex justify-start"}
            >
              <div
                className={
                  "max-w-[80%] rounded-lg px-3 py-2 text-sm " +
                  (t.role === "user"
                    ? "bg-blue-500/20 text-blue-100"
                    : "bg-zinc-800 text-zinc-100")
                }
              >
                {t.text}
              </div>
            </div>
          ))}
          {runtime.state.loading && (
            <div className="text-xs text-zinc-500 italic">对方正在打字…</div>
          )}
        </div>

        {/* Input row */}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder="用英文回复…（也可点麦克风语音回复）"
            className={`flex-1 ${TUTOR_TEXTAREA}`}
          />
          <VoiceDictationButton
            disabled={runtime.state.loading}
            onText={(t) => setDraft((d) => (d.trim() ? `${d.trim()} ${t}` : t))}
          />
          <button
            type="button"
            disabled={draft.trim().length === 0 || runtime.state.loading}
            onClick={async () => {
              const text = draft.trim();
              setDraft("");
              await runtime.submitUserMessage(text);
              setVersion((v) => v + 1);
            }}
            className={BTN_PRIMARY}
          >
            说完了
          </button>
        </div>

        {/* Hidden version anchor ensures React sees state changes after
            imperative runtime mutations. */}
        <div className="hidden">{version}</div>

        {/* Turn counter */}
        <div className="text-xs text-zinc-600 mt-1">
          {runtime.userTurnCount()} / 20 轮
        </div>
      </div>
    </LessonOverlay>
  );
}
