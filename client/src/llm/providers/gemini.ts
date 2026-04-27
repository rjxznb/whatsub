import type { Provider, ProviderRequest } from "./types";
import type { Settings } from "../../types/settings";

export function createGeminiProvider(settings: Settings): Provider {
  const cfg = settings.gemini;
  return {
    async *stream(req: ProviderRequest): AsyncIterable<string> {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:streamGenerateContent` +
        `?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;

      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: req.userPrompt }] }],
        }),
      });
      if (!resp.ok) throw new Error(`Gemini API ${resp.status}: ${await resp.text()}`);
      if (!resp.body) throw new Error("response body missing");
      yield* parseGeminiStream(resp.body);
    },
  };
}

async function* parseGeminiStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
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
