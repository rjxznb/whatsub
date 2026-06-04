import { describe, it, expect } from "vitest";
import { parseRelayError, RelayError } from "./relayErrors";

describe("parseRelayError", () => {
  it("uses the relay's own friendly message when present", () => {
    const info = parseRelayError(
      429,
      JSON.stringify({ error: "quota_exceeded", message: "本月额度已用完。", used: 5_000_000, limit: 5_000_000 }),
    );
    expect(info).toEqual({ code: "quota_exceeded", message: "本月额度已用完。", upsell: true });
  });

  it("falls back to built-in copy when the body has a code but no message", () => {
    const info = parseRelayError(403, JSON.stringify({ error: "license_blocked" }));
    expect(info?.code).toBe("license_blocked");
    expect(info?.message).toContain("买断");
    expect(info?.upsell).toBe(true);
  });

  it("flags retry-style errors as non-upsell", () => {
    expect(parseRelayError(429, JSON.stringify({ error: "rate_limited" }))?.upsell).toBe(false);
    expect(parseRelayError(413, JSON.stringify({ error: "input_too_large" }))?.upsell).toBe(false);
  });

  it("synthesizes a message for an unknown code rather than dropping it", () => {
    const info = parseRelayError(500, JSON.stringify({ error: "weird_new_code" }));
    expect(info?.code).toBe("weird_new_code");
    expect(info?.message).toContain("weird_new_code");
    expect(info?.upsell).toBe(false);
  });

  it("returns null for non-JSON or code-less bodies (keep generic handling)", () => {
    expect(parseRelayError(502, "<html>502 Bad Gateway</html>")).toBeNull();
    expect(parseRelayError(500, JSON.stringify({ message: "no code here" }))).toBeNull();
    expect(parseRelayError(500, "")).toBeNull();
  });
});

describe("RelayError", () => {
  it("carries a user-friendly message + code + upsell from the info", () => {
    const err = new RelayError(
      { code: "free_used_up", message: "免费体验额度已用完。", upsell: true },
      429,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("免费体验额度已用完。");
    expect(err.code).toBe("free_used_up");
    expect(err.status).toBe(429);
    expect(err.upsell).toBe(true);
  });
});
