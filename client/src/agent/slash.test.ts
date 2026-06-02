import { describe, it, expect } from "vitest";
import { parseSlash, applyArgs, expandSlash, isSlashTyping, filterCommands } from "./slash";
import type { SlashCommand } from "../store/slashCommands";

const cmds: SlashCommand[] = [
  { id: "1", name: "找视频", description: "搜 YouTube", template: "搜索 $ARGUMENTS 的视频" },
  { id: "2", name: "复习", description: "薄弱点", template: "推荐复习片段" },
];

describe("parseSlash", () => {
  it("splits name and args", () => {
    expect(parseSlash("/找视频 医疗 场景")).toEqual({ name: "找视频", args: "医疗 场景" });
    expect(parseSlash("/复习")).toEqual({ name: "复习", args: "" });
  });
  it("returns null for non-commands", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("a/b")).toBeNull();
  });
});

describe("applyArgs", () => {
  it("substitutes $ARGUMENTS", () => {
    expect(applyArgs("搜索 $ARGUMENTS 的视频", "医疗")).toBe("搜索 医疗 的视频");
  });
  it("collapses the gap when args are empty", () => {
    expect(applyArgs("搜索 $ARGUMENTS 的视频", "")).toBe("搜索 的视频");
  });
  it("appends args when there's no placeholder", () => {
    expect(applyArgs("推荐复习片段", "过去式")).toBe("推荐复习片段 过去式");
    expect(applyArgs("推荐复习片段", "")).toBe("推荐复习片段");
  });
});

describe("expandSlash", () => {
  it("expands a known command", () => {
    expect(expandSlash("/找视频 医疗", cmds)).toBe("搜索 医疗 的视频");
  });
  it("returns null for unknown command or plain text", () => {
    expect(expandSlash("/unknown x", cmds)).toBeNull();
    expect(expandSlash("just chatting", cmds)).toBeNull();
  });
});

describe("isSlashTyping", () => {
  it("true only while typing a name (no space yet)", () => {
    expect(isSlashTyping("/")).toBe(true);
    expect(isSlashTyping("/找")).toBe(true);
    expect(isSlashTyping("/找视频 ")).toBe(false); // space → typing args
    expect(isSlashTyping("hi")).toBe(false);
  });
});

describe("filterCommands", () => {
  it("matches name or description, empty query returns all", () => {
    expect(filterCommands(cmds, "")).toHaveLength(2);
    expect(filterCommands(cmds, "找").map((c) => c.name)).toEqual(["找视频"]);
    expect(filterCommands(cmds, "薄弱").map((c) => c.name)).toEqual(["复习"]);
  });
});
