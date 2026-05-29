import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { vocabRemoveTool } from "./vocab_remove";

vi.mock("@tauri-apps/api/core");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("vocab_remove tool", () => {
  it("riskTier is MID", () => {
    expect(vocabRemoveTool.riskTier).toBe("MID");
  });

  it("availableOn returns true on any page", () => {
    expect(vocabRemoveTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(vocabRemoveTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute invokes vocab_remove with the id", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue([]);

    const result = await vocabRemoveTool.execute(
      { id: "vocab_123" },
      ctx,
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("vocab_remove", { id: "vocab_123" });
    expect(result.removed).toBe(true);
    expect(result.id).toBe("vocab_123");
  });

  it("doneLabel returns static text", () => {
    const label = vocabRemoveTool.doneLabel({ removed: true, id: "x" });
    expect(label).toBe("已删除生词");
  });
});
