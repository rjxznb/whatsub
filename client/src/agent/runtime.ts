// src/agent/runtime.ts
//
// AgentRuntime — single-entry ReAct loop. Drives provider.streamWithTools,
// accumulates streaming events into AssistantMessage blocks, executes the
// resulting tool_calls through ConfirmationGate + the in-registry tool
// executors, persists ToolMessages back into history, and re-invokes the
// provider until stop_reason==="end_turn" / "max_tokens" / "error" /
// "cancelled" or the per-turn 5-tool cap kicks in.
//
// Spec references:
//   §2.4 (ReAct vs Plan-then-Execute) — outer loop shape.
//   §6.9 (Single agent turn state machine) — exact ordering of phases.
//   §7.1 (Static identity block) — STATIC_SYSTEM_PROMPT below, verbatim.
//   §7.2 (Dynamic context block via ContextBuilder) — appended each turn.
//   §8 (Error handling) — all 10 categories handled below; see inline notes.
//
// Confirmation contract:
//   opts.confirm(toolDef, args, tier) returns "yes" | "no_user_clicked" |
//   "no_panel_closed". The third one is the user closing the chat panel
//   while a confirmation card is pending; per §6.4 / §1.2 that terminates
//   the WHOLE turn immediately (the user is gone, don't keep generating).
//
// Cancellation contract:
//   opts.signal aborting mid-tool yields a ToolMessage with
//   status="cancelled_by_user" and confirmDecision left undefined — the
//   caller (App.tsx wiring in T26) can post-process to distinguish a stop
//   click from a panel close. The runtime itself only knows the signal
//   aborted; it does not differentiate the two.

import Ajv, { type ValidateFunction } from "ajv";
import type { AgentEvent, ToolDef, ExecuteContext, PageContext } from "./types";
import type {
  Message,
  AssistantMessage,
  ToolMessage,
  AssistantBlock,
  UserMessage,
} from "../types/agent";
import { getTool, listTools } from "./registry";
import { ConfirmationGate } from "./gate";
import { snapshot, render } from "./context";
import { prepareWireHistory, modelContextBudget } from "./history";

// Spec §7.1: identity block, plus a private-tutor responsibility section.
const STATIC_SYSTEM_PROMPT = `你是 whatsub Agent —— whatsub 桌面 app 的内置 AI 私教。
默认用中文回答；用户明确要求英文，或讨论英文细节时（如发音、用法）才用英文。

⟨能力边界⟩
你可以：导航、查公共语料、管理库与生词本、触发精讲/角色扮演/专项练习、读学习档案、按薄弱点推荐复习片段。
你不能：导出文件、改 LLM 配置、动登录与许可证、上网、直接改字幕文本。
碰到能力外的请求，告诉用户该去 app 哪个地方手动操作。

⟨私教职责⟩
你不是只会调工具的助手，你是记得住学生的私教：
• 系统上下文里若给了「薄弱点: …×N」，那是这位学生反复犯错的 pattern。聊到学习、复习、
  "我哪儿弱"、"练点什么" 时，主动把它点出来，别等用户自己说。
• 要推荐复习时，调 recommend_review —— 它会把学生过去真实犯错的位置定位回「具体视频 + 几分几秒
  的那句」。把结果用人话讲出来（哪个视频、几分几秒、当时错在哪），再用 open_video(videoId, atSec)
  带他跳过去；或建议 start_remediation 做 3 分钟专项。
• 没有薄弱点数据时（新用户），引导他先开一节精讲或角色扮演，你才有据可依 —— 别瞎编弱项。
• 推荐要具体、可执行（"去看 X 的 2:15"），不要泛泛而谈（"多练过去式"）。

⟨行为约束⟩
1. 简洁。两句能说清就别说五句。
2. 用户表达模糊时，先调 list_library / corpus_browse / list_vocab 查实际状态，再回答。
   别基于自己的猜想说"你库里应该有 X"。
3. 工具有风险等级：
   • LOW (查、跳转、解释)：直接调，无需确认。
   • MID (加/删/同步)：app 会弹"内联确认卡"，调用前在文本里一句话说明你要做什么，
     让用户知道在确认什么。卡片本身的取消/确认按钮 app 自己渲染，你不要再问"要继续吗?"
   • HIGH (删本地视频、取消云同步、重新解析视频)：app 会弹系统模态对话框。同上，调用前一句话说明。
4. 工具失败时读错误信息再决定：重试 / 换参数 / 改问用户。绝不盲目用同样参数重试。
5. 用户请求不需要任何工具（如"这个英语短语什么意思"、"解释一下连读"），直接回答即可。
6. 一次响应里串调到 3 个工具还没收敛就停下来问用户，别无脑链式调用。
7. 如果不需要工具，直接回答用户，不要硬塞一个工具调用进去。`;

const REACT_TOOL_CAP = 5;
const SINGLE_TOOL_TIMEOUT_MS = 60_000;

export interface RunTurnProvider {
  streamWithTools: (opts: {
    systemPrompt: string;
    history: Message[];
    tools: ToolDef[];
    signal: AbortSignal;
  }) => AsyncGenerator<AgentEvent>;
}

export type ConfirmDecision = "yes" | "no_user_clicked" | "no_panel_closed";

export interface RunTurnOpts {
  /** Conversation history (everything that came before this turn). */
  history: Message[];
  /** The brand-new user message about to be processed; appended to history. */
  userMessage: UserMessage;
  /** Provider with streamWithTools (vendor adapter). */
  provider: RunTurnProvider;
  /** Vendor + model name for tagging the emitted AssistantMessage. */
  vendor: string;
  model: string;
  /** Page context used to filter available tools per turn. */
  page: PageContext;
  /** AbortSignal scoped to the whole turn (panel close OR user stop). */
  signal: AbortSignal;
  /** Resolves confirmation UI: "yes" → execute, "no_user_clicked" → record
   *  cancelled + continue, "no_panel_closed" → record cancelled + end turn. */
  confirm: (
    toolDef: ToolDef,
    args: unknown,
    tier: "MID" | "HIGH",
  ) => Promise<ConfirmDecision>;
  /** Fired for every finalized message (user, assistant, tool). UI mirrors. */
  onMessage: (msg: Message) => void;
  /** Fired on every text delta inside an assistant message — used by the UI
   *  to stream the in-flight bubble character-by-character. */
  onAssistantTextDelta: (msgId: string, delta: string) => void;
}

export async function runTurn(opts: RunTurnOpts): Promise<void> {
  // The user message itself is part of the turn record; emit immediately so
  // the UI can show "user said X" before the LLM stream starts.
  opts.onMessage(opts.userMessage);

  if (opts.signal.aborted) return;

  // Build system prompt ONCE per turn: static identity + dynamic context.
  // §7.2 — page state, library, vocab, llm identity all baked in.
  let dynamicCtx = "";
  try {
    dynamicCtx = render(snapshot());
  } catch {
    // If a store is uninitialised (e.g. in a non-browser host), the snapshot
    // helpers throw — degrade to identity-only rather than blocking the turn.
    dynamicCtx = "";
  }
  const systemPrompt = dynamicCtx
    ? `${STATIC_SYSTEM_PROMPT}\n\n${dynamicCtx}`
    : STATIC_SYSTEM_PROMPT;

  // Ajv instance is per-turn; validators are memoised per tool below so we
  // don't recompile schemas across iterations of the outer loop.
  const ajv = new Ajv({ allErrors: true });
  const validatorCache = new Map<string, ValidateFunction>();
  const getValidator = (tool: ToolDef): ValidateFunction => {
    let v = validatorCache.get(tool.id);
    if (!v) {
      v = ajv.compile(tool.parameters as unknown as object);
      validatorCache.set(tool.id, v);
    }
    return v;
  };

  // workingHistory is the message stream we feed the provider every iteration
  // of the outer loop — grows by 1 assistant + N tool messages each pass.
  let workingHistory: Message[] = [...opts.history, opts.userMessage];

  // Total executed/attempted tool calls THIS TURN — across all ReAct
  // iterations, not per-iteration. Hitting this cap injects an error
  // ToolMessage explaining why we stopped, then finalizes the turn.
  let toolCallsThisTurn = 0;

  // ReAct outer loop — each iteration = one LLM call.
  while (true) {
    if (opts.signal.aborted) return;

    const tools = listTools(opts.page);
    // Reduce the history actually sent to the LLM (store keeps the full copy):
    // fold past-turn large tool results + drop oldest messages if we'd blow the
    // model's context budget. See agent/history.ts.
    const wireHistory = prepareWireHistory(
      workingHistory,
      modelContextBudget(opts.model),
    );
    const events = opts.provider.streamWithTools({
      systemPrompt,
      history: wireHistory,
      tools,
      signal: opts.signal,
    });

    // Assemble the AssistantMessage block-by-block as events arrive.
    const assistantMsg: AssistantMessage = {
      role: "assistant",
      id: genMsgId(),
      ts: Date.now(),
      blocks: [],
      stopReason: "end_turn",
      vendor: opts.vendor,
      model: opts.model,
    };
    let currentTextBlockIdx: number | null = null;
    const toolAccumulators = new Map<string, { name: string; argsBuf: string }>();
    let stopReason: AssistantMessage["stopReason"] = "end_turn";

    for await (const ev of events) {
      // Abort check is INSIDE the for-await so a signal flipped between
      // yields short-circuits the next event (per spec §8.6).
      if (opts.signal.aborted) {
        stopReason = "cancelled";
        break;
      }
      if (ev.type === "text") {
        if (currentTextBlockIdx == null) {
          currentTextBlockIdx = assistantMsg.blocks.length;
          assistantMsg.blocks.push({ type: "text", text: "" });
        }
        const blk = assistantMsg.blocks[currentTextBlockIdx] as Extract<
          AssistantBlock,
          { type: "text" }
        >;
        blk.text += ev.delta;
        opts.onAssistantTextDelta(assistantMsg.id, ev.delta);
      } else if (ev.type === "tool_call_start") {
        currentTextBlockIdx = null;
        toolAccumulators.set(ev.callId, { name: ev.name, argsBuf: "" });
      } else if (ev.type === "tool_call_args") {
        const acc = toolAccumulators.get(ev.callId);
        if (acc) acc.argsBuf += ev.deltaJson;
      } else if (ev.type === "tool_call_end") {
        const acc = toolAccumulators.get(ev.callId);
        if (!acc) continue;
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(acc.argsBuf.length ? acc.argsBuf : "{}");
        } catch {
          // Args buffer was malformed JSON. We still push the tool_call
          // block; ajv validation downstream will surface a sensible error.
          parsedArgs = {};
        }
        assistantMsg.blocks.push({
          type: "tool_call",
          callId: ev.callId,
          name: acc.name,
          args: parsedArgs,
        });
      } else if (ev.type === "stop_reason") {
        // Map provider's stop reason. "tool_use" means the model wants the
        // runtime to execute tool_calls and re-invoke; everything else is
        // terminal for this turn.
        if (ev.reason === "tool_use") stopReason = "tool_use";
        else if (ev.reason === "max_tokens") stopReason = "max_tokens";
        else stopReason = "end_turn";
      } else if (ev.type === "error") {
        // Spec §8.10 / §8.4 — adapter-level error (malformed response OR a
        // whatSub relay rejection carrying friendly copy). Mark error, keep
        // the message so AssistantBubble shows it instead of "连接中断".
        stopReason = "error";
        if (ev.message) assistantMsg.errorText = ev.message;
      }
    }

    assistantMsg.stopReason = stopReason;
    opts.onMessage(assistantMsg);
    workingHistory = [...workingHistory, assistantMsg];

    // Terminal states — turn ends here.
    if (stopReason !== "tool_use") return;

    // — Execute the tool_calls we collected this iteration. —
    const calls = assistantMsg.blocks.filter(
      (b): b is Extract<AssistantBlock, { type: "tool_call" }> => b.type === "tool_call",
    );

    for (const call of calls) {
      if (opts.signal.aborted) return;

      toolCallsThisTurn++;
      if (toolCallsThisTurn > REACT_TOOL_CAP) {
        // §6.9 — synthesize an error ToolMessage explaining the cap and
        // finalize the turn so the LLM doesn't keep grinding away.
        const msg: ToolMessage = {
          role: "tool",
          id: genMsgId(),
          ts: Date.now(),
          callId: call.callId,
          name: call.name,
          status: "error",
          errorMessage: `已达本轮工具调用上限 (${REACT_TOOL_CAP})，请用户补充信息后继续。`,
          durationMs: 0,
        };
        opts.onMessage(msg);
        workingHistory = [...workingHistory, msg];
        return;
      }

      const tool = getTool(call.name);
      if (!tool) {
        // §8.2 — unknown tool. LLM will see the error and recover next turn.
        const msg: ToolMessage = {
          role: "tool",
          id: genMsgId(),
          ts: Date.now(),
          callId: call.callId,
          name: call.name,
          status: "error",
          errorMessage: `Unknown tool: ${call.name}. Available tools listed in system prompt.`,
          durationMs: 0,
        };
        opts.onMessage(msg);
        workingHistory = [...workingHistory, msg];
        continue;
      }

      // §8.3 — Args schema validation via ajv. Failure feeds error back as a
      // ToolMessage so the LLM can retry with corrected args on the next pass.
      const validate = getValidator(tool);
      if (!validate(call.args)) {
        const errs = (validate.errors ?? [])
          .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
          .join("; ");
        const msg: ToolMessage = {
          role: "tool",
          id: genMsgId(),
          ts: Date.now(),
          callId: call.callId,
          name: call.name,
          status: "error",
          errorMessage: `Invalid args for ${call.name}: ${errs}`,
          durationMs: 0,
        };
        opts.onMessage(msg);
        workingHistory = [...workingHistory, msg];
        continue;
      }

      // §6.9 — confirmation gate routing.
      const tier = ConfirmationGate.classify(tool, call.args);
      let confirmDecision: ToolMessage["confirmDecision"] = "auto";
      if (tier === "MID" || tier === "HIGH") {
        let decision: ConfirmDecision;
        try {
          decision = await opts.confirm(tool, call.args, tier);
        } catch {
          // The caller's confirm() rejected — treat as panel-close / cancel
          // semantics: terminate turn cleanly.
          return;
        }
        if (decision === "no_panel_closed") {
          const msg: ToolMessage = {
            role: "tool",
            id: genMsgId(),
            ts: Date.now(),
            callId: call.callId,
            name: call.name,
            status: "cancelled_by_user",
            confirmDecision: "panel_closed",
            durationMs: 0,
          };
          opts.onMessage(msg);
          workingHistory = [...workingHistory, msg];
          // §6.4 / §1.2 — panel close ends the whole turn; user is gone.
          return;
        }
        if (decision === "no_user_clicked") {
          const msg: ToolMessage = {
            role: "tool",
            id: genMsgId(),
            ts: Date.now(),
            callId: call.callId,
            name: call.name,
            status: "cancelled_by_user",
            confirmDecision: tier === "MID" ? "inline_no" : "modal_no",
            durationMs: 0,
          };
          opts.onMessage(msg);
          workingHistory = [...workingHistory, msg];
          continue;
        }
        confirmDecision = tier === "MID" ? "inline_yes" : "modal_yes";
      }

      // — Execute with a 60s wall-clock timeout (§8.7). The tool's own
      //   AbortSignal mirrors the turn's so network-aware tools (sync,
      //   yt-dlp) drop cleanly when the user stops. —
      const startTs = Date.now();
      const execCtx: ExecuteContext = { signal: opts.signal };
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const result = await Promise.race([
          tool.execute(call.args, execCtx),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Tool ${call.name} timed out after 60s`)),
              SINGLE_TOOL_TIMEOUT_MS,
            );
          }),
        ]);
        if (timer) clearTimeout(timer);

        // §8.6 — if signal aborted mid-execute, downgrade to cancelled.
        if (opts.signal.aborted) {
          const msg: ToolMessage = {
            role: "tool",
            id: genMsgId(),
            ts: Date.now(),
            callId: call.callId,
            name: call.name,
            status: "cancelled_by_user",
            // Deliberately left undefined: caller distinguishes "stop click"
            // from "panel close" via its own outer state.
            confirmDecision: undefined,
            durationMs: Date.now() - startTs,
          };
          opts.onMessage(msg);
          workingHistory = [...workingHistory, msg];
          return;
        }

        const msg: ToolMessage = {
          role: "tool",
          id: genMsgId(),
          ts: Date.now(),
          callId: call.callId,
          name: call.name,
          status: "ok",
          result: safeSerialize(result),
          durationMs: Date.now() - startTs,
          confirmDecision,
        };
        opts.onMessage(msg);
        workingHistory = [...workingHistory, msg];
      } catch (err) {
        if (timer) clearTimeout(timer);
        // §8.1 — tool execution failure. Propagate raw error string to the
        // LLM verbatim (no Chinese translation — LLMs handle the structured
        // Rust error tags better than rewritten copy).
        const errorMessage = String(err instanceof Error ? err.message : err);
        const msg: ToolMessage = {
          role: "tool",
          id: genMsgId(),
          ts: Date.now(),
          callId: call.callId,
          name: call.name,
          status: "error",
          errorMessage,
          durationMs: Date.now() - startTs,
          confirmDecision,
        };
        opts.onMessage(msg);
        workingHistory = [...workingHistory, msg];
      }
    }
    // Outer loop continues — re-invoke provider with the new tool messages
    // appended so it can decide its next move.
  }
}

// — Helpers —

/** §8.9 — never throw back to the runtime. Coerce non-JSON-clean values to
 *  a string so the LLM always sees something for its tool result. */
function safeSerialize(v: unknown): unknown {
  try {
    JSON.parse(JSON.stringify(v));
    return v;
  } catch {
    return String(v);
  }
}

function genMsgId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
