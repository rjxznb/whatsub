import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HighlightWord } from "./HighlightWord";

const mocks = vi.hoisted(() => ({
  speak: vi.fn(),
  toggle: vi.fn(async () => undefined),
}));

vi.mock("../hooks/useSpeech", () => ({
  useSpeech: () => ({
    voices: [],
    voiceURI: null,
    setVoiceURI: vi.fn(),
    hasEnglish: true,
    speak: mocks.speak,
  }),
}));

vi.mock("../store/vocab", () => ({
  useVocabulary: () => ({ toggle: mocks.toggle, has: () => false }),
}));

const props = {
  word: "catch up",
  meaningZh: "赶上进度",
  note: "表示补回落下的工作、学习任务或进度，常与 on 或 with 搭配使用。",
  videoId: "video-1",
  videoTitle: "Demo video",
  cueTime: 12.5,
  cueText: "I need to catch up on emails.",
};

describe("HighlightWord", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.speak.mockClear();
    mocks.toggle.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("shows meaning and explanation and stays open while crossing into the card", () => {
    render(<HighlightWord {...props} />);
    const trigger = screen.getByText("catch up");
    fireEvent.mouseEnter(trigger);

    expect(screen.getByText("赶上进度")).toBeInTheDocument();
    expect(screen.getByText(props.note)).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(screen.getByTestId("highlight-phrase-card"));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByTestId("highlight-phrase-card")).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByTestId("highlight-phrase-card"));
    act(() => vi.advanceTimersByTime(151));
    expect(screen.queryByTestId("highlight-phrase-card")).not.toBeInTheDocument();
  });

  it("speaks and saves the phrase without bubbling to the subtitle row", async () => {
    const rowClick = vi.fn();
    render(<div onClick={rowClick}><HighlightWord {...props} /></div>);
    fireEvent.mouseEnter(screen.getByText("catch up"));

    fireEvent.click(screen.getByRole("button", { name: "朗读短语" }));
    expect(mocks.speak).toHaveBeenCalledWith("catch up");

    fireEvent.click(screen.getByTitle("收藏到我的词汇本"));
    expect(mocks.toggle).toHaveBeenCalledWith({
      expression: "catch up",
      meaningZh: "赶上进度",
      usage: props.note,
      videoId: "video-1",
      videoTitle: "Demo video",
      cueTime: 12.5,
      cueText: "I need to catch up on emails.",
    });
    expect(rowClick).not.toHaveBeenCalled();
  });
});
