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
