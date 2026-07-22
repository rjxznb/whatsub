import { describe, it, expect } from "vitest";
import { friendlyError, siteKeyForUrl } from "./friendlyError";

describe("siteKeyForUrl", () => {
  it("maps known hosts to site keys", () => {
    expect(siteKeyForUrl("https://www.youtube.com/watch?v=abc")).toBe("youtube");
    expect(siteKeyForUrl("https://m.bilibili.com/video/BV1")).toBe("bilibili");
    expect(siteKeyForUrl("https://www.instagram.com/p/x/")).toBe("instagram");
  });
  it("returns undefined for unknown hosts and junk", () => {
    expect(siteKeyForUrl("https://example.com/x")).toBeUndefined();
    expect(siteKeyForUrl("not a url")).toBeUndefined();
  });
});

describe("friendlyError download diagnosis", () => {
  it("explains when Vulkan crashed and the automatic CPU fallback also failed", () => {
    const result = friendlyError(
      "whisper_gpu_cpu_fallback_failed\nGPU: whisper-cli exit -1073741819\nCPU: whisper-cli exit 3",
      "transcribing",
    );

    expect(result.title).toBe("显卡加速和 CPU 兜底均失败");
    expect(result.suggestion).toContain("已经自动切换到 CPU");
    expect(result.generic).not.toBe(true);
  });

  it("marks YouTube bot checks as a deterministic login action", () => {
    const result = friendlyError(
      "ERROR: [youtube] Sign in to confirm you’re not a bot. Use --cookies.",
      "downloading",
      "https://www.youtube.com/watch?v=x",
    );

    expect(result.loginRequired).toBe(true);
    expect(result.action?.siteKey).toBe("youtube");
    expect(result.actionTier).toBe("primary");
    expect(result.retryable).not.toBe(true);
  });

  it("routes rotated cookies back to the source site's login", () => {
    const result = friendlyError(
      "The provided account cookies are no longer valid. Please refresh your cookies.",
      "downloading",
      "https://www.youtube.com/watch?v=x",
    );

    expect(result.loginRequired).toBe(true);
    expect(result.action?.siteKey).toBe("youtube");
    expect(result.actionTier).toBe("primary");
  });

  it("keeps network failures retryable without forcing login", () => {
    const result = friendlyError(
      "ERROR: Unable to download webpage: connection timed out",
      "downloading",
      "https://www.youtube.com/watch?v=x",
    );

    expect(result.loginRequired).not.toBe(true);
    expect(result.retryable).toBe(true);
    expect(result.title).toBe("无法访问视频网站");
  });
});
