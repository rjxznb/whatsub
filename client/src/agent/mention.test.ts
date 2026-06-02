import { describe, it, expect } from "vitest";
import { atQueryAtEnd, buildReferencePreamble, composeWithRefs, type VideoRef } from "./mention";

describe("atQueryAtEnd", () => {
  it("detects a trailing @query", () => {
    expect(atQueryAtEnd("@nhs")).toEqual({ query: "nhs", start: 0 });
    expect(atQueryAtEnd("总结 @gp")).toEqual({ query: "gp", start: 3 });
    expect(atQueryAtEnd("@")).toEqual({ query: "", start: 0 });
  });
  it("returns null when not mid-mention", () => {
    expect(atQueryAtEnd("hello")).toBeNull();
    expect(atQueryAtEnd("a@b")).toBeNull(); // @ not after start/space
    expect(atQueryAtEnd("@nhs gp")).toBeNull(); // space after → mention ended
  });
});

describe("buildReferencePreamble / composeWithRefs", () => {
  const refs: VideoRef[] = [
    { id: "abc", title: "NHS GP basics" },
    { id: "def", title: "Renting a flat" },
  ];
  it("builds an anchor line per ref", () => {
    const p = buildReferencePreamble(refs);
    expect(p).toContain('[引用·库视频] "NHS GP basics" (videoId=abc)');
    expect(p).toContain('(videoId=def)');
    expect(buildReferencePreamble([])).toBe("");
  });
  it("composes preamble + prompt", () => {
    expect(composeWithRefs(refs, "总结一下")).toContain("总结一下");
    expect(composeWithRefs(refs, "总结一下").startsWith("[引用")).toBe(true);
    expect(composeWithRefs([], "hi")).toBe("hi");
    expect(composeWithRefs(refs, "")).toBe(buildReferencePreamble(refs));
  });
});
