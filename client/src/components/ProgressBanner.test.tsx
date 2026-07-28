import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProgressBanner } from "./ProgressBanner";
import { useAnalysis } from "../store/analysis";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("ProgressBanner recovery actions", () => {
  beforeEach(() => {
    useAnalysis.getState().reset();
  });

  it("offers checkpoint continuation for an analysis error", () => {
    const onContinue = vi.fn();
    useAnalysis.setState({
      phase: "error",
      errorMessage: "DeepSeek 暂时不可用",
      errorStage: "analysis",
    });

    render(<ProgressBanner onContinue={onContinue} onRetranscribe={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "继续解析" }));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "重新转录" })).toBeNull();
  });

  it("offers retranscription only for a transcription error", () => {
    const onRetranscribe = vi.fn();
    useAnalysis.setState({
      phase: "error",
      errorMessage: "whisper failed",
      errorStage: "transcription",
    });

    render(<ProgressBanner onContinue={vi.fn()} onRetranscribe={onRetranscribe} />);

    fireEvent.click(screen.getByRole("button", { name: "重新转录" }));
    expect(onRetranscribe).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "继续解析" })).toBeNull();
  });

  it("shows transient provider retry state without turning it into a failure", () => {
    useAnalysis.setState({
      phase: "analyzing",
      retryMessage: "网络波动，正在进行第 2/4 次尝试…",
    });

    render(<ProgressBanner />);

    expect(screen.getByText(/网络波动，正在进行第 2\/4 次尝试/)).toBeInTheDocument();
    expect(screen.queryByText(/^失败/)).toBeNull();
  });
});
