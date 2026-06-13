import { openUrl } from "@tauri-apps/plugin-opener";
import type { AssistantBlock, AssistantMessage } from "../../types/agent";
import { ToolCallCard } from "./ToolCallCard";
import { MarkdownText } from "./markdown";
import whatsubIcon from "../../assets/whatsub-icon.png";

/** Desktop Pro subscription card (main site, not the iOS-only /mobile page). */
const SUBSCRIBE_URL = "https://whatsub.eversay.cc/#pro";

interface Props {
  msg: AssistantMessage;
  /** True if this message is still streaming (last assistant of the conversation, runtime in flight). */
  streaming?: boolean;
  /** True while the runtime turn is in flight (incl. AFTER this message finished
   *  streaming, while its tool_calls are executing). Lets a tool_call card show
   *  a running spinner during execution instead of a static "准备调用". */
  turnInFlight?: boolean;
  /** False when this assistant message is a CONTINUATION of the same turn (an
   *  earlier assistant message in this turn already drew the avatar). Renders a
   *  spacer in the avatar column so the whole tool-using answer reads under one
   *  avatar instead of stacking a new one per ReAct iteration. */
  showAvatar?: boolean;
}

/** Index of the last text block, or -1 if none. */
function lastTextBlockIdx(blocks: AssistantBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === "text") return i;
  }
  return -1;
}

/**
 * Claude.ai-inspired assistant row: small whatsub avatar at left, flat text body
 * (no bubble, no border). Tool calls are sub-rows in the same column.
 */
export function AssistantBubble({ msg, streaming, turnInFlight, showAvatar = true }: Props) {
  const lastText = lastTextBlockIdx(msg.blocks);
  return (
    <div className={`flex gap-3 px-4 ${showAvatar ? "mb-4" : "mb-2"}`}>
      <div className="shrink-0 mt-0.5">
        {showAvatar ? (
          <div className="h-6 w-6 grid place-items-center rounded-full ring-1 ring-zinc-700 bg-zinc-900 overflow-hidden">
            <img src={whatsubIcon} alt="" width={20} height={20} className="rounded-full" draggable={false} />
          </div>
        ) : (
          <div className="h-6 w-6" aria-hidden />
        )}
      </div>
      <div className="flex-1 min-w-0 text-[14px] text-zinc-100 leading-relaxed space-y-2">
        {msg.blocks.map((b, i) => {
          if (b.type === "text") {
            return (
              <MarkdownText
                key={i}
                text={b.text}
                withCursor={!!streaming && i === lastText}
              />
            );
          }
          return (
            <ToolCallCard
              key={i}
              callBlock={b}
              parentStreaming={!!streaming}
              turnInFlight={!!turnInFlight}
            />
          );
        })}
        {msg.stopReason === "error" && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-rose-400">{msg.errorText ?? "连接中断"}</span>
            {msg.errorUpsell && (
              <button
                type="button"
                onClick={() => void openUrl(SUBSCRIBE_URL).catch(() => {})}
                className="px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-400 text-zinc-900 font-medium text-xs transition-colors whitespace-nowrap"
              >
                升级 Pro
              </button>
            )}
          </div>
        )}
        {msg.stopReason === "cancelled" && (
          <div className="text-xs text-zinc-500">已停止</div>
        )}
      </div>
    </div>
  );
}
