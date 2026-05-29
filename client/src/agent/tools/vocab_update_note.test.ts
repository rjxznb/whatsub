import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { vocabUpdateNoteTool } from "./vocab_update_note";

vi.mock("@tauri-apps/api/core");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("vocab_update_note tool", () => {
  it("riskTier is MID", () => {
    expect(vocabUpdateNoteTool.riskTier).toBe("MID");
  });

  it("availableOn returns true on any page", () => {
    expect(vocabUpdateNoteTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(vocabUpdateNoteTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute invokes vocab_update_note with id and note", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue([]);

    const result = await vocabUpdateNoteTool.execute(
      { id: "vocab_123", note: "This means X in context Y" },
      ctx,
    );

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith("vocab_update_note", {
      id: "vocab_123",
      note: "This means X in context Y",
    });
    expect(result.updated).toBe(true);
    expect(result.id).toBe("vocab_123");
  });

  it("handles empty note", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue([]);

    const result = await vocabUpdateNoteTool.execute(
      { id: "vocab_456", note: "" },
      ctx,
    );

    expect(mockInvoke).toHaveBeenCalledWith("vocab_update_note", {
      id: "vocab_456",
      note: "",
    });
    expect(result.updated).toBe(true);
  });

  it("doneLabel returns static text", () => {
    const label = vocabUpdateNoteTool.doneLabel({ updated: true, id: "x" });
    expect(label).toBe("已更新笔记");
  });
});
