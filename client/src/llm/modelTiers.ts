import type { WhisperModelSize } from "../types/settings";

// Plain-language tier metadata for the whisper.cpp model picker. Internal
// names (tiny/base/small/medium/large-v3) map to user-facing tier names that
// describe behavior rather than the underlying model. Both FirstRunGate
// (initial onboarding) and Settings (advanced reconfiguration) read from
// here so descriptions stay consistent across the app.
export interface ModelTier {
  size: WhisperModelSize;
  /** Friendly display name for non-technical users. */
  name: string;
  /** Approximate file size in MiB, used for UI labels and partial-download
   *  percent calculations. Matches the values in pipeline/whisper.rs's
   *  MODEL_URLS table. */
  sizeMB: number;
  /** One-line behavior description shown next to the tier in the picker. */
  description: string;
  /** Whether to mark this tier as the recommended default in the UI. */
  recommended?: boolean;
}

export const MODEL_TIERS: readonly ModelTier[] = [
  {
    size: "tiny",
    name: "极速",
    sizeMB: 75,
    description: "下载最小、识别最快，但容易漏字、错字。适合在配置较低的电脑上跑、或对准确度要求不高时。",
  },
  {
    size: "base",
    name: "轻量",
    sizeMB: 142,
    description: "比极速准一些，文件依然小。在低配机器上能用，但仍会有错字。",
  },
  {
    size: "small",
    name: "标准",
    sizeMB: 466,
    description: "速度与准确度平衡，绝大多数视频够用。第一次用建议先选这个。",
    recommended: true,
  },
  {
    size: "medium",
    name: "高精度",
    sizeMB: 1500,
    description: "识别明显更准，处理速度稍慢。适合长视频或带口音的素材。",
  },
  {
    size: "large-v3",
    name: "顶级",
    sizeMB: 3094,
    description: "识别质量最好，但下载慢、显存/内存占用高，建议有独立显卡的机器。",
  },
] as const;

/** "~466 MB" / "~1.5 GB" */
export function formatModelSize(mb: number): string {
  if (mb >= 1000) return `约 ${(mb / 1024).toFixed(1)} GB`;
  return `约 ${mb} MB`;
}

export function getTier(size: WhisperModelSize): ModelTier | undefined {
  return MODEL_TIERS.find((t) => t.size === size);
}
