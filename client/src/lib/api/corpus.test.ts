import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue("tok") }));

import { corpusContribute, corpusDelete, CorpusContributeError } from "./corpus";

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

describe("corpusDelete", () => {
  it("DELETEs the contribution and resolves on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await expect(corpusDelete(7)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toContain("/corpus/contribute/7");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("treats 404 as success (already gone)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
    await expect(corpusDelete(7)).resolves.toBeUndefined();
  });

  it("throws on other errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ reason: "boom" }) }));
    await expect(corpusDelete(7)).rejects.toBeInstanceOf(CorpusContributeError);
  });
});
