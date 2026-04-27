import type { Provider, ProviderRequest } from "./types";
import type { Settings } from "../../types/settings";

export function createClaudeProvider(settings: Settings): Provider {
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
      });

      if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
      if (!resp.body) throw new Error("response body missing");
      yield* parseClaudeStream(resp.body);
    },
  };
}

async function* parseClaudeStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
