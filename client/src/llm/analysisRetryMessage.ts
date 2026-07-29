import type { AnalysisRetryEvent } from "./analyze";

export function analysisRetryMessage(event: AnalysisRetryEvent): string {
  if (event.kind === "transport") {
    return `网络波动，正在进行第 ${event.nextAttempt}/${event.maxAttempts} 次尝试…`;
  }
  if (event.unresolvedCueIndexes.length === 0) {
    return `模型返回的总结格式不完整，正在进行第 ${event.nextAttempt}/${event.maxAttempts} 次尝试…`;
  }
  return `模型返回格式不完整，正在补齐 ${event.unresolvedCueIndexes.length} 条字幕（第 ${event.nextAttempt}/${event.maxAttempts} 次）…`;
}
