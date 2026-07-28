import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";

// Mock useSiteLogin to avoid @tauri-apps/api/event (listen) in tests
vi.mock("../hooks/useSiteLogin", () => ({
  useSiteLogin: () => ({
    presets: [],
    browsers: [],
    selectedBrowser: "",
    setSelectedBrowser: vi.fn(),
    pendingLogin: null,
    starting: false,
    savingLogin: false,
    loginError: null,
    clearError: vi.fn(),
    startLogin: vi.fn(),
    finishLogin: vi.fn(),
    cancelLogin: vi.fn(),
  }),
}));

import { DownloadQueueWidget, FailedActions } from "./DownloadQueueWidget";
import { useBgAnalyses } from "../store/backgroundAnalyses";
import { useDownloadQueue } from "../store/downloadQueue";

describe("FailedActions", () => {
  it("shows a login button for a bot-error on a known site", () => {
    render(
      <FailedActions
        error="ERROR: Sign in to confirm you're not a bot"
        sourceValue="https://www.youtube.com/watch?v=x"
        onRetry={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /立即登录/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("shows no login button for a plain non-login failure", () => {
    render(
      <FailedActions
        error="ffmpeg: Invalid data found when processing input"
        sourceValue="C:/videos/local.mp4"
        onRetry={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /立即登录/ })).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
  it.each([
    ["ERROR: Unable to download webpage: connection timed out", "无法访问视频网站"],
    ["ERROR: This video is private", "视频不可用"],
    ["ERROR: Requested format is not available", "无法解析视频格式"],
  ])("does not offer login for %s", (error, title) => {
    render(
      <FailedActions
        error={error}
        sourceValue="https://www.youtube.com/watch?v=x"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /登录/ })).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("background analysis rows", () => {
  beforeEach(() => {
    useDownloadQueue.setState({ entries: {} });
    useBgAnalyses.setState({ jobs: {} });
  });

  it("shows committed input progress and an explicit continuation action", () => {
    useBgAnalyses.setState({
      jobs: {
        "video-1": {
          videoId: "video-1",
          label: "Video",
          phase: "error",
          subtitleCount: 47,
          committedCueOffset: 50,
          totalCues: 100,
          errorMessage: "temporary provider failure",
          retryMessage: null,
          startedAt: 1,
          subtitles: [],
          summary: null,
        },
      },
    });

    render(<DownloadQueueWidget />);
    fireEvent.click(screen.getByTitle("后台任务（1）"));

    expect(screen.getByRole("button", { name: "继续解析" })).toBeInTheDocument();
    expect(screen.getByText(/temporary provider failure/)).toBeInTheDocument();
  });
});
