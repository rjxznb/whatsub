import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { importVideoTool } from "./import_video";
import { useSettings } from "../../store/settings";

vi.mock("@tauri-apps/api/core");

const ctx = { signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
  // Default whisperModel so the required-field guard passes.
  // Individual tests can override via useSettings.setState({...}).
  useSettings.setState({
    settings: {
      ...useSettings.getState().settings,
      whisperModel: "base",
    },
  });
});

describe("import_video tool", () => {
  it("riskTier is MID", () => {
    expect(importVideoTool.riskTier).toBe("MID");
  });

  it("availableOn returns true on any page", () => {
    expect(importVideoTool.availableOn({ pathname: "/library" })).toBe(true);
    expect(importVideoTool.availableOn({ pathname: "/player/abc" })).toBe(true);
  });

  it("execute invokes import_video with req:{...} wrapper + whisperModel", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await importVideoTool.execute(
      { url: "https://www.youtube.com/watch?v=abc123" },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith("import_video", {
      req: {
        sourceKind: "url",
        sourceValue: "https://www.youtube.com/watch?v=abc123",
        whisperModel: "base",
        quality: "standard",
        background: true,
      },
    });
    expect(result.started).toBe(true);
    expect(result.watchAt).toBe("/library");
  });

  it("execute uses provided quality", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await importVideoTool.execute(
      { url: "https://www.youtube.com/watch?v=xyz789", quality: "high" },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith("import_video", {
      req: expect.objectContaining({
        sourceValue: "https://www.youtube.com/watch?v=xyz789",
        quality: "high",
      }),
    });
    expect(result.started).toBe(true);
  });

  it("execute defaults to 'standard' (720p) when quality is not provided", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    await importVideoTool.execute(
      { url: "https://www.youtube.com/watch?v=test" },
      ctx
    );

    expect(mockInvoke).toHaveBeenCalledWith(
      "import_video",
      expect.objectContaining({
        req: expect.objectContaining({ quality: "standard" }),
      })
    );
  });


  it("result has started:true and watchAt:/library", async () => {
    const mockInvoke = vi.mocked(invoke);
    mockInvoke.mockResolvedValue(undefined);

    const result = await importVideoTool.execute(
      { url: "https://www.youtube.com/watch?v=abc" },
      ctx
    );

    expect(result.started).toBe(true);
    expect(result.watchAt).toBe("/library");
    expect(result.sourceUrl).toBe("https://www.youtube.com/watch?v=abc");
  });

  it("doneLabel returns fire-and-watch message", () => {
    const label = importVideoTool.doneLabel({
      started: true,
      watchAt: "/library",
      sourceUrl: "https://www.youtube.com/watch?v=abc",
    });
    expect(label).toBe("已启动导入（进度看 Library）");
  });
});
