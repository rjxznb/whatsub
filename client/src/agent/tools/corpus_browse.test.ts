import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import { corpusBrowseTool } from "./corpus_browse";

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  invokeMock.mockReset();
});

describe("corpus_browse tool", () => {
  it("riskTier is LOW", () => {
    expect(corpusBrowseTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true for any page", () => {
    expect(corpusBrowseTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(corpusBrowseTool.availableOn({ pathname: "/player/x" })).toBe(true);
    expect(corpusBrowseTool.availableOn({ pathname: "/corpus" })).toBe(true);
  });

  it("public scope calls corpus_browse, normalises {list: [...]} tags + counts", async () => {
    invokeMock.mockResolvedValueOnce({
      items: [
        {
          phraseRaw: "knock on wood",
          phraseNormalized: "knock on wood",
          tags: { list: ["social", "idiom"] },
          contributionCount: 5,
        },
        {
          phraseRaw: "by the way",
          phraseNormalized: "by the way",
          tags: ["social"],
          contributionCount: 2,
        },
      ],
      total: 2,
    });
    const r = await corpusBrowseTool.execute({ scope: "public" }, ctx);
    expect(invokeMock).toHaveBeenCalledWith("corpus_browse", expect.objectContaining({ scene: null }));
    expect(r.phrases).toHaveLength(2);
    expect(r.phrases[0]).toEqual({
      phrase: "knock on wood",
      tags: ["social", "idiom"],
      instanceCount: 5,
    });
    expect(r.phrases[1].tags).toEqual(["social"]);
  });

  it("mine scope routes to corpus_mine + groups instances by phrase", async () => {
    invokeMock.mockResolvedValueOnce({
      items: [
        { phraseRaw: "fair enough", phraseNormalized: "fair enough", tags: ["social"] },
        { phraseRaw: "fair enough", phraseNormalized: "fair enough", tags: ["social"] },
        { phraseRaw: "no worries", phraseNormalized: "no worries", tags: ["social"] },
      ],
      total: 3,
    });
    const r = await corpusBrowseTool.execute({ scope: "mine" }, ctx);
    expect(invokeMock).toHaveBeenCalledWith("corpus_mine", expect.any(Object));
    expect(r.phrases).toHaveLength(2);
    const fair = r.phrases.find((p) => p.phrase === "fair enough");
    expect(fair?.instanceCount).toBe(2);
  });

  it("keyword filter narrows results case-insensitively", async () => {
    invokeMock.mockResolvedValueOnce({
      items: [
        { phraseRaw: "knock on wood", tags: [], contributionCount: 1 },
        { phraseRaw: "by the way", tags: [], contributionCount: 1 },
        { phraseRaw: "Wood you mind", tags: [], contributionCount: 1 },
      ],
      total: 3,
    });
    const r = await corpusBrowseTool.execute({ keyword: "wood" }, ctx);
    expect(r.phrases.map((p) => p.phrase)).toEqual(["knock on wood", "Wood you mind"]);
  });

  it("doneLabel reflects the returned phrase count", () => {
    expect(corpusBrowseTool.doneLabel({ phrases: [] })).toContain("(0 条)");
    expect(
      corpusBrowseTool.doneLabel({
        phrases: [{ phrase: "x", tags: [], instanceCount: 1 }],
      }),
    ).toContain("(1 条)");
  });
});
