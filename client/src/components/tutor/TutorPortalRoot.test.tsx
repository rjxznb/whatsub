import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TutorPortalRoot } from "./TutorPortalRoot";
import { useTutorRuntime } from "../../store/tutorRuntime";
import { useSettings } from "../../store/settings";
import { usePlayerState } from "../../store/playerState";
import { useAnalysis } from "../../store/analysis";

// Mock roleplaySceneLLM so deriveScenarios resolves with one scenario
const mockDeriveScenarios = vi.fn().mockResolvedValue([
  {
    id: "s1",
    title: "Test Scenario",
    description: "A test scenario",
    userRole: "customer",
    aiRole: "agent",
    sourceVideoId: "v1",
    turns: [],
  },
]);
vi.mock("../../tutor/roleplaySceneLLM", () => ({
  deriveScenarios: (...args: unknown[]) => mockDeriveScenarios(...args),
}));

// Mock learnerProfile module
vi.mock("../../tutor/learnerProfile", () => ({
  useLearnerProfile: {
    getState: () => ({
      logEvent: vi.fn().mockResolvedValue(undefined),
      resolveEvents: vi.fn().mockResolvedValue(undefined),
    }),
  },
  loadLearnerProfile: vi.fn().mockResolvedValue({
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    estimate: { cefr: null, vocabSize: null, listeningLevel: null, confidence: 0 },
    errorEvents: [],
    masteryIndex: { weakPatterns: [], knownWords: [], weakWords: [] },
    goals: [],
  }),
}));

// Mock lesson state persistence
vi.mock("../../tutor/lessonState", () => ({
  saveLessonState: vi.fn().mockResolvedValue(undefined),
  clearLessonState: vi.fn().mockResolvedValue(undefined),
}));

// Mock LLM adapters so no network calls happen
vi.mock("../../tutor/lessonStepLLM", () => ({
  makeLiveLessonLlmAdapter: vi.fn(() => ({
    explain: vi.fn().mockResolvedValue(""),
    question: vi.fn().mockResolvedValue(null),
    feedback: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../tutor/roleplayTurnLLM", () => ({
  generateTurn: vi.fn().mockResolvedValue({ visibleText: "", observedErrors: [] }),
}));

vi.mock("../../tutor/roleplayReportLLM", () => ({
  generateReport: vi.fn().mockResolvedValue({
    totalUserTurns: 0,
    naturalCount: 0,
    chinglishExamples: [],
    patternHits: [],
    registerNotes: [],
    fallback: false,
  }),
}));

// Mock remediationRuntime — must be a class so `new RemediationRuntime(...)` works
vi.mock("../../tutor/remediationRuntime", () => {
  class MockRemediationRuntime {
    state = {
      pattern: "other",
      questions: [{ prompt: "Q1", expectedAnswer: "A1", expected: "A1" }],
      currentIdx: 0,
      correctCount: 0,
      finished: false,
    };
    start = vi.fn();
    submitAnswer = vi.fn();
    isComplete = vi.fn().mockReturnValue(false);
    finish = vi.fn().mockResolvedValue(undefined);
  }
  return { RemediationRuntime: MockRemediationRuntime };
});

beforeEach(() => {
  useTutorRuntime.setState({ mode: { kind: "none" } });

  // Ensure settings store has minimal required shape
  useSettings.setState((s) => ({
    ...s,
    settings: {
      llmProvider: "openai-compatible" as const,
      openaiCompatible: { baseUrl: "https://api.deepseek.com/v1", apiKey: "test", model: "deepseek-chat" },
      claude: { apiKey: "", model: "" },
      gemini: { apiKey: "", model: "" },
      whisperModel: "base" as const,
      libraryDir: "",
      cookiesFile: "",
      cookieSource: "none" as const,
      vendorId: "deepseek",
    },
    loaded: true,
  }));

  // Minimal playerState
  usePlayerState.setState((s) => ({
    ...s,
    videoId: "abc",
    videoTitle: "Test Video",
    currentIdx: null,
    currentTime: null,
    seekHandler: null,
  }));

  // Minimal analysis state — partial update so we don't override methods
  useAnalysis.setState((s) => ({
    ...s,
    videoId: "abc",
    subtitles: [],
    phase: "complete" as const,
    progressPercent: 100,
    summary: null,
  }));
});

describe("TutorPortalRoot", () => {
  it("renders nothing in mode=none", () => {
    const { container } = render(<TutorPortalRoot />);
    expect(container.querySelector("[data-tutor-overlay]")).toBeNull();
  });

  it("renders LessonPreClass in mode=lesson-preclass", async () => {
    useTutorRuntime.setState({
      mode: {
        kind: "lesson-preclass",
        videoId: "abc",
        plan: {
          videoId: "abc",
          estimateTokens: 3000,
          overview: "X",
          anchors: [
            { cueIdx: 3, topic: "T1", whyThisOne: "", targetPatterns: [] },
          ],
        },
      },
    });
    render(<TutorPortalRoot />);
    await waitFor(() => expect(screen.getByText(/准备开课/)).toBeTruthy());
  });

  it("renders RemediationOverlay in mode=remediation", async () => {
    useTutorRuntime.setState({
      mode: { kind: "remediation", pattern: "past_tense_irregular", candidateErrorIds: [] },
    });
    render(<TutorPortalRoot />);
    await waitFor(() => expect(screen.getByText(/3 分钟专项/)).toBeTruthy());
  });

  it("calls deriveScenarios when roleplay-picker mounts with loading:true", async () => {
    mockDeriveScenarios.mockClear();
    useTutorRuntime.setState({
      mode: {
        kind: "roleplay-picker",
        scenarios: [],
        loading: true,
        sourceVideoId: "v1",
      },
    });
    render(<TutorPortalRoot />);
    await waitFor(() => expect(mockDeriveScenarios).toHaveBeenCalledTimes(1));
  });
});
