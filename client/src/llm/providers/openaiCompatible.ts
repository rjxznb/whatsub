import type { Provider, ProviderRequest } from "./types";
import type { Settings } from "../../types/settings";

export function createOpenAICompatibleProvider(settings: Settings): Provider {
  const cfg = settings.openaiCompatible;

  return {
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const resp = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          stream: true,
          messages: [
            { role: "system", content: req.systemPrompt },
            { role: "user", content: req.userPrompt },
          ],
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
  };
}

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
      } catch {
        // skip malformed lines
      }
    }
  }
}
