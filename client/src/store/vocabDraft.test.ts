import { describe, it, expect, beforeEach } from "vitest";
import { loadDraft, saveDraft, clearDraft, type VocabDraft } from "./vocabDraft";

beforeEach(() => {
  window.localStorage.clear();
});

const sample: VocabDraft = {
  expression: "apparently",
  meaningZh: "显然",
  usage: "口语里表达听上去像那么回事",
  cueText: "She apparently left early.",
  cueTime: 12.3,
  videoId: "vid1",
  videoTitle: "Episode 1",
  updatedAt: "2026-05-08T10:00:00.000Z",
};

describe("vocabDraft", () => {
  it("returns null when no draft exists", () => {
    expect(loadDraft("apparently")).toBeNull();
  });

  it("saves and loads round-trip", () => {
    saveDraft(sample);
    const loaded = loadDraft("apparently");
    expect(loaded).toEqual(sample);
  });

  it("normalizes expression key (case-insensitive)", () => {
    saveDraft({ ...sample, expression: "Apparently" });
    expect(loadDraft("apparently")).not.toBeNull();
    expect(loadDraft("APPARENTLY")).not.toBeNull();
  });

  it("clearDraft removes the entry", () => {
    saveDraft(sample);
    clearDraft("apparently");
    expect(loadDraft("apparently")).toBeNull();
  });

  it("returns null on corrupt JSON", () => {
    window.localStorage.setItem("whatsub:vocab-draft:bad", "{not json");
    expect(loadDraft("bad")).toBeNull();
  });

  it("does not throw if localStorage is empty", () => {
    expect(() => clearDraft("nonexistent")).not.toThrow();
  });
});
