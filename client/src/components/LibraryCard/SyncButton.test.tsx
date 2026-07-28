import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryEntry } from "../../types/library";

const { syncToCloudMock, queueState } = vi.hoisted(() => ({
  syncToCloudMock: vi.fn(),
  queueState: {
    upsert: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("../../lib/api/librarySync", () => ({
  syncToCloud: syncToCloudMock,
  friendlySyncError: (raw: string) => raw,
}));

vi.mock("../../store/downloadQueue", () => ({
  useDownloadQueue: {
    getState: () => queueState,
  },
}));

vi.mock("../../store/importQueue", () => ({
  applyUploadResult: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

import { SyncButton } from "./SyncButton";

const entry: LibraryEntry = {
  id: "entry-1",
  title: "A ready video",
  source: { type: "url", url: "https://www.youtube.com/watch?v=entry-1" },
  durationSec: 60,
  thumbnailPath: "",
  createdAt: "2026-07-28T00:00:00.000Z",
  status: "ready",
  lastError: null,
  syncError: "sync failed",
};

beforeEach(() => {
  syncToCloudMock.mockReset();
  queueState.upsert.mockReset();
  queueState.remove.mockReset();
});

describe("SyncButton cloud-sync pricing upsells", () => {
  it.each([
    ["quota_exceeded", "云端视频已达上限", "可解锁到 50 个"],
    ["video_too_large", "视频文件超过上限", "可同步 500MB"],
    ["video_too_long", "视频时长超过上限", "可同步 60 分钟"],
  ])("shows ¥38/month for %s", async (code, title, capability) => {
    syncToCloudMock.mockRejectedValueOnce(new Error(code));

    render(<SyncButton entry={entry} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "sync failed" }));

    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    const message = screen.getByText(new RegExp(capability));
    expect(message).toHaveTextContent("¥38/月");
    expect(message).not.toHaveTextContent("¥12/月");
  });
});
