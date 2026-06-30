import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

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

import { FailedActions } from "./DownloadQueueWidget";

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
  });
});
