import { describe, it, expect } from "vitest";
import { siteKeyForUrl } from "./friendlyError";

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
