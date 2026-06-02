import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue("tok") }));

import { corpusContribute, CorpusContributeError } from "./corpus";

const okResp = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("corpusContribute", () => {
  it("POSTs to /api/corpus/contribute with bearer + body, returns id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResp({ id: 42 }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await corpusContribute({
      phraseRaw: "save up",
      contextSentence: "I need to save up for it.",
      source: { kind: "webpage", url: "https://whatsub.eversay.cc/desktop" },
      tags: ["banking"],
    });
    expect(r.id).toBe(42);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://whatsub.eversay.cc/api/corpus/contribute");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    const sent = JSON.parse(init.body);
    expect(sent.phraseRaw).toBe("save up");
    expect(sent.tags).toEqual(["banking"]);
  });

  it("throws CorpusContributeError with the backend reason + quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResp({ reason: "quota_exceeded", used: 50, limit: 50 }, false, 403)),
    );
    await expect(
      corpusContribute({
        phraseRaw: "x",
        contextSentence: "y",
        source: { kind: "webpage", url: "https://e.x" },
      }),
    ).rejects.toMatchObject({ reason: "quota_exceeded", used: 50, limit: 50 });
  });

  it("requires a session token", async () => {
    const core = await import("@tauri-apps/api/core");
    (core.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(
      corpusContribute({ phraseRaw: "x", contextSentence: "y", source: { kind: "webpage", url: "https://e.x" } }),
    ).rejects.toBeInstanceOf(CorpusContributeError);
  });
});
