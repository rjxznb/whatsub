import { describe, it, expect, beforeEach } from "vitest";
import { computeLessonSummary, shouldOfferRemediation } from "./lessonSummary";
import type { LessonState, LearnerProfile } from "./types";

const baseState: LessonState = {
  videoId: "v1",
  startedAt: 0,
  plan: {
    videoId: "v1",
    estimateTokens: 3000,
    overview: "x",
    anchors: [
      { cueIdx: 3, topic: "T1", whyThisOne: "", targetPatterns: ["preposition_wrong"] },
      { cueIdx: 12, topic: "T2", whyThisOne: "", targetPatterns: ["present_perfect_vs_past"] },
      { cueIdx: 24, topic: "T3", whyThisOne: "", targetPatterns: ["article_missing"] },
    ],
  },
  currentAnchorIdx: 3,
  currentStep: 5,
  errorsThisSession: ["e1", "e2"],
  history: [
    { cueIdx: 3, topic: "T1", attempts: 1, errorIds: [], finalCorrect: true },
    { cueIdx: 12, topic: "T2", attempts: 2, errorIds: ["e1"], finalCorrect: false },
    { cueIdx: 24, topic: "T3", attempts: 1, errorIds: ["e2"], finalCorrect: true },
  ],
};

describe("computeLessonSummary", () => {
  it("counts correct vs total anchors", () => {
    const s = computeLessonSummary(baseState);
    expect(s.correctCount).toBe(2);
    expect(s.totalAnchors).toBe(3);
  });

  it("lists topics learned", () => {
    const s = computeLessonSummary(baseState);
    expect(s.topicsLearned).toEqual(["T1", "T2", "T3"]);
  });
});

describe("shouldOfferRemediation", () => {
  const now = 1000_000;
  const day = 24 * 60 * 60 * 1000;

  function profileWithPattern(occ: number, lastRemediatedAt: number | null): LearnerProfile {
    return {
      version: 1,
      createdAt: 0,
      updatedAt: now,
      estimate: { cefr: null, vocabSize: null, listeningLevel: null, confidence: 0 },
      errorEvents: [],
      masteryIndex: {
        weakPatterns: [{
          pattern: "past_tense_irregular",
          occurrences: occ,
          lastSeenAt: now,
          sampleErrorIds: [],
          lastRemediatedAt,
        }],
        knownWords: [],
        weakWords: [],
      },
      goals: [],
    };
  }

  it("offers when occurrences ≥3 and no prior remediation", () => {
    const offer = shouldOfferRemediation(profileWithPattern(3, null), now);
    expect(offer).not.toBeNull();
    expect(offer!.pattern).toBe("past_tense_irregular");
    expect(offer!.occurrences).toBe(3);
  });

  it("declines when occurrences <3", () => {
    expect(shouldOfferRemediation(profileWithPattern(2, null), now)).toBeNull();
  });

  it("declines when last remediation <3 days ago", () => {
    expect(shouldOfferRemediation(profileWithPattern(5, now - day), now)).toBeNull();
  });

  it("offers again when last remediation >3 days ago", () => {
    const offer = shouldOfferRemediation(profileWithPattern(5, now - 4 * day), now);
    expect(offer).not.toBeNull();
  });

  it("returns the highest-occurrence eligible pattern", () => {
    const p: LearnerProfile = {
      ...profileWithPattern(3, null),
      masteryIndex: {
        weakPatterns: [
          { pattern: "article_missing", occurrences: 3, lastSeenAt: 0, sampleErrorIds: [], lastRemediatedAt: null },
          { pattern: "past_tense_irregular", occurrences: 7, lastSeenAt: 0, sampleErrorIds: [], lastRemediatedAt: null },
        ],
        knownWords: [],
        weakWords: [],
      },
    };
    const offer = shouldOfferRemediation(p, now);
    expect(offer!.pattern).toBe("past_tense_irregular");
  });
});

import {
  canShowRemediationOfferToday,
  markRemediationOfferShown,
} from "./lessonSummary";

describe("daily remediation throttle", () => {
  const now = 1700_000_000_000;

  beforeEach(() => {
    localStorage.clear();
  });

  it("allows when never shown", () => {
    expect(canShowRemediationOfferToday(now)).toBe(true);
  });

  it("blocks within 24h", () => {
    markRemediationOfferShown(now - 12 * 60 * 60 * 1000);
    expect(canShowRemediationOfferToday(now)).toBe(false);
  });

  it("allows after 24h", () => {
    markRemediationOfferShown(now - 25 * 60 * 60 * 1000);
    expect(canShowRemediationOfferToday(now)).toBe(true);
  });

  it("ignores corrupt timestamps (fail-open)", () => {
    localStorage.setItem("tutor.remediationLastShownAt", "garbage");
    expect(canShowRemediationOfferToday(now)).toBe(true);
  });
});
