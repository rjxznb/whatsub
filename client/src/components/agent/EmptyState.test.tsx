import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("noLlm=true shows the configure-LLM copy", () => {
    const { container } = render(<EmptyState noLlm={true} />);
    expect(container.textContent).toContain("需要先配置 LLM");
    expect(container.textContent).toContain("在 Settings 里填入 API key 后回来这里");
  });

  it("renders '打开设置' button when noLlm is true", () => {
    const { container } = render(<EmptyState noLlm={true} />);
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.textContent).toBe("打开设置");
  });

  it("calls onOpenSettings when '打开设置' button is clicked", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(
      <EmptyState noLlm={true} onOpenSettings={onOpenSettings} />,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows default suggestions when noLlm is false", () => {
    const { container } = render(<EmptyState noLlm={false} />);
    expect(container.textContent).toContain("我可以帮你：");
    expect(container.textContent).toContain(
      "在 YouTube 上找几个 medical 场景的视频",
    );
    expect(container.textContent).toContain(
      '查 "appointment" 这个短语在语料库的用法',
    );
    expect(container.textContent).toContain("把上次的 GP 视频从云端拉回本地");
  });

  it("calls onSuggestionClick when a suggestion is clicked", () => {
    const onSuggestionClick = vi.fn();
    const { container } = render(
      <EmptyState noLlm={false} onSuggestionClick={onSuggestionClick} />,
    );
    const buttons = container.querySelectorAll("button");
    const suggestionBtn = Array.from(buttons).find((b) =>
      b.textContent?.includes("在 YouTube 上找几个 medical 场景的视频"),
    );
    expect(suggestionBtn).toBeTruthy();
    fireEvent.click(suggestionBtn!);
    expect(onSuggestionClick).toHaveBeenCalledWith(
      "在 YouTube 上找几个 medical 场景的视频",
    );
  });

  it("uses custom suggestions when provided", () => {
    const customSuggestions = ["custom 1", "custom 2"];
    const { container } = render(
      <EmptyState noLlm={false} suggestions={customSuggestions} />,
    );
    expect(container.textContent).toContain("custom 1");
    expect(container.textContent).toContain("custom 2");
  });

  it("calls onSuggestionClick with correct text for custom suggestions", () => {
    const onSuggestionClick = vi.fn();
    const customSuggestions = ["custom suggestion"];
    const { container } = render(
      <EmptyState
        noLlm={false}
        suggestions={customSuggestions}
        onSuggestionClick={onSuggestionClick}
      />,
    );
    const buttons = container.querySelectorAll("button");
    const suggestionBtn = Array.from(buttons).find((b) =>
      b.textContent?.includes("custom suggestion"),
    );
    expect(suggestionBtn).toBeTruthy();
    fireEvent.click(suggestionBtn!);
    expect(onSuggestionClick).toHaveBeenCalledWith("custom suggestion");
  });

  it("does not show suggestions section when noLlm is true", () => {
    const { container } = render(<EmptyState noLlm={true} />);
    expect(container.textContent).not.toContain("我可以帮你：");
    expect(container.textContent).not.toContain(
      "在 YouTube 上找几个 medical 场景的视频",
    );
  });

  it("shows capability bullets when noLlm is false", () => {
    const { container } = render(<EmptyState noLlm={false} />);
    expect(container.textContent).toContain("在 YouTube 搜视频");
    expect(container.textContent).toContain("查公共语料库的短语用法");
    expect(container.textContent).toContain("在视频里解释、出题、标连读");
    expect(container.textContent).toContain("加生词本、同步到云、管理库");
  });
});
