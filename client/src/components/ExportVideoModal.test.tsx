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
  it("normalizes current player geometry into burned ASS position", async () => {
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
        captionOffset={{ x: 128, y: -144 }}
        captionViewport={{ width: 1280, height: 720 }}
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

  it("keeps stream-copy export free of ASS content", async () => {
    render(
      <ExportVideoModal
        videoId="video-1"
        videoTitle="Example"
        subtitles={[]}
        durationSec={1}
        captionOffset={{ x: 128, y: -144 }}
        captionViewport={{ width: 1280, height: 720 }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText("烧录英文字幕"));
    fireEvent.click(screen.getByLabelText("烧录中文字幕"));
    fireEvent.click(screen.getByRole("button", { name: "导出原视频" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "export_burned_video",
        expect.objectContaining({ assContent: "" }),
      ),
    );
  });
});
