import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { InputBox } from "./InputBox";

describe("InputBox", () => {
  it("renders textarea with placeholder '问点什么…' when idle", () => {
    const { container } = render(
      <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.placeholder).toBe("问点什么…");
  });

  it("placeholder switches to 'agent 正在思考…' when streaming", () => {
    const { container } = render(
      <InputBox streaming={true} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("agent 正在思考…");
  });

  it("placeholder switches to '请先配置 LLM 后再使用' when noLlm", () => {
    const { container } = render(
      <InputBox streaming={false} noLlm={true} onSend={vi.fn()} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.placeholder).toBe("请先配置 LLM 后再使用");
  });

  it("sends text on Enter and clears textarea", () => {
    const onSend = vi.fn();
    const { container } = render(
      <InputBox streaming={false} noLlm={false} onSend={onSend} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello world" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello world");
    expect(textarea.value).toBe("");
  });

  it("does not submit on Shift+Enter", () => {
    const onSend = vi.fn();
    const { container } = render(
      <InputBox streaming={false} noLlm={false} onSend={onSend} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "line1\nline2" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toContain("line1");
  });

  it("disables send button when textarea is empty", () => {
    const { container } = render(
      <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />
    );
    const sendButton = container.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
  });

  it("renders stop button when streaming, clicking calls onStop", () => {
    const onStop = vi.fn();
    const { container } = render(
      <InputBox streaming={true} noLlm={false} onSend={vi.fn()} onStop={onStop} />
    );
    const stopButton = container.querySelector('button[aria-label="停止"]') as HTMLButtonElement;
    expect(stopButton).toBeTruthy();
    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalled();
  });

  it("disables textarea when noLlm is true", () => {
    const { container } = render(
      <InputBox streaming={false} noLlm={true} onSend={vi.fn()} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it("pre-fills textarea with initialValue", () => {
    const { container } = render(
      <InputBox
        streaming={false}
        noLlm={false}
        initialValue="test message"
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("test message");
  });

  it("trims whitespace before sending", () => {
    const onSend = vi.fn();
    const { container } = render(
      <InputBox streaming={false} noLlm={false} onSend={onSend} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "  hello  " } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("does not send when streaming", () => {
    const onSend = vi.fn();
    const { container } = render(
      <InputBox streaming={true} noLlm={false} onSend={onSend} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("enables send button when text is not empty", () => {
    const { container } = render(
      <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const sendButton = container.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    fireEvent.change(textarea, { target: { value: "some text" } });
    expect(sendButton.disabled).toBe(false);
  });
});
