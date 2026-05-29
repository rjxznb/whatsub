import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("shows 'AI 助手需要先配置 LLM' when noLlm is true", () => {
    const { container } = render(<EmptyState noLlm={true} />);
    expect(container.textContent).toContain("AI 助手需要先配置 LLM");
    expect(container.textContent).toContain("支持 DeepSeek / Claude / Gemini / OpenAI 等");
  });

  it("renders '打开设置' button when noLlm is true", () => {
    const { container } = render(<EmptyState noLlm={true} />);
    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.textContent).toBe("打开设置");
  });

  it("calls onOpenSettings when '打开设置' button is clicked", () => {
    const onOpenSettings = vi.fn();
    const { container } = render(<EmptyState noLlm={true} onOpenSettings={onOpenSettings} />);
    const button = container.querySelector('button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows default suggestions when noLlm is false", () => {
    const { container } = render(<EmptyState noLlm={false} />);
    expect(container.textContent).toContain("AI 助手能帮你：");
    expect(container.textContent).toContain("▶ 找几个 medical 场景的视频");
    expect(container.textContent).toContain("▶ 把这一段加生词本");
    expect(container.textContent).toContain("▶ 解释一下这个英语短语");
  });

  it("calls onSuggestionClick when a suggestion is clicked", () => {
    const onSuggestionClick = vi.fn();
    const { container } = render(<EmptyState noLlm={false} onSuggestionClick={onSuggestionClick} />);
    const buttons = container.querySelectorAll('button');
    const suggestionBtn = Array.from(buttons).find(b => b.textContent?.includes("找几个 medical 场景的视频"));
    expect(suggestionBtn).toBeTruthy();
    fireEvent.click(suggestionBtn!);
    expect(onSuggestionClick).toHaveBeenCalledWith("找几个 medical 场景的视频");
  });

  it("uses custom suggestions when provided", () => {
    const customSuggestions = ["custom 1", "custom 2"];
    const { container } = render(<EmptyState noLlm={false} suggestions={customSuggestions} />);
    expect(container.textContent).toContain("▶ custom 1");
    expect(container.textContent).toContain("▶ custom 2");
  });

  it("calls onSuggestionClick with correct text for custom suggestions", () => {
    const onSuggestionClick = vi.fn();
    const customSuggestions = ["custom suggestion"];
    const { container } = render(
      <EmptyState
        noLlm={false}
        suggestions={customSuggestions}
        onSuggestionClick={onSuggestionClick}
      />
    );
    const buttons = container.querySelectorAll('button');
    const suggestionBtn = Array.from(buttons).find(b => b.textContent?.includes("custom suggestion"));
    expect(suggestionBtn).toBeTruthy();
    fireEvent.click(suggestionBtn!);
    expect(onSuggestionClick).toHaveBeenCalledWith("custom suggestion");
  });

  it("does not show suggestions section when noLlm is true", () => {
    const { container } = render(<EmptyState noLlm={true} />);
    expect(container.textContent).not.toContain("AI 助手能帮你：");
    expect(container.textContent).not.toContain("▶ 找几个 medical 场景的视频");
  });

  it("shows capability bullets when noLlm is false", () => {
    const { container } = render(<EmptyState noLlm={false} />);
    expect(container.textContent).toContain("• 查公共语料库找视频");
    expect(container.textContent).toContain("• 加生词本 / 同步到云");
    expect(container.textContent).toContain("• 在视频里解释一段 / 出题 / 标连读");
  });
});
