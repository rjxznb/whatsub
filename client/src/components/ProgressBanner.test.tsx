import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProgressBanner } from "./ProgressBanner";
import { useAnalysis } from "../store/analysis";
import { useAuth } from "../store/auth";
import { SETTINGS_LLM_LINK } from "../llm/quotaRecovery";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const navigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

describe("ProgressBanner recovery actions", () => {
  beforeEach(() => {
    useAnalysis.getState().reset();
    useAuth.setState({
      llmEntitlements: {
        tier: "pro",
        managedRelay: true,
        byok: true,
        tokenTopups: true,
      },
    });
    navigate.mockClear();
  });

  it("shows scheduler wait labels without a fabricated progress bar", () => {
    useAnalysis.setState({ phase: "waiting_compute", progressPercent: 0 });

    const { container, rerender } = render(<ProgressBanner />);

    expect(screen.getByText("等待转录…")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="determinate-progress"]')).toBeNull();

    useAnalysis.setState({ phase: "waiting_download" });
    rerender(<ProgressBanner />);
    expect(screen.getByText("等待下载…")).toBeInTheDocument();
  });

  it("shows canonical and durable partial-batch progress while analyzing", () => {
    const onStop = vi.fn();
    useAnalysis.setState({
      phase: "analyzing",
      committedCueOffset: 50,
      inflightCueCount: 23,
      inflightBatchSize: 50,
      progressPercent: 73,
    });

    render(<ProgressBanner onStop={onStop} />);

    expect(
      screen.getByText(/正式完成 50 条 · 本批已保存 23\/50 条/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "暂停解析" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("keeps the generated-subtitle fallback when paused without an inflight batch", () => {
    useAnalysis.setState({
      phase: "paused",
      subtitles: Array.from({ length: 47 }, (_, index) => ({
        time: index,
        endTime: index + 1,
        text: `Cue ${index + 1}`,
        translation: `Translation ${index + 1}`,
        isKeyPoint: false,
        highlightWords: [],
        keyNotes: {},
        highlightTranslations: {},
      })),
      committedCueOffset: 50,
      inflightCueCount: 0,
      inflightBatchSize: 0,
    });

    render(<ProgressBanner />);

    expect(screen.getByText(/已生成 47 行字幕/)).toBeInTheDocument();
    expect(screen.queryByText(/本批已保存/)).toBeNull();
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

  it("shows quota recovery instead of asking an existing Pro user to upgrade", () => {
    useAnalysis.setState({
      phase: "error",
      errorMessage: "quota exceeded",
      errorUpsell: true,
      errorStage: "analysis",
      quotaError: {
        used: 5_000_000,
        limit: 5_000_000,
        periodResetAt: Date.now() + 60_000,
        committedCueOffset: 50,
        totalCues: 100,
      },
    });

    render(<ProgressBanner onContinue={vi.fn()} />);

    expect(screen.getByText(/本月 AI 额度已用完/)).toBeInTheDocument();
    expect(screen.getByText(/已保存到第 50 条字幕/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "升级 Pro" })).toBeNull();
    expect(screen.queryByRole("button", { name: "继续解析" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "切换自己的 API" }));
    expect(navigate).toHaveBeenCalledWith(SETTINGS_LLM_LINK);
  });

  it("allows checkpoint continuation once the quota reset time has arrived", () => {
    const onContinue = vi.fn();
    useAnalysis.setState({
      phase: "error",
      errorMessage: "quota exceeded",
      errorUpsell: true,
      errorStage: "analysis",
      quotaError: {
        used: 5_000_000,
        limit: 5_000_000,
        periodResetAt: Date.now() - 1,
        committedCueOffset: 50,
        totalCues: 100,
      },
    });

    render(<ProgressBanner onContinue={onContinue} />);

    fireEvent.click(screen.getByRole("button", { name: "继续解析" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
