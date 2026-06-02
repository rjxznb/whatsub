import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LearnerProfile } from "../../tutor/types";

// ── Mocks ──────────────────────────────────────────────────────────────────
const loadProfileMock = vi.fn<() => Promise<LearnerProfile>>();
vi.mock("../../tutor/learnerProfile", () => ({
  loadLearnerProfile: () => loadProfileMock(),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useLibrary } from "../../store/library";
import { recommendReviewTool } from "./recommend_review";

const ctx = { signal: new AbortController().signal };

function err(over: Partial<LearnerProfile["errorEvents"][number]> = {}) {
  return {
    id: "e1",
    ts: 1000,
    source: { type: "lesson" as const, videoId: "v1", cueIdx: 2, questionId: null },
    pattern: "past_tense_irregular" as const,
    detail: "said goed",
    userInput: "I goed there",
    correction: "I went there",
    resolved: false,
    resolvedAt: null,
    ...over,
  };
}

function profile(over: Partial<LearnerProfile> = {}): LearnerProfile {
  return {
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    estimate: { cefr: "B1", vocabSize: 3000, listeningLevel: "mid", confidence: 0.7 },
    errorEvents: [err()],
    masteryIndex: {
      weakPatterns: [
        {
          pattern: "past_tense_irregular",
          occurrences: 3,
          lastSeenAt: 1000,
          sampleErrorIds: ["e1"],
          lastRemediatedAt: null,
        },
      ],
      knownWords: [],
      weakWords: [],
    },
    goals: [],
    ...over,
  };
}

beforeEach(() => {
  loadProfileMock.mockReset();
  invokeMock.mockReset();
  // A library with one titled video so items carry a readable title.
  useLibrary.setState({
    library: {
      videos: [{ id: "v1", title: "入境面试" }],
      folders: [],
      topLevelOrder: [],
    },
  } as never);
  // load_analysis returns a video whose cue 2 has a timestamp + sentence.
  invokeMock.mockResolvedValue({
    subtitles: [
      { time: 5, endTime: 7, text: "A", translation: "", isKeyPoint: false, highlightWords: [], keyNotes: {}, highlightTranslations: {} },
      { time: 60, endTime: 63, text: "B", translation: "", isKeyPoint: false, highlightWords: [], keyNotes: {}, highlightTranslations: {} },
      { time: 135, endTime: 138, text: "I went there yesterday.", translation: "", isKeyPoint: true, highlightWords: [], keyNotes: {}, highlightTranslations: {} },
    ],
    keyPhrases: [],
  });
});

describe("recommend_review tool", () => {
  it("id, riskTier, availability", () => {
    expect(recommendReviewTool.id).toBe("recommend_review");
    expect(recommendReviewTool.riskTier).toBe("LOW");
    expect(recommendReviewTool.availableOn({ pathname: "/library" })).toBe(true);
  });

  it("resolves a weak-pattern error to a video + MM:SS + sentence", async () => {
    loadProfileMock.mockResolvedValue(profile());
    const r = await recommendReviewTool.execute({}, ctx);
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect(it.videoId).toBe("v1");
    expect(it.videoTitle).toBe("入境面试");
    expect(it.atSec).toBe(135);
    expect(it.timeLabel).toBe("2:15");
    expect(it.sentence).toBe("I went there yesterday.");
    expect(it.yourMistake).toBe("I goed there");
    expect(it.correction).toBe("I went there");
    expect(it.patternLabel).toBe("过去式不规则");
  });

  it("filters by an explicit pattern arg", async () => {
    loadProfileMock.mockResolvedValue(
      profile({
        errorEvents: [
          err({ id: "a", pattern: "past_tense_irregular", source: { type: "lesson", videoId: "v1", cueIdx: 2, questionId: null } }),
          err({ id: "b", pattern: "article_missing", source: { type: "lesson", videoId: "v1", cueIdx: 1, questionId: null } }),
        ],
      }),
    );
    const r = await recommendReviewTool.execute({ pattern: "article_missing" }, ctx);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].cueIdx).toBe(1);
    expect(r.items[0].pattern).toBe("article_missing");
  });

  it("skips resolved errors", async () => {
    loadProfileMock.mockResolvedValue(
      profile({ errorEvents: [err({ resolved: true, resolvedAt: 2000 })] }),
    );
    const r = await recommendReviewTool.execute({}, ctx);
    expect(r.items).toHaveLength(0);
    expect(r.note).toContain("已经专项过了");
  });

  it("dedups multiple errors at the same video+cue", async () => {
    loadProfileMock.mockResolvedValue(
      profile({
        errorEvents: [
          err({ id: "a", ts: 1000 }),
          err({ id: "b", ts: 900 }), // same v1#2
        ],
      }),
    );
    const r = await recommendReviewTool.execute({}, ctx);
    expect(r.items).toHaveLength(1);
  });

  it("skips items whose cue no longer exists (deleted / re-transcribed)", async () => {
    loadProfileMock.mockResolvedValue(
      profile({ errorEvents: [err({ source: { type: "lesson", videoId: "v1", cueIdx: 99, questionId: null } })] }),
    );
    const r = await recommendReviewTool.execute({}, ctx);
    expect(r.items).toHaveLength(0);
    expect(r.note).toContain("定位不到");
  });

  it("returns a helpful note when there are no weak patterns", async () => {
    loadProfileMock.mockResolvedValue(
      profile({ masteryIndex: { weakPatterns: [], knownWords: [], weakWords: [] }, errorEvents: [] }),
    );
    const r = await recommendReviewTool.execute({}, ctx);
    expect(r.items).toHaveLength(0);
    expect(r.note).toContain("还没有薄弱点");
  });

  it("respects the limit arg", async () => {
    loadProfileMock.mockResolvedValue(
      profile({
        errorEvents: [
          err({ id: "a", source: { type: "lesson", videoId: "v1", cueIdx: 0, questionId: null } }),
          err({ id: "b", source: { type: "lesson", videoId: "v1", cueIdx: 1, questionId: null } }),
          err({ id: "c", source: { type: "lesson", videoId: "v1", cueIdx: 2, questionId: null } }),
        ],
      }),
    );
    const r = await recommendReviewTool.execute({ limit: 2 }, ctx);
    expect(r.items).toHaveLength(2);
  });
});
