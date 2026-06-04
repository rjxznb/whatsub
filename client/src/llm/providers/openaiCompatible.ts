import type {
  AgentProvider,
  Provider,
  ProviderRequest,
  StreamWithToolsOpts,
} from "./types";
import type { Settings } from "../../types/settings";
import type { AgentEvent } from "../../agent/types";
import type {
  AssistantBlock,
  AssistantMessage,
  Message,
  ToolMessage,
} from "../../types/agent";
// Use the Rust-side fetch (plugin-http) instead of the WebView fetch: the
// packaged app's CSP `connect-src` doesn't (and can't, for user-configured
// baseURLs) whitelist arbitrary LLM hosts, so a WebView fetch to e.g.
// api.deepseek.com is blocked with a bare "Failed to fetch". Routing through
// Rust bypasses both the CSP and CORS (same as the Claude provider).
import { fetch } from "@tauri-apps/plugin-http";

export function createOpenAICompatibleProvider(
  settings: Settings,
): Provider & AgentProvider {
  const cfg = settings.openaiCompatible;
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");

  // DeepSeek V4 (deepseek-v4-flash / -pro) defaults thinking mode to ENABLED,
  // so it emits a long reasoning chain before the answer — much slower than the
  // old deepseek-chat (which was the non-thinking alias). Our tasks (精讲 plan /
  // step gen / agent tool-use) are structured, not reasoning-heavy, so disable
  // thinking for DeepSeek to get the old fast behavior back. `thinking` is a
  // DeepSeek-only param — gated by host so it never touches OpenAI/Kimi/etc.
  const isDeepSeek = /(?:\/\/|\.)deepseek\.com\b/i.test(baseUrl);
  const deepseekNoThink = isDeepSeek ? { thinking: { type: "disabled" } } : {};

  return {
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          stream: true,
          // Spike instrumentation 2026-06-04: ask DeepSeek to emit a final
          // SSE chunk with prompt/completion token counts so we can measure
          // ¥/video before pricing the upcoming managed-LLM relay. The
          // parser logs each usage chunk with [SPIKE] prefix; grep the
          // devtools console for that to harvest totals. Safe in prod —
          // include_usage is universally supported by openai-compatible
          // providers and only adds one terminal chunk.
          stream_options: { include_usage: true },
          messages: [
            { role: "system", content: req.systemPrompt },
            { role: "user", content: req.userPrompt },
          ],
          ...deepseekNoThink,
        }),
        signal: req.signal,
      });

      if (!resp.ok) {
        throw new Error(`OpenAI-compatible API ${resp.status}: ${await resp.text()}`);
      }
      if (!resp.body) {
        throw new Error("response body missing");
      }

      yield* parseSSEStream(resp.body);
    },

    async *streamWithTools(
      opts: StreamWithToolsOpts,
    ): AsyncGenerator<AgentEvent> {
      const body = {
        model: cfg.model,
        messages: [
          { role: "system", content: opts.systemPrompt },
          ...formatHistory(opts.history),
        ],
        tools: opts.tools.map((t) => ({
          type: "function",
          function: {
            name: t.id,
            description: t.description,
            parameters: t.parameters,
          },
        })),
        stream: true,
        ...deepseekNoThink,
      };
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!resp.ok || !resp.body) {
        yield {
          type: "error",
          message: `OpenAI-compatible API ${resp.status}: ${
            resp.body ? await resp.text() : "no body"
          }`,
        };
        return;
      }
      const reader = resp.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      async function* raw(): AsyncGenerator<string> {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          if (value) yield value;
        }
      }
      yield* parseOpenAIStream(raw());
    },
  };
}

/**
 * Parses an OpenAI-shape SSE stream into AgentEvent. Exported as a top-level
 * function so tests can drive it with a hand-rolled async generator without
 * mocking fetch.
 */
export async function* parseOpenAIStream(
  source: AsyncIterable<string>,
): AsyncGenerator<AgentEvent> {
  let buf = "";
  const toolCallAccumulator = new Map<
    number,
    { id: string; name: string; argsBuf: string; started: boolean }
  >();

  for await (const chunk of source) {
    buf += chunk;
    const lines = buf.split("\n");
    // Last element is the (possibly partial) trailing line — hold it back.
    buf = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = parsed?.choices?.[0];
      const delta = choice?.delta;
      const finishReason = choice?.finish_reason;
      if (delta?.content) {
        yield { type: "text", delta: delta.content as string };
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = typeof tc.index === "number" ? tc.index : 0;
          let acc = toolCallAccumulator.get(idx);
          if (!acc) {
            acc = { id: "", name: "", argsBuf: "", started: false };
            toolCallAccumulator.set(idx, acc);
          }
          if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
          if (typeof tc.function?.name === "string" && tc.function.name) {
            acc.name = tc.function.name;
          }
          const argsDelta: string | undefined =
            tc.function?.arguments != null ? String(tc.function.arguments) : undefined;
          if (argsDelta !== undefined) acc.argsBuf += argsDelta;
          // Emit tool_call_start exactly once per index, as soon as we know
          // both the id and the function name.
          if (!acc.started && acc.id && acc.name) {
            acc.started = true;
            yield { type: "tool_call_start", callId: acc.id, name: acc.name };
          }
          // Forward each arguments delta after start. argsDelta may be ""
          // (the initial slot delta) — we still drop empty strings to keep
          // the stream tidy.
          if (acc.started && argsDelta !== undefined && argsDelta.length > 0) {
            yield {
              type: "tool_call_args",
              callId: acc.id,
              deltaJson: argsDelta,
            };
          }
        }
      }
      if (finishReason) {
        for (const acc of toolCallAccumulator.values()) {
          if (acc.started) {
            yield { type: "tool_call_end", callId: acc.id };
          }
        }
        const reason: "tool_use" | "max_tokens" | "end_turn" =
          finishReason === "tool_calls"
            ? "tool_use"
            : finishReason === "length"
              ? "max_tokens"
              : "end_turn";
        yield { type: "stop_reason", reason };
      }
    }
  }
}

/**
 * Converts our internal Message[] history into OpenAI's chat format.
 *
 * - user → { role: "user", content }
 * - assistant → text blocks concatenated into `content`; tool_call blocks
 *   become OpenAI's `tool_calls` array (with `function.arguments` JSON-stringified).
 * - tool → { role: "tool", tool_call_id, content }
 */
export function formatHistory(history: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of msg.blocks) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_call") {
          toolCalls.push({
            id: block.callId,
            type: "function",
            function: {
              name: block.name,
              arguments:
                typeof block.args === "string"
                  ? block.args
                  : JSON.stringify(block.args ?? {}),
            },
          });
        }
      }
      const assistantOut: Record<string, unknown> = {
        role: "assistant",
        content: textParts.join(""),
      };
      if (toolCalls.length > 0) assistantOut.tool_calls = toolCalls;
      out.push(assistantOut);
    } else if (msg.role === "tool") {
      const tm = msg as ToolMessage;
      const content =
        tm.status === "ok"
          ? JSON.stringify(tm.result ?? null)
          : (tm.errorMessage ?? "tool failed");
      out.push({
        role: "tool",
        tool_call_id: tm.callId,
        content,
      });
    }
  }
  return out;
}

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const obj = JSON.parse(payload);
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") yield delta;
        // Spike instrumentation 2026-06-04: log usage when DeepSeek emits
        // the final usage chunk (response to stream_options.include_usage).
        // Format: [SPIKE] usage prompt=N completion=N total=N model=X
        // Grep devtools console for `[SPIKE]` to harvest. Remove after
        // managed-LLM relay quota numbers are locked in.
        const u = obj?.usage;
        if (u && typeof u.prompt_tokens === "number") {
          // eslint-disable-next-line no-console
          console.log(
            `[SPIKE] usage prompt=${u.prompt_tokens} completion=${u.completion_tokens ?? 0} total=${u.total_tokens ?? (u.prompt_tokens + (u.completion_tokens ?? 0))} model=${obj?.model ?? "?"}`,
          );
        }
      } catch {
        // skip malformed lines
      }
    }
  }
}

// Silence TS unused-import warnings when only used by types in JSDoc.
export type { AssistantBlock, AssistantMessage };
