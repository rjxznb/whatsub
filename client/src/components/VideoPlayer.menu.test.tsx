import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VideoPlayer } from "./VideoPlayer";
import { DEFAULT_CAPTION_STYLE } from "../types/settings";

function renderPlayer(onChange = vi.fn()) {
  return render(
    <VideoPlayer
      src=""
      captionStyle={DEFAULT_CAPTION_STYLE}
      onChangeCaptionStyle={onChange}
    />
  );
}

describe("VideoPlayer gear menu", () => {
  it("is closed by default", () => {
    const { queryByTestId } = renderPlayer();
    expect(queryByTestId("gear-menu")).toBeNull();
  });

  it("opens to root view on gear click", () => {
    const { getByTitle, getByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    expect(getByTestId("gear-menu")).toBeTruthy();
    expect(getByTestId("menu-row-speed")).toBeTruthy();
    expect(getByTestId("menu-row-captions")).toBeTruthy();
  });

  it("navigates root → speed submenu and back", () => {
    const { getByTitle, getByTestId, queryByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    fireEvent.click(getByTestId("menu-row-speed"));
    expect(getByTestId("speed-submenu")).toBeTruthy();
    expect(queryByTestId("menu-row-speed")).toBeNull();

    fireEvent.click(getByTestId("menu-back"));
    expect(getByTestId("menu-row-speed")).toBeTruthy();
  });

  it("navigates root → captions submenu and back", () => {
    const { getByTitle, getByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    fireEvent.click(getByTestId("menu-row-captions"));
    expect(getByTestId("captions-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("menu-back"));
    expect(getByTestId("menu-row-captions")).toBeTruthy();
  });

  it("closes when selecting a speed option", () => {
    const { getByTitle, getByTestId, queryByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    fireEvent.click(getByTestId("menu-row-speed"));
    fireEvent.click(getByTestId("speed-1.5"));
    expect(queryByTestId("gear-menu")).toBeNull();
  });

  it("closes on outside-click overlay", () => {
    const { getByTitle, getByTestId, queryByTestId } = renderPlayer();
    fireEvent.click(getByTitle("播放速度 / 字幕设置"));
    expect(getByTestId("gear-menu")).toBeTruthy();
    fireEvent.click(getByTestId("menu-outside-capture"));
    expect(queryByTestId("gear-menu")).toBeNull();
  });
});

describe("VideoPlayer captions submenu", () => {
  function openCaptions(onChange = vi.fn()) {
    const utils = render(
      <VideoPlayer
        src=""
        captionStyle={DEFAULT_CAPTION_STYLE}
        onChangeCaptionStyle={onChange}
      />
    );
    fireEvent.click(utils.getByTitle("播放速度 / 字幕设置"));
    fireEvent.click(utils.getByTestId("menu-row-captions"));
    return { ...utils, onChange };
  }

  it("selecting a font color calls onChangeCaptionStyle with captionFontColor", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("font-color-#FFEB3B"));
    expect(onChange).toHaveBeenCalledWith({ captionFontColor: "#FFEB3B" });
  });

  it("selecting a background color calls onChangeCaptionStyle with captionBackgroundColor", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("bg-color-#2196F3"));
    expect(onChange).toHaveBeenCalledWith({ captionBackgroundColor: "#2196F3" });
  });

  it("selecting a font scale calls onChangeCaptionStyle with captionFontScale", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("font-scale-1.25"));
    expect(onChange).toHaveBeenCalledWith({ captionFontScale: 1.25 });
  });

  it("toggling highlights flips captionHighlightsEnabled", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("toggle-highlights"));
    expect(onChange).toHaveBeenCalledWith({ captionHighlightsEnabled: false });
  });

  it("changing bg opacity slider patches captionBackgroundOpacity", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.change(getByTestId("slider-bg-opacity"), {
      target: { value: "0.5" },
    });
    expect(onChange).toHaveBeenCalledWith({ captionBackgroundOpacity: 0.5 });
  });

  it("changing font opacity slider patches captionFontOpacity", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.change(getByTestId("slider-font-opacity"), {
      target: { value: "0.6" },
    });
    expect(onChange).toHaveBeenCalledWith({ captionFontOpacity: 0.6 });
  });

  it("reset button patches all 6 caption fields to defaults", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("reset-captions"));
    expect(onChange).toHaveBeenCalledWith({
      captionFontColor: "#FFFFFF",
      captionFontScale: 1,
      captionFontOpacity: 1,
      captionBackgroundColor: "#000000",
      captionBackgroundOpacity: 0.7,
      captionHighlightsEnabled: true,
    });
  });

  it("captions submenu does not close after a control interaction", () => {
    const { getByTestId } = openCaptions();
    fireEvent.click(getByTestId("font-color-#FFEB3B"));
    expect(getByTestId("captions-submenu")).toBeTruthy();
  });
});
