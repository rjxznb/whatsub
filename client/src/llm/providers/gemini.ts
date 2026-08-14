import type {
  AgentProvider,
  Provider,
  ProviderRequest,
  StreamWithToolsOpts,
} from "./types";
import type { Settings } from "../../types/settings";
import type { AgentEvent } from "../../agent/types";
import type { Message, ToolMessage } from "../../types/agent";
// Rust-side fetch (plugin-http) — bypasses the WebView CSP/CORS so the packaged
// app can reach generativelanguage.googleapis.com (same as the Claude provider).
import { fetch } from "@tauri-apps/plugin-http";
import {
  isAbortError,
  providerHttpErrorFromResponse,
  ProviderProtocolError,
  ProviderTransportError,
} from "./errors";

export function createGeminiProvider(settings: Settings): Provider & AgentProvider {
  const cfg = settings.gemini;
  return {
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent` +
        `?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;

      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: req.systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: req.userPrompt }] }],
          }),
          signal: req.signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ProviderTransportError("Gemini request failed", "send", { cause: error });
      }
      if (!resp.ok) throw await providerHttpErrorFromResponse("Gemini API", resp);
      if (!resp.body) throw new ProviderProtocolError("Gemini response body missing");
      try {
        yield* parseTextStream(resp.body);
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ProviderTransportError("Gemini response read failed", "read", { cause: error });
      }
    },

    async *streamWithTools(
      opts: StreamWithToolsOpts,
    ): AsyncGenerator<AgentEvent> {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent` +
        `?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;
      const body = {
        systemInstruction: { parts: [{ text: opts.systemPrompt }] },
        contents: formatHistory(opts.history),
        tools: [
          {
            functionDeclarations: opts.tools.map((t) => ({
              name: t.id,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ],
      };
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!resp.ok || !resp.body) {
        yield {
          type: "error",
          message: `Gemini API ${resp.status}: ${
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
      yield* parseGeminiStream(raw());
    },
  };
}

/**
 * Parses a Gemini-shape SSE stream into AgentEvent. Exported as a top-level
 * function so tests can drive it with a hand-rolled async generator without
 * mocking fetch.
 *
 * Gemini's SSE shape is one `data: {...json...}` per chunk (no `event:`
 * lines). Each chunk's `candidates[0].content.parts[]` may contain:
 *   - `{ text: "..." }` — concatenate as text deltas across chunks.
 *   - `{ functionCall: { name, args } }` — args arrive ATOMIC (one structured
 *     object, not delta-streamed). For each functionCall part we emit all
 *     three events together: tool_call_start + tool_call_args (stringified) +
 *     tool_call_end. callId is synthesized as `<name>_<counter>` because
 *     Gemini doesn't ship one.
 *
 * `finishReason` mapping is contextual:
 *   - STOP → tool_use if any functionCall was emitted in this stream, else
 *     end_turn.
 *   - MAX_TOKENS → max_tokens.
 *   - anything else (SAFETY, OTHER, etc.) → end_turn for v1.
 */
export async function* parseGeminiStream(
  source: AsyncIterable<string>,
): AsyncGenerator<AgentEvent> {
  let buf = "";
  let toolCallCounter = 0;
  let sawFunctionCall = false;

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
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const candidate = parsed?.candidates?.[0];
      const parts: any[] = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part?.text === "string" && part.text.length > 0) {
          yield { type: "text", delta: part.text };
        } else if (part?.functionCall && typeof part.functionCall.name === "string") {
          sawFunctionCall = true;
          const name: string = part.functionCall.name;
          const args = part.functionCall.args ?? {};
          const callId = `${name}_${++toolCallCounter}`;
          yield { type: "tool_call_start", callId, name };
          yield {
            type: "tool_call_args",
            callId,
            deltaJson: JSON.stringify(args),
          };
          yield { type: "tool_call_end", callId };
        }
      }
      const finishReason: string | undefined = candidate?.finishReason;
      if (finishReason) {
        const reason: "end_turn" | "tool_use" | "max_tokens" =
          finishReason === "MAX_TOKENS"
            ? "max_tokens"
            : finishReason === "STOP" && sawFunctionCall
              ? "tool_use"
              : "end_turn";
        yield { type: "stop_reason", reason };
      }
    }
  }
}

/**
 * Converts our internal Message[] history into Gemini's contents format.
 *
 * - user → { role: "user", parts: [{text}] }
 * - assistant → { role: "model", parts: [...] } — text blocks become
 *   {text}, tool_call blocks become {functionCall: {name, args}}.
 * - tool → { role: "user", parts: [{functionResponse: {name, response}}] }
 *   Adjacent tool messages merge into a single user message's parts array
 *   (Gemini's convention for batched function responses).
 */
export function formatHistory(history: Message[]): unknown[] {
  const out: Array<{ role: string; parts: unknown[] }> = [];
  for (const msg of history) {
    if (msg.role === "user") {
      out.push({ role: "user", parts: [{ text: msg.content }] });
    } else if (msg.role === "assistant") {
      const parts: unknown[] = [];
      for (const block of msg.blocks) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_call") {
          parts.push({
            functionCall: {
              name: block.name,
              args:
                typeof block.args === "object" && block.args != null
                  ? block.args
                  : {},
            },
          });
        }
      }
      out.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      const tm = msg as ToolMessage;
      const fnResponse = {
        functionResponse: {
          name: tm.name,
          response:
            tm.status === "ok"
              ? { result: tm.result ?? null }
              : { error: tm.errorMessage ?? "tool failed" },
        },
      };
      // Merge into the previous user message if it's already a
      // functionResponse batch — Gemini expects consecutive responses in one
      // user message's parts array.
      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.parts) &&
        last.parts.length > 0 &&
        last.parts.every(
          (p) => typeof p === "object" && p != null && "functionResponse" in (p as object),
        )
      ) {
        last.parts.push(fnResponse);
      } else {
        out.push({ role: "user", parts: [fnResponse] });
      }
    }
  }
  return out;
}

async function* parseTextStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
      try {
        const obj = JSON.parse(payload);
        const text = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text === "string") yield text;
      } catch {
        /* skip */
      }
    }
  }
}
