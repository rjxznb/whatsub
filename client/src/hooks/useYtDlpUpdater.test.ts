import { describe, it, expect } from "vitest";
import { shouldPromptYtDlp } from "./useYtDlpUpdater";

describe("shouldPromptYtDlp", () => {
  const info = { current: "2026.06.09", latest: "2026.07.01", hasUpdate: true, notes: "" };
  it("prompts when hasUpdate and not skipped", () => {
    expect(shouldPromptYtDlp(info, [])).toBe(true);
  });
  it("does not prompt when skipped", () => {
    expect(shouldPromptYtDlp(info, ["2026.07.01"])).toBe(false);
  });
  it("does not prompt when no update", () => {
    expect(shouldPromptYtDlp({ ...info, hasUpdate: false }, [])).toBe(false);
  });
  it("does not prompt when info is null", () => {
    expect(shouldPromptYtDlp(null, [])).toBe(false);
  });
});
