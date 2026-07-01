import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

let status: unknown = { type: "idle" };
const update = vi.fn();
vi.mock("../hooks/useYtDlpUpdater", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, useYtDlpUpdater: () => ({ status, checkNow: vi.fn(), update }) };
});

import { YtDlpUpdateToast } from "./YtDlpUpdateToast";

beforeEach(() => { localStorage.clear(); update.mockReset(); });

describe("YtDlpUpdateToast", () => {
  it("renders nothing when idle", () => {
    status = { type: "idle" };
    const { container } = render(<YtDlpUpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });
  it("shows the prompt with the new version when available", () => {
    status = { type: "available", info: { current: "2026.06.09", latest: "2026.07.01", hasUpdate: true, notes: "" } };
    render(<YtDlpUpdateToast />);
    expect(screen.getByText(/yt-dlp/)).toBeInTheDocument();
    expect(screen.getByText(/2026\.07\.01/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /更新/ })).toBeInTheDocument();
  });
  it("does not show a prompt for a skipped version", () => {
    localStorage.setItem("ytdlpSkippedVersions", JSON.stringify(["2026.07.01"]));
    status = { type: "available", info: { current: "2026.06.09", latest: "2026.07.01", hasUpdate: true, notes: "" } };
    const { container } = render(<YtDlpUpdateToast />);
    expect(container).toBeEmptyDOMElement();
  });
});
