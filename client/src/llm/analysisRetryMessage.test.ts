import { describe, expect, it } from "vitest";
import { analysisRetryMessage } from "./analysisRetryMessage";
import type { AnalysisRetryEvent } from "./analyze";

function retryEvent(
  kind: AnalysisRetryEvent["kind"],
  unresolvedCueIndexes: number[],
): AnalysisRetryEvent {
  return {
    kind,
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 4,
    delayMs: 500,
    error: new Error("fixture"),
    unresolvedCueIndexes,
  };
}

describe("analysisRetryMessage", () => {
  it("describes a transport retry as network fluctuation", () => {
    expect(analysisRetryMessage(retryEvent("transport", [17, 38])))
      .toBe("网络波动，正在进行第 2/4 次尝试…");
  });

  it("describes content repair with the unresolved cue count", () => {
    expect(analysisRetryMessage(retryEvent("content-repair", [17, 38])))
      .toBe("模型返回格式不完整，正在补齐 2 条字幕（第 2/4 次）…");
  });

  it("describes a summary repair without claiming cue indexes", () => {
    expect(analysisRetryMessage(retryEvent("content-repair", [])))
      .toBe("模型返回的总结格式不完整，正在进行第 2/4 次尝试…");
  });
});
