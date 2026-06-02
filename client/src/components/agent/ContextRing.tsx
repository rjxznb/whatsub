// src/components/agent/ContextRing.tsx
//
// Tiny circular gauge in the input action row showing how full the active
// conversation's context is (estimated tokens / the model's context budget).
// Blue arc fills with usage; at ≥80% it turns amber + shows a "建议开新会话"
// hint. Clicking offers to start a fresh conversation (a full context degrades
// quality — see agent/history.ts which starts dropping oldest messages once the
// budget is exceeded).

import { useMemo } from "react";
import { useAgent } from "../../store/agent";
import { useSettings } from "../../store/settings";
import { getModelName } from "../../llm/llmIdentity";
import { estimateMessagesTokens, modelContextBudget } from "../../agent/history";
import { confirmDialog } from "../../store/appDialog";

const WARN_AT = 0.8;

export function ContextRing() {
  const messages = useAgent((s) => {
    const conv = s.history.conversations.find(
      (c) => c.id === s.history.activeConversationId,
    );
    return conv?.messages;
  });
  const model = useSettings((s) => getModelName(s.settings));

  const ratio = useMemo(() => {
    const used = estimateMessagesTokens(messages ?? []);
    const budget = modelContextBudget(model);
    return budget > 0 ? Math.min(1, used / budget) : 0;
  }, [messages, model]);

  const pct = Math.round(ratio * 100);
  const warn = ratio >= WARN_AT;

  // SVG ring geometry.
  const size = 22;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = c * ratio;
  const arc = warn ? "#f59e0b" : "#3b82f6"; // amber when full, else blue

  const startNew = async () => {
    const ok = await confirmDialog(
      `当前会话上下文已用约 ${pct}%。${
        warn ? "快满了，继续聊下去 AI 容易丢失前面的内容、效果变差。" : ""
      }开一个新会话吗？`,
      { title: "上下文占用", okText: "开新会话", cancelText: "继续当前" },
    );
    if (!ok) return;
    const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
    const id = useAgent.getState().createConversation({ pathname });
    useAgent.getState().switchActive(id);
  };

  return (
    <button
      type="button"
      onClick={startNew}
      title={`上下文占用约 ${pct}%${warn ? " · 建议开新会话" : ""}`}
      aria-label={`上下文占用 ${pct}%`}
      className="group flex h-8 shrink-0 items-center gap-1 rounded-full px-1 text-zinc-400 transition-colors hover:bg-white/5"
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={arc}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          className={warn ? "animate-pulse" : undefined}
        />
      </svg>
      <span className={"text-[10px] tabular-nums " + (warn ? "text-amber-400" : "text-zinc-500 group-hover:text-zinc-300")}>
        {pct}%
      </span>
    </button>
  );
}
