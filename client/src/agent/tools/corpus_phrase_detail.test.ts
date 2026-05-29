import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import { corpusPhraseDetailTool } from "./corpus_phrase_detail";

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  invokeMock.mockReset();
});

describe("corpus_phrase_detail tool", () => {
  it("riskTier is LOW", () => {
    expect(corpusPhraseDetailTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true on any page", () => {
    expect(corpusPhraseDetailTool.availableOn({ pathname: "/whatever" })).toBe(true);
  });

  it("execute happy path normalises {list: [...]} tags + counts arrays", async () => {
    invokeMock.mockResolvedValueOnce({
      phrase: {
        phraseRaw: "knock on wood",
        phraseNormalized: "knock on wood",
        meaningZh: "敲木头 (祈求好运)",
        usageNote: "迷信式表达",
        tags: { list: ["social", "idiom"] },
      },
      publicContributions: [{ id: 1 }, { id: 2 }, { id: 3 }],
      personalContributions: [{ id: 4 }],
    });

    const r = await corpusPhraseDetailTool.execute(
      { phrase: "knock on wood" },
      ctx,
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "corpus_phrase_detail",
      { phrase: "knock on wood" },
    );
    expect(r).toEqual({
      phrase: "knock on wood",
      meaningZh: "敲木头 (祈求好运)",
      usageNote: "迷信式表达",
      tags: ["social", "idiom"],
      publicContributions: 3,
      personalContributions: 1,
    });
  });

  it("execute handles a null phrase + missing arrays gracefully", async () => {
    invokeMock.mockResolvedValueOnce({
      phrase: null,
    });
    const r = await corpusPhraseDetailTool.execute(
      { phrase: "uknown" },
      ctx,
    );
    expect(r.phrase).toBe("uknown");
    expect(r.tags).toEqual([]);
    expect(r.publicContributions).toBe(0);
    expect(r.personalContributions).toBe(0);
    expect(r.meaningZh).toBeUndefined();
  });

  it("doneLabel embeds the phrase", () => {
    expect(
      corpusPhraseDetailTool.doneLabel({
        phrase: "fair enough",
        tags: [],
        publicContributions: 0,
        personalContributions: 0,
      }),
    ).toBe('已查询 "fair enough" 详情');
  });
});
