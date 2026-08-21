import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

let status: unknown = { type: "idle" };
let appStatus: unknown = { type: "none" };
const update = vi.fn();
vi.mock("../hooks/useYtDlpUpdater", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, useYtDlpUpdater: () => ({ status, checkNow: vi.fn(), update }) };
});
vi.mock("../hooks/useUpdater", () => ({
  useUpdater: () => ({ status: appStatus, checkNow: vi.fn(), downloadAndInstall: vi.fn() }),
}));

import { YtDlpUpdateToast } from "./YtDlpUpdateToast";

beforeEach(() => {
  localStorage.clear();
  update.mockReset();
  appStatus = { type: "none" };
});

describe("YtDlpUpdateToast", () => {
  it("renders nothing when idle", () => {
    status = { type: "idle" };
    const { container } = render(<YtDlpUpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });
  it("uses the same generic blue bottom-right UI as an app update", () => {
    status = {
      type: "available",
      info: {
        current: "2026.06.09",
        latest: "2026.07.01",
        hasUpdate: true,
        notes: "very long yt-dlp release notes",
      },
    };
    const { container } = render(<YtDlpUpdateToast />);

    expect(screen.getByText("发现新版本")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即更新" })).toBeInTheDocument();
    expect(screen.queryByText(/yt-dlp/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/very long/i)).not.toBeInTheDocument();
    expect(container.firstChild).toHaveClass("right-4");
    expect(container.firstChild).not.toHaveClass("left-4");
    expect(screen.getByRole("button", { name: "立即更新" })).toHaveClass("bg-blue-500");
  });

  it("stays hidden while an app update prompt has priority", () => {
    appStatus = { type: "available", update: { version: "0.1.110" } };
    status = { type: "available", info: { current: "2026.06.09", latest: "2026.07.01", hasUpdate: true, notes: "" } };

    const { container } = render(<YtDlpUpdateToast />);

    expect(container).toBeEmptyDOMElement();
  });
  it("does not show a prompt for a skipped version", () => {
    localStorage.setItem("ytdlpSkippedVersions", JSON.stringify(["2026.07.01"]));
    status = { type: "available", info: { current: "2026.06.09", latest: "2026.07.01", hasUpdate: true, notes: "" } };
    const { container } = render(<YtDlpUpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });
});
