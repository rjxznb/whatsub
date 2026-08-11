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
// invoke is for the whatsub-managed relay's per-request bearer resolution
// (get_session_token / trial_read_state). Tauri core APIs run inside the
// WebView so no plugin-http is needed here.
import { invoke } from "@tauri-apps/api/core";
import { parseRelayError, RelayError } from "./relayErrors";
import {
  isAbortError,
  ProviderHttpError,
  ProviderProtocolError,
  ProviderTransportError,
} from "./errors";
import { inferVendorId } from "../vendors";
import { beginManagedRelayWait } from "../managedQueueStatus";

export function createOpenAICompatibleProvider(
  settings: Settings,
): Provider & AgentProvider {
  const cfg = settings.openaiCompatible;
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");
  const vendorId = inferVendorId(settings.llmProvider, cfg.baseUrl);

  // DeepSeek V4 (deepseek-v4-flash / -pro) defaults thinking mode to ENABLED,
  // so it emits a long reasoning chain before the answer — much slower than the
  // old deepseek-chat (which was the non-thinking alias). Our tasks (精讲 plan /
  // step gen / agent tool-use) are structured, not reasoning-heavy, so disable
  // thinking for DeepSeek to get the old fast behavior back. `thinking` is a
  // DeepSeek-only param — gated by host so it never touches OpenAI/Kimi/etc.
  const isDeepSeek = /(?:\/\/|\.)deepseek\.com\b/i.test(baseUrl);
  const deepseekNoThink = isDeepSeek ? { thinking: { type: "disabled" } } : {};

  // whatSub managed-LLM relay (2026-06-04): detect by host. When active,
  // ignore the configured apiKey and resolve a Bearer at request time
  // from the Tauri side — session token (Pro/Free) first, falls back to
  // the trial token persisted in trial.json (TRIAL_ACTIVE). This makes
  // the "whatsub-managed" vendor preset zero-config: user picks it, no
  // API-key field, the layer below transparently auths each call.
  const isWhatsubRelay = /\bwhatsub\.eversay\.cc\/api\/llm\b/i.test(baseUrl);
  async function resolveAuthHeader(): Promise<string> {
    if (!isWhatsubRelay) return `Bearer ${cfg.apiKey}`;
    try {
      const session = await invoke<string | null>("get_session_token");
      if (session) return `Bearer ${session}`;
    } catch {
      // get_session_token throws when nothing's stored — fall through.
    }
    try {
      // Trial path: pull the trialToken from the local trial.json the
      // license store wrote on /trial/start. Same Rust command that
      // /store/license.ts reads on init.
      const trial = await invoke<{ trialToken?: string } | null>("trial_read_state");
      if (trial?.trialToken) return `Bearer ${trial.trialToken}`;
    } catch {
      // ignore
    }
    // No session, no trial — caller will get a 401 from the relay,
    // which the existing error path translates into the "needs key"
    // upsell. Don't throw here; let the network error surface naturally.
    return "Bearer ";
  }

  async function fetchCompletion(body: unknown, signal?: AbortSignal): Promise<Response> {
    const finishWait = isWhatsubRelay ? beginManagedRelayWait() : null;
    try {
      const authHeader = await resolveAuthHeader();
      try {
        return await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: authHeader,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ProviderTransportError("OpenAI-compatible request failed", "send", {
          cause: error,
        });
      }
    } finally {
      // Response headers mean admission is over. Streaming may continue for a
      // long time, but that is generation rather than queue wait.
      finishWait?.();
    }
  }

  async function throwResponseFailure(resp: Response): Promise<never> {
    let body = "";
    let bodyReadCause: unknown;
    try {
      body = await resp.text();
    } catch (error) {
      if (isAbortError(error)) throw error;
      bodyReadCause = error;
    }
    const retryAfterMs = parseRetryAfter(resp.headers.get("retry-after"));
    if (isWhatsubRelay) {
      const info = parseRelayError(resp.status, body);
      if (info) {
        throw new RelayError(info, resp.status, body, retryAfterMs, {
          cause: bodyReadCause,
        });
      }
    }
    throw new ProviderHttpError(
      `OpenAI-compatible API ${resp.status}: ${body}`,
      resp.status,
      body,
      retryAfterMs,
      { cause: bodyReadCause },
    );
  }

  return {
    ...(vendorId === "deepseek" || vendorId === "whatsub-managed"
      ? { retryProfile: "deepseek-analysis" as const }
      : {}),
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const resp = await fetchCompletion({
        model: cfg.model,
        stream: true,
        messages: [
          { role: "system", content: req.systemPrompt },
          { role: "user", content: req.userPrompt },
        ],
        ...deepseekNoThink,
      }, req.signal);

      if (!resp.ok) {
        await throwResponseFailure(resp);
      }
      if (!resp.body) {
        throw new ProviderProtocolError("response body missing");
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
      const resp = await fetchCompletion(body, opts.signal);
      if (!resp.ok) await throwResponseFailure(resp);
      if (!resp.body) throw new ProviderProtocolError("response body missing");
      const reader = resp.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      async function* raw(): AsyncGenerator<string> {
        while (true) {
          let value: string | undefined;
          let done: boolean;
          try {
            ({ value, done } = await reader.read());
          } catch (error) {
            if (isAbortError(error)) throw error;
            throw new ProviderTransportError("OpenAI-compatible response read failed", "read", {
              cause: error,
            });
          }
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
      } catch (error) {
        throw new ProviderProtocolError("Malformed OpenAI-compatible SSE data", {
          cause: error,
        });
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
        let sawToolCall = false;
        for (const acc of toolCallAccumulator.values()) {
          if (acc.started) {
            sawToolCall = true;
            yield { type: "tool_call_end", callId: acc.id };
          }
        }
        // Map the OpenAI finish_reason. CRITICAL: some OpenAI-compatible
        // providers (DeepSeek, and the whatSub managed relay proxying it)
        // return finish_reason "stop" even when the turn emitted tool_calls.
        // Taking that at face value would map to "end_turn" and the runtime
        // would NEVER execute the tool (it returns when stopReason !=
        // "tool_use") — the agent gets stuck at "准备调用 <tool>" with no
        // loading and no error. So if we saw ANY tool_call this stream, the
        // intent is tool_use regardless of the literal finish_reason (mirrors
        // the Gemini adapter's `STOP && sawFunctionCall → tool_use`).
        const reason: "tool_use" | "max_tokens" | "end_turn" =
          finishReason === "tool_calls" || sawToolCall
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
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      ({ done, value } = await reader.read());
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ProviderTransportError("OpenAI-compatible response read failed", "read", {
        cause: error,
      });
    }
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
      } catch (error) {
        throw new ProviderProtocolError("Malformed OpenAI-compatible SSE data", {
          cause: error,
        });
      }
    }
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

// Silence TS unused-import warnings when only used by types in JSDoc.
export type { AssistantBlock, AssistantMessage };
