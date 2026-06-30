import { describe, it, expect } from "vitest";
import { shouldPromptLogin } from "./ImportModal";

describe("shouldPromptLogin", () => {
  it("prompts only when in-app cookies exist and are expired", () => {
    expect(shouldPromptLogin("in-app", { exists: true, expired: true })).toBe(true);
  });
  it("does not prompt when not using in-app cookies", () => {
    expect(shouldPromptLogin("none", { exists: true, expired: true })).toBe(false);
  });
  it("does not prompt when no bucket exists (never logged in)", () => {
    expect(shouldPromptLogin("in-app", { exists: false, expired: false })).toBe(false);
  });
  it("does not prompt when cookies are still valid", () => {
    expect(shouldPromptLogin("in-app", { exists: true, expired: false })).toBe(false);
  });
});
