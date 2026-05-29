import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatWidget } from "./ChatWidget";

describe("ChatWidget", () => {
  it("renders the button with Bot icon", () => {
    const { container } = render(
      <ChatWidget open={false} hasUnread={false} onClick={vi.fn()} />
    );
    const button = screen.getByRole("button");
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-label")).toBe("打开 AI 助手");
    expect(container.querySelector("svg.lucide-bot")).toBeTruthy();
  });

  it("aria-label switches when open=true", () => {
    render(<ChatWidget open={true} hasUnread={false} onClick={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toBe("关闭 AI 助手");
  });

  it("shows red dot when hasUnread=true and not open", () => {
    const { container } = render(
      <ChatWidget open={false} hasUnread={true} onClick={vi.fn()} />
    );
    const dots = container.querySelectorAll("span[aria-hidden='true']");
    expect(dots.length > 0).toBe(true);
  });

  it("hides red dot when open=true even if hasUnread=true", () => {
    const { container } = render(
      <ChatWidget open={true} hasUnread={true} onClick={vi.fn()} />
    );
    const dots = container.querySelectorAll(
      "span[aria-hidden='true'].bg-rose-500"
    );
    expect(dots.length).toBe(0);
  });

  it("hides red dot when hasUnread=false", () => {
    const { container } = render(
      <ChatWidget open={false} hasUnread={false} onClick={vi.fn()} />
    );
    const dots = container.querySelectorAll(
      "span[aria-hidden='true'].bg-rose-500"
    );
    expect(dots.length).toBe(0);
  });

  it("clicking calls onClick", () => {
    const onClick = vi.fn();
    render(<ChatWidget open={false} hasUnread={false} onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
