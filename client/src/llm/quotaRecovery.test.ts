import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../types/settings";
import { RelayError } from "./providers/relayErrors";
import {
  SETTINGS_LLM_LINK,
  canResumeQuota,
  preflightManagedQuota,
  quotaDetailsFromRelayError,
  quotaRecoveryMessage,
} from "./quotaRecovery";

const RESET_AT = 1_785_542_400_000; // 2026-08-01 00:00 UTC / 08:00 Beijing

const managedSettings = {
  ...DEFAULT_SETTINGS,
  vendorId: "whatsub-managed",
};

describe("managed quota preflight", () => {
  it("blocks a Pro managed import when usage has reached the monthly limit", async () => {
    const result = await preflightManagedQuota(managedSettings, async () => ({
      tier: "pro",
      used: 5_000_000,
      limit: 5_000_000,
      requestCount: 9,
      periodResetAt: RESET_AT,
    }));

    expect(result).toEqual({
      used: 5_000_000,
      limit: 5_000_000,
      periodResetAt: RESET_AT,
      committedCueOffset: 0,
      totalCues: 0,
    });
  });

  it("does not query quota for a BYOK vendor", async () => {
    const load = vi.fn(async () => {
      throw new Error("must not run");
    });

    await expect(preflightManagedQuota(DEFAULT_SETTINGS, load)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("does not block when the advisory quota lookup fails", async () => {
    await expect(preflightManagedQuota(managedSettings, async () => {
      throw new Error("offline");
    })).resolves.toBeNull();
  });

  it("does not block a non-Pro managed tier", async () => {
    await expect(preflightManagedQuota(managedSettings, async () => ({
      tier: "trial",
      used: 200_000,
      limit: 200_000,
      requestCount: 5,
      periodResetAt: 0,
    }))).resolves.toBeNull();
  });
});

describe("quota recovery details", () => {
  it("normalizes a quota RelayError with the durable cue checkpoint", () => {
    const error = new RelayError({
      code: "quota_exceeded",
      message: "本月额度已用完。",
      upsell: true,
      used: 5_000_100,
      limit: 5_000_000,
      periodResetAt: RESET_AT,
    }, 429);

    expect(quotaDetailsFromRelayError(error, 150, 243)).toEqual({
      used: 5_000_100,
      limit: 5_000_000,
      periodResetAt: RESET_AT,
      committedCueOffset: 150,
      totalCues: 243,
    });
  });

  it("rejects non-quota relay errors", () => {
    const error = new RelayError({
      code: "trial_used_up",
      message: "试用额度已用完。",
      upsell: true,
    }, 429);

    expect(quotaDetailsFromRelayError(error, 0, 100)).toBeNull();
  });

  it("gates resume at the exact reset boundary", () => {
    const details = {
      used: 5_000_100,
      limit: 5_000_000,
      periodResetAt: RESET_AT,
      committedCueOffset: 150,
      totalCues: 243,
    };

    expect(canResumeQuota(details, RESET_AT - 1)).toBe(false);
    expect(canResumeQuota(details, RESET_AT)).toBe(true);
  });

  it("formats the saved checkpoint and Beijing reset time", () => {
    expect(quotaRecoveryMessage({
      used: 5_000_100,
      limit: 5_000_000,
      periodResetAt: RESET_AT,
      committedCueOffset: 150,
      totalCues: 243,
    })).toBe(
      "本月 AI 额度已用完。已保存到第 150 条字幕，将于 2026/08/01 08:00（北京时间）恢复；恢复后可从这里继续，无需重新下载或转录。",
    );
  });

  it("keeps recovery actionable but does not retry blindly when reset metadata is missing", () => {
    const details = {
      used: null,
      limit: null,
      periodResetAt: null,
      committedCueOffset: 0,
      totalCues: 0,
    };

    expect(canResumeQuota(details, 0)).toBe(false);
    expect(quotaRecoveryMessage(details)).toBe(
      "本月 AI 额度已用完。解析进度尚未开始；切换自己的 API 后可立即继续。",
    );
  });

  it("uses the stable settings deep link", () => {
    expect(SETTINGS_LLM_LINK).toBe("/settings?highlight=llm-provider");
  });
});
