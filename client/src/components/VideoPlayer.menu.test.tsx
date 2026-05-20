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

describe("VideoPlayer captions submenu (YouTube-style nested)", () => {
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

  it("captions level shows row for each setting with current value", () => {
    const { getByTestId } = openCaptions();
    expect(getByTestId("captions-row-fontColor")).toBeTruthy();
    expect(getByTestId("captions-row-fontScale")).toBeTruthy();
    expect(getByTestId("captions-row-fontOpacity")).toBeTruthy();
    expect(getByTestId("captions-row-highlights")).toBeTruthy();
    expect(getByTestId("captions-row-bgColor")).toBeTruthy();
    expect(getByTestId("captions-row-bgOpacity")).toBeTruthy();
  });

  it("font color row → deep submenu → pick yellow → patches + auto-back", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("captions-row-fontColor"));
    expect(getByTestId("captions-fontColor-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("font-color-#FFEB3B"));
    expect(onChange).toHaveBeenCalledWith({ captionFontColor: "#FFEB3B" });
    // Auto-back to captions submenu after pick
    expect(getByTestId("captions-submenu")).toBeTruthy();
  });

  it("bg color row → deep submenu → pick blue → patches captionBackgroundColor", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("captions-row-bgColor"));
    expect(getByTestId("captions-bgColor-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("bg-color-#2196F3"));
    expect(onChange).toHaveBeenCalledWith({ captionBackgroundColor: "#2196F3" });
  });

  it("font scale row → deep submenu → pick large", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("captions-row-fontScale"));
    expect(getByTestId("captions-fontScale-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("font-scale-1.25"));
    expect(onChange).toHaveBeenCalledWith({ captionFontScale: 1.25 });
  });

  it("font opacity row → deep submenu → pick 50%", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("captions-row-fontOpacity"));
    expect(getByTestId("captions-fontOpacity-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("font-opacity-0.5"));
    expect(onChange).toHaveBeenCalledWith({ captionFontOpacity: 0.5 });
  });

  it("bg opacity row → deep submenu → pick 0%", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("captions-row-bgOpacity"));
    expect(getByTestId("captions-bgOpacity-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("bg-opacity-0"));
    expect(onChange).toHaveBeenCalledWith({ captionBackgroundOpacity: 0 });
  });

  it("highlights row → deep submenu → pick 隐藏", () => {
    const { getByTestId, onChange } = openCaptions();
    fireEvent.click(getByTestId("captions-row-highlights"));
    expect(getByTestId("captions-highlights-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("highlights-off"));
    expect(onChange).toHaveBeenCalledWith({ captionHighlightsEnabled: false });
  });

  it("deep submenu back button returns to captions level", () => {
    const { getByTestId } = openCaptions();
    fireEvent.click(getByTestId("captions-row-fontColor"));
    expect(getByTestId("captions-fontColor-submenu")).toBeTruthy();
    fireEvent.click(getByTestId("menu-back"));
    expect(getByTestId("captions-submenu")).toBeTruthy();
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
});
