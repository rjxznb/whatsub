import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ExportVideoModal } from "./ExportVideoModal";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(save).mockReset().mockResolvedValue("C:\\out.mp4");
});

describe("ExportVideoModal", () => {
  it("passes the current normalized caption position into burned ASS", async () => {
    render(
      <ExportVideoModal
        videoId="video-1"
        videoTitle="Example"
        subtitles={[
          {
            time: 0,
            endTime: 1,
            text: "hello world",
            translation: "你好 世界",
            isKeyPoint: false,
            highlightWords: [],
            keyNotes: {},
            highlightTranslations: {},
          },
        ]}
        durationSec={1}
        captionPosition={{ xRatio: 0.1, yRatio: -0.2 }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "开始导出" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "export_burned_video",
        expect.objectContaining({
          assContent: expect.stringContaining("{\\pos(768,486)}hello world"),
        }),
      ),
    );
  });
});
