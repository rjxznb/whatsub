import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LessonOverlay } from "./LessonOverlay";

describe("LessonOverlay", () => {
  it("renders null when closed", () => {
    const { container } = render(
      <LessonOverlay open={false} onClose={vi.fn()}>
        <div>hidden</div>
      </LessonOverlay>,
    );
    expect(container.querySelector("[data-tutor-overlay]")).toBeNull();
  });

  it("renders children + a backdrop when open", () => {
    render(
      <LessonOverlay open={true} onClose={vi.fn()}>
        <div data-testid="content">test</div>
      </LessonOverlay>,
    );
    expect(screen.getByTestId("content")).toBeTruthy();
    expect(document.querySelector("[data-tutor-overlay]")).toBeTruthy();
  });

  it("Esc key calls onClose", () => {
    const onClose = vi.fn();
    render(
      <LessonOverlay open={true} onClose={onClose}>
        <div>x</div>
      </LessonOverlay>,
    );
    const event = new KeyboardEvent("keydown", { key: "Escape" });
    document.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
