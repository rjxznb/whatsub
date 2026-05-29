import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { vocabAddTool } from "./vocab_add";

vi.mock("@tauri-apps/api/core");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("vocab_add tool", () => {
  it("riskTier is MID", () => {
    expect(vocabAddTool.riskTier).toBe("MID");
  });

  it("getRisk returns LOW for 1 entry", () => {
    const args = { entries: [{ expression: "apple" }] };
    expect(vocabAddTool.getRisk?.(args)).toBe("LOW");
  });

  it("getRisk returns LOW for 2 entries", () => {
    const args = {
      entries: [
        { expression: "apple" },
        { expression: "banana" },
      ],
    };
    expect(vocabAddTool.getRisk?.(args)).toBe("LOW");
  });

  it("getRisk returns MID for 3 entries", () => {
    const args = {
      entries: [
        { expression: "apple" },
        { expression: "banana" },
        { expression: "cherry" },
      ],
    };
    expect(vocabAddTool.getRisk?.(args)).toBe("MID");
  });

  it("getRisk returns MID for 10 entries", () => {
    const args = {
      entries: Array.from({ length: 10 }, (_, i) => ({
        expression: `word${i}`,
      })),
    };
    expect(vocabAddTool.getRisk?.(args)).toBe("MID");
  });

  it("availableOn returns true on any page", () => {
    expect(vocabAddTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(vocabAddTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute invokes vocab_add once for 1 entry", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue([]);

    const result = await vocabAddTool.execute(
      {
        entries: [
          { expression: "hello", meaningZh: "你好" },
        ],
      },
      ctx,
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      "vocab_add",
      expect.objectContaining({
        expression: "hello",
        meaning_zh: "你好",
      }),
    );
    expect(result.added).toBe(1);
    expect(result.ids).toHaveLength(1);
  });

  it("execute invokes vocab_add 3 times for 3 entries", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue([]);

    const result = await vocabAddTool.execute(
      {
        entries: [
          { expression: "apple" },
          { expression: "banana" },
          { expression: "cherry" },
        ],
      },
      ctx,
    );

    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(result.added).toBe(3);
    expect(result.ids).toHaveLength(3);
  });

  it("passes videoId and time correctly", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue([]);

    await vocabAddTool.execute(
      {
        entries: [
          {
            expression: "sunset",
            meaningZh: "日落",
            videoId: "vid_123",
            time: 45.5,
          },
        ],
      },
      ctx,
    );

    expect(mockInvoke).toHaveBeenCalledWith(
      "vocab_add",
      expect.objectContaining({
        expression: "sunset",
        meaning_zh: "日落",
        video_id: "vid_123",
      }),
    );
  });

  it("doneLabel formats the added count", () => {
    const label = vocabAddTool.doneLabel({ added: 5, ids: [] });
    expect(label).toBe("已添加 5 条生词");
  });
});
