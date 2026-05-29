// src/agent/context.test.ts
import { describe, it, expect, vi, beforeAll } from "vitest";
import { snapshot, render } from "./context";

vi.mock("../store/playerState", () => ({
  usePlayerState: {
    getState: () => ({
      videoId: "v1",
      currentIdx: 47,
      currentTime: 120,
      videoTitle: "NHS GP",
    }),
  },
}));

vi.mock("../store/library", () => ({
  useLibrary: {
    getState: () => ({
      library: {
        videos: [
          { id: "v1", title: "NHS GP", scene: "medical", syncedAt: 1, durationSec: 943 },
          { id: "v2", title: "Job interview", scene: "job", durationSec: 600 },
          { id: "v3", title: "Symptoms", scene: "medical", durationSec: 400 },
        ],
      },
    }),
  },
}));

vi.mock("../store/vocab", () => ({
  useVocabulary: {
    getState: () => ({
      entries: [
        // addedAt is the real field on VocabEntry; use ISO strings (newest last
        // so we can verify the sort actually runs).
        { id: "c", expression: "GP", videoId: "v1", addedAt: "2026-05-27T00:00:00Z" },
        { id: "b", expression: "symptoms", videoId: "v1", addedAt: "2026-05-28T00:00:00Z" },
        { id: "a", expression: "appointment", videoId: "v1", addedAt: "2026-05-29T00:00:00Z" },
      ],
    }),
  },
}));

vi.mock("../store/settings", () => ({
  useSettings: {
    getState: () => ({
      settings: {
        llmProvider: "openai-compatible",
        openaiCompatible: { model: "deepseek-chat", baseUrl: "", apiKey: "" },
      },
    }),
  },
}));

vi.mock("../llm/llmIdentity", () => ({
  getVendorKey: () => "deepseek",
  getModelName: () => "deepseek-chat",
}));

beforeAll(() => {
  Object.defineProperty(window, "location", {
    value: { pathname: "/player/v1" },
    writable: true,
  });
});

describe("ContextBuilder", () => {
  it("snapshot picks up pathname + video + library + vocab", () => {
    const s = snapshot();
    expect(s.page.pathname).toBe("/player/v1");
    expect(s.page.videoId).toBe("v1");
    expect(s.page.videoTitle).toBe("NHS GP");
    expect(s.page.cueIdx).toBe(47);
    expect(s.library.total).toBe(3);
    expect(s.vocab.total).toBe(3);
    // Newest first by addedAt → appointment > symptoms > GP.
    expect(s.vocab.recentTop5).toEqual(["appointment", "symptoms", "GP"]);
  });

  it("library summary buckets by scene and counts synced entries", () => {
    const s = snapshot();
    expect(s.library.syncedCount).toBe(1);
    // medical=2, job=1 — biggest bucket first.
    expect(s.library.bySceneTop3[0]).toEqual(["medical", 2]);
    expect(s.library.bySceneTop3[1]).toEqual(["job", 1]);
    expect(s.library.otherCount).toBe(0);
  });

  it("render produces ⟨当前上下文⟩ block with expected fields", () => {
    const out = render(snapshot());
    expect(out.startsWith("⟨当前上下文⟩")).toBe(true);
    expect(out).toContain("位置: /player/v1");
    expect(out).toContain('当前视频: "NHS GP"');
    // cueIdx 47 → 1-based "第 48 句".
    expect(out).toContain("第 48 句");
    expect(out).toContain("3 个视频");
    expect(out).toContain("medical 2");
    expect(out).toContain("job 1");
    expect(out).toContain("已云同步 1");
    expect(out).toContain("生词本: 3 条");
    expect(out).toContain("最近 3 条：appointment, symptoms, GP");
    expect(out).toContain("当前 LLM: deepseek-chat (用户 BYOK)");
  });

  it("vocab.recentTop5 is capped at 5 even with many entries", async () => {
    // Reset mocks for this test by re-importing with a different vocab shape.
    vi.resetModules();
    vi.doMock("../store/playerState", () => ({
      usePlayerState: {
        getState: () => ({
          videoId: null,
          currentIdx: null,
          currentTime: null,
          videoTitle: null,
        }),
      },
    }));
    vi.doMock("../store/library", () => ({
      useLibrary: { getState: () => ({ library: { videos: [] } }) },
    }));
    vi.doMock("../store/vocab", () => ({
      useVocabulary: {
        getState: () => ({
          entries: Array.from({ length: 8 }, (_, i) => ({
            id: `e${i}`,
            expression: `word${i}`,
            videoId: "v",
            addedAt: `2026-05-2${i}T00:00:00Z`,
          })),
        }),
      },
    }));
    vi.doMock("../store/settings", () => ({
      useSettings: {
        getState: () => ({
          settings: {
            llmProvider: "openai-compatible",
            openaiCompatible: { model: "deepseek-chat", baseUrl: "", apiKey: "" },
          },
        }),
      },
    }));
    vi.doMock("../llm/llmIdentity", () => ({
      getVendorKey: () => "deepseek",
      getModelName: () => "deepseek-chat",
    }));
    Object.defineProperty(window, "location", {
      value: { pathname: "/library" },
      writable: true,
    });

    const mod = await import("./context");
    const s = mod.snapshot();
    expect(s.vocab.recentTop5).toHaveLength(5);

    // Empty library + non-player page → render skips video/cue lines and
    // shows the "空" / "已云同步 0" branch.
    const out = mod.render(s);
    expect(out).toContain("位置: /library");
    expect(out).not.toContain("当前视频:");
    expect(out).not.toContain("字幕游标:");
    expect(out).toContain("库内: 0 个视频 (空, 已云同步 0)");
  });
});
