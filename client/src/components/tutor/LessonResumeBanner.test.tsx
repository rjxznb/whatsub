import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LessonResumeBanner } from "./LessonResumeBanner";
import type { LessonState } from "../../tutor/types";

vi.mock("../../tutor/lessonState", () => ({
  loadLessonState: vi.fn(),
  clearLessonState: vi.fn(),
}));
import { loadLessonState, clearLessonState } from "../../tutor/lessonState";
const mockLoad = loadLessonState as ReturnType<typeof vi.fn>;
const mockClear = clearLessonState as ReturnType<typeof vi.fn>;

const sample: LessonState = {
  videoId: "abc",
  startedAt: 0,
  plan: {
    videoId: "abc",
    estimateTokens: 3000,
    overview: "",
    anchors: [
      { cueIdx: 3, topic: "T1", whyThisOne: "", targetPatterns: [] },
      { cueIdx: 12, topic: "T2", whyThisOne: "", targetPatterns: [] },
      { cueIdx: 24, topic: "T3", whyThisOne: "", targetPatterns: [] },
    ],
  },
  currentAnchorIdx: 1, // 1/3 completed
  currentStep: 3,
  history: [
    { cueIdx: 3, topic: "T1", attempts: 1, errorIds: [], finalCorrect: true },
  ],
  errorsThisSession: [],
};

beforeEach(() => {
  mockLoad.mockReset();
  mockClear.mockReset();
});

describe("LessonResumeBanner", () => {
  it("renders nothing when no pending state for this video", async () => {
    mockLoad.mockResolvedValue(null);
    const { container } = render(
      <LessonResumeBanner videoId="abc" onResume={vi.fn()} />,
    );
    await waitFor(() => expect(mockLoad).toHaveBeenCalled());
    expect(container.querySelector("[data-tutor-resume]")).toBeNull();
  });

  it("renders nothing when pending state belongs to a different video", async () => {
    mockLoad.mockResolvedValue({ ...sample, videoId: "other" });
    const { container } = render(
      <LessonResumeBanner videoId="abc" onResume={vi.fn()} />,
    );
    await waitFor(() => expect(mockLoad).toHaveBeenCalled());
    // The banner deliberately ignores pending lessons from other videos —
    // user is on Player for `abc`, showing a banner for `other` is noise.
    expect(container.querySelector("[data-tutor-resume]")).toBeNull();
  });

  it("renders banner with 1 / 3 progress when matching video has pending state", async () => {
    mockLoad.mockResolvedValue(sample);
    render(<LessonResumeBanner videoId="abc" onResume={vi.fn()} />);
    await screen.findByText(/上次精讲到/);
    expect(screen.getByText(/1 \/ 3/)).toBeTruthy();
  });

  it("clicking 继续 calls onResume with the loaded state", async () => {
    mockLoad.mockResolvedValue(sample);
    const onResume = vi.fn();
    render(<LessonResumeBanner videoId="abc" onResume={onResume} />);
    fireEvent.click(await screen.findByRole("button", { name: /继续/ }));
    expect(onResume).toHaveBeenCalledWith(sample);
  });

  it("clicking 重新开始 calls clearLessonState + hides banner", async () => {
    mockLoad.mockResolvedValue(sample);
    mockClear.mockResolvedValue(undefined);
    const { container } = render(
      <LessonResumeBanner videoId="abc" onResume={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /重新开始/ }));
    await waitFor(() => expect(mockClear).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector("[data-tutor-resume]")).toBeNull(),
    );
  });

  it("clicking 关掉 hides banner without clearing state (so user can resume later)", async () => {
    mockLoad.mockResolvedValue(sample);
    const { container } = render(
      <LessonResumeBanner videoId="abc" onResume={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /关掉/ }));
    await waitFor(() =>
      expect(container.querySelector("[data-tutor-resume]")).toBeNull(),
    );
    expect(mockClear).not.toHaveBeenCalled();
  });
});
