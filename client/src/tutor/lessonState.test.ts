import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadLessonState, saveLessonState, clearLessonState } from "./lessonState";
import type { LessonState } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

const sample: LessonState = {
  videoId: "abc",
  startedAt: 0,
  plan: { videoId: "abc", estimateTokens: 3000, overview: "x", anchors: [] },
  currentAnchorIdx: 1,
  currentStep: 3,
  history: [],
  errorsThisSession: [],
};

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("lessonState API", () => {
  it("load returns null when Rust returns null", async () => {
    mockInvoke.mockResolvedValue(null);
    expect(await loadLessonState()).toBeNull();
  });

  it("load returns the parsed state", async () => {
    mockInvoke.mockResolvedValue(sample);
    expect(await loadLessonState()).toEqual(sample);
  });

  it("save passes state under `state` key", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await saveLessonState(sample);
    expect(mockInvoke).toHaveBeenCalledWith("lesson_state_save", { state: sample });
  });

  it("clear invokes lesson_state_clear", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await clearLessonState();
    expect(mockInvoke).toHaveBeenCalledWith("lesson_state_clear");
  });
});
