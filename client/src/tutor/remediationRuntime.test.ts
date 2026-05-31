import { describe, it, expect, vi, beforeEach } from "vitest";
import { RemediationRuntime, isAnswerCorrect } from "./remediationRuntime";

const mockProfile = { resolveEvents: vi.fn(), logEvent: vi.fn() };

beforeEach(() => {
  mockProfile.resolveEvents.mockReset();
  mockProfile.logEvent.mockReset();
});

describe("isAnswerCorrect", () => {
  it("exact match (case + whitespace tolerant)", () => {
    expect(isAnswerCorrect("She bought a book.", "she bought a book")).toBe(true);
    expect(isAnswerCorrect("She bought a book.", "she bought a book.")).toBe(true);
  });

  it("ignores trailing punctuation", () => {
    expect(isAnswerCorrect("He goes home", "He goes home.")).toBe(true);
  });

  it("rejects substantive mismatches", () => {
    expect(isAnswerCorrect("She buys", "She bought a book")).toBe(false);
  });
});

describe("RemediationRuntime", () => {
  it("starts with the first question", () => {
    const r = new RemediationRuntime({
      pattern: "past_tense_irregular",
      candidateErrorIds: ["e1"],
      profile: mockProfile,
    });
    r.start();
    expect(r.state.currentIdx).toBe(0);
    expect(r.state.questions.length).toBeGreaterThanOrEqual(3);
  });

  it("submitAnswer advances + tallies correct count", () => {
    const r = new RemediationRuntime({
      pattern: "past_tense_irregular",
      candidateErrorIds: [],
      profile: mockProfile,
    });
    r.start();
    const first = r.state.questions[0];
    r.submitAnswer(first.expected);
    expect(r.state.currentIdx).toBe(1);
    expect(r.state.correctCount).toBe(1);
  });

  it("wrong answer still advances but doesn't tally", () => {
    const r = new RemediationRuntime({
      pattern: "past_tense_irregular",
      candidateErrorIds: [],
      profile: mockProfile,
    });
    r.start();
    r.submitAnswer("definitely wrong");
    expect(r.state.currentIdx).toBe(1);
    expect(r.state.correctCount).toBe(0);
  });

  it("finish with ≥70% correct resolves all candidateErrorIds", async () => {
    mockProfile.resolveEvents.mockResolvedValue(undefined);
    const r = new RemediationRuntime({
      pattern: "past_tense_irregular",
      candidateErrorIds: ["e1", "e2", "e3"],
      profile: mockProfile,
    });
    r.start();
    for (const q of r.state.questions) r.submitAnswer(q.expected);
    await r.finish();
    expect(mockProfile.resolveEvents).toHaveBeenCalledWith(["e1", "e2", "e3"]);
  });

  it("finish with <70% correct resolves nothing", async () => {
    mockProfile.resolveEvents.mockResolvedValue(undefined);
    const r = new RemediationRuntime({
      pattern: "past_tense_irregular",
      candidateErrorIds: ["e1"],
      profile: mockProfile,
    });
    r.start();
    for (const _q of r.state.questions) r.submitAnswer("wrong");
    await r.finish();
    expect(mockProfile.resolveEvents).not.toHaveBeenCalled();
  });
});
