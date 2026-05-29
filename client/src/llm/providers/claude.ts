import type {
  AgentProvider,
  Provider,
  ProviderRequest,
  StreamWithToolsOpts,
} from "./types";
import type { Settings } from "../../types/settings";
import type { AgentEvent } from "../../agent/types";
import type { Message, ToolMessage } from "../../types/agent";
// Anthropic's API does not send Access-Control-Allow-Origin, so a webview
// fetch() is blocked by CORS. plugin-http issues the request from the Rust
// side (no CORS), and is otherwise a drop-in replacement for window.fetch.
// URL allowlist is in src-tauri/capabilities/default.json.
import { fetch } from "@tauri-apps/plugin-http";

export function createClaudeProvider(settings: Settings): Provider & AgentProvider {
  const cfg = settings.claude;
  return {
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 8192,
          stream: true,
          system: req.systemPrompt,
          messages: [{ role: "user", content: req.userPrompt }],
        }),
        signal: req.signal,
      });

      if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
      if (!resp.body) throw new Error("response body missing");
      yield* parseTextStream(resp.body);
    },

    async *streamWithTools(
      opts: StreamWithToolsOpts,
    ): AsyncGenerator<AgentEvent> {
      const body = {
        model: cfg.model,
        max_tokens: 4096,
        stream: true,
        system: opts.systemPrompt,
        messages: formatHistory(opts.history),
        tools: opts.tools.map((t) => ({
          name: t.id,
          description: t.description,
          input_schema: t.parameters,
        })),
      };
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (!resp.ok || !resp.body) {
        yield {
          type: "error",
          message: `Claude API ${resp.status}: ${
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
      yield* parseClaudeStream(raw());
    },
  };
}

/**
 * Parses a Claude-shape SSE stream into AgentEvent. Exported as a top-level
 * function so tests can drive it with a hand-rolled async generator without
 * mocking fetch.
 *
 * Claude's SSE has `event: <type>` lines BEFORE `data: <json>`, but the data
 * JSON also carries its own `type` field — we discriminate on that and ignore
 * the `event:` lines.
 *
 * Content blocks have an `index`. We track per-index block type (text |
 * tool_use). On a `tool_use` content_block_start we have the id + name
 * atomically (unlike OpenAI which streams them incrementally), so
 * tool_call_start fires immediately. input_json_delta fragments forward as
 * tool_call_args; content_block_stop emits tool_call_end.
 *
 * `message_delta.delta.stop_reason` maps Claude's reason vocabulary into the
 * unified one.
 */
export async function* parseClaudeStream(
  source: AsyncIterable<string>,
): AsyncGenerator<AgentEvent> {
  let buf = "";
  const blocksByIndex = new Map<
    number,
    { type: "text" | "tool_use"; id?: string; name?: string }
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
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const t: string | undefined = parsed?.type;
      if (t === "content_block_start") {
        const idx: number =
          typeof parsed.index === "number" ? parsed.index : 0;
        const block = parsed.content_block ?? {};
        if (block.type === "tool_use") {
          const callId: string = String(block.id ?? "");
          const name: string = String(block.name ?? "");
          blocksByIndex.set(idx, { type: "tool_use", id: callId, name });
          yield { type: "tool_call_start", callId, name };
        } else {
          // "text" (or any other type we treat as text-ish)
          blocksByIndex.set(idx, { type: "text" });
        }
      } else if (t === "content_block_delta") {
        const idx: number =
          typeof parsed.index === "number" ? parsed.index : 0;
        const delta = parsed.delta ?? {};
        const block = blocksByIndex.get(idx);
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          yield { type: "text", delta: delta.text };
        } else if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          block?.type === "tool_use" &&
          block.id
        ) {
          if (delta.partial_json.length > 0) {
            yield {
              type: "tool_call_args",
              callId: block.id,
              deltaJson: delta.partial_json,
            };
          }
        }
      } else if (t === "content_block_stop") {
        const idx: number =
          typeof parsed.index === "number" ? parsed.index : 0;
        const block = blocksByIndex.get(idx);
        if (block?.type === "tool_use" && block.id) {
          yield { type: "tool_call_end", callId: block.id };
        }
      } else if (t === "message_delta") {
        const reasonRaw: string | undefined = parsed?.delta?.stop_reason;
        if (reasonRaw) {
          const reason: "end_turn" | "tool_use" | "max_tokens" =
            reasonRaw === "tool_use"
              ? "tool_use"
              : reasonRaw === "max_tokens"
                ? "max_tokens"
                : "end_turn";
          yield { type: "stop_reason", reason };
        }
      }
      // message_start / message_stop / ping → ignored
    }
  }
}

/**
 * Converts our internal Message[] history into Claude's messages format.
 *
 * - user → { role: "user", content: string }
 * - assistant → { role: "assistant", content: [{type:"text"|"tool_use"}, ...] }
 * - tool → { role: "user", content: [{type:"tool_result", tool_use_id, content}] }
 *
 * Adjacent tool messages are merged into a single user message holding
 * multiple tool_result blocks — Claude expects this shape when an assistant
 * emits multiple tool_use blocks in one turn.
 */
export function formatHistory(history: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const contentBlocks: unknown[] = [];
      for (const block of msg.blocks) {
        if (block.type === "text") {
          contentBlocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_call") {
          contentBlocks.push({
            type: "tool_use",
            id: block.callId,
            name: block.name,
            input:
              typeof block.args === "object" && block.args != null
                ? block.args
                : {},
          });
        }
      }
      out.push({ role: "assistant", content: contentBlocks });
    } else if (msg.role === "tool") {
      const tm = msg as ToolMessage;
      const toolResult = {
        type: "tool_result",
        tool_use_id: tm.callId,
        content:
          tm.status === "ok"
            ? JSON.stringify(tm.result ?? null)
            : (tm.errorMessage ?? "tool failed"),
      };
      // Merge into the previous user message if it's already a tool_result
      // batch — Claude expects consecutive tool results in one user message.
      const last = out[out.length - 1] as
        | { role: string; content: unknown[] }
        | undefined;
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every(
          (b) => typeof b === "object" && (b as any)?.type === "tool_result",
        )
      ) {
        last.content.push(toolResult);
      } else {
        out.push({ role: "user", content: [toolResult] });
      }
    }
  }
  return out;
}

async function* parseTextStream(
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
      try {
        const obj = JSON.parse(payload);
        if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
          yield obj.delta.text as string;
        }
        if (obj.type === "message_stop") return;
      } catch {
        /* skip */
      }
    }
  }
}
