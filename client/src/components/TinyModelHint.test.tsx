import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  TinyModelHint,
  shouldShowTinyHint,
  tinyHintDismissed,
  SETTINGS_MODEL_LINK,
} from "./TinyModelHint";

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

let model = "tiny";
vi.mock("../store/settings", () => ({
  useSettings: () => ({ settings: { whisperModel: model } }),
}));

describe("shouldShowTinyHint", () => {
  it("shows only for tiny, once subtitles exist, and not after dismiss", () => {
    expect(shouldShowTinyHint("tiny", true, false)).toBe(true);
    expect(shouldShowTinyHint("tiny", false, false)).toBe(false); // no subs yet
    expect(shouldShowTinyHint("tiny", true, true)).toBe(false); // dismissed
    expect(shouldShowTinyHint("small", true, false)).toBe(false); // bigger model
    expect(shouldShowTinyHint("large-v3", true, false)).toBe(false);
  });
});

describe("TinyModelHint", () => {
  beforeEach(() => {
    navigate.mockClear();
    localStorage.clear();
    model = "tiny";
  });

  it("nudges when on the tiny model with subtitles present", () => {
    render(<TinyModelHint hasSubtitles />);
    expect(screen.getByText(/识别可能不够准确/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下载更大的模型/ })).toBeInTheDocument();
  });

  it("stays hidden before subtitles exist (still transcribing)", () => {
    const { container } = render(<TinyModelHint hasSubtitles={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("stays hidden on a non-tiny model", () => {
    model = "small";
    const { container } = render(<TinyModelHint hasSubtitles />);
    expect(container.firstChild).toBeNull();
  });

  it("deep-links to the highlighted Settings model section", () => {
    render(<TinyModelHint hasSubtitles />);
    fireEvent.click(screen.getByRole("button", { name: /下载更大的模型/ }));
    expect(navigate).toHaveBeenCalledWith(SETTINGS_MODEL_LINK);
    expect(SETTINGS_MODEL_LINK).toContain("highlight=whisper-model");
  });

  it("「不再提示」 persists so it never nags again", () => {
    const { container, rerender } = render(<TinyModelHint hasSubtitles />);
    fireEvent.click(screen.getByRole("button", { name: "不再提示" }));
    expect(tinyHintDismissed()).toBe(true);
    expect(container.firstChild).toBeNull(); // gone this session
    rerender(<TinyModelHint hasSubtitles />); // and on a later mount
    expect(container.firstChild).toBeNull();
  });
});
