import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { InputBox } from "./InputBox";
import { useAgent } from "../../store/agent";
import type { Conversation } from "../../types/agent";

function seedConv(userTexts: string[]) {
  const messages = userTexts.map((content, i) => ({
    role: "user" as const,
    id: `u${i}`,
    ts: i,
    content,
  }));
  const conv: Conversation = {
    id: "c1",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    pageContextAtStart: { pathname: "/" },
    summaryUpToMsgId: null,
    summary: null,
    messages,
  };
  useAgent.setState({
    history: {
      version: 1,
      activeConversationId: "c1",
      conversations: [conv],
    },
    hydrated: true,
  });
}

beforeEach(() => {
  // Reset to empty store before every test so the existing tests, which
  // don't care about history, behave as before (userMessages = []).
  useAgent.setState({
    history: { version: 1, activeConversationId: null, conversations: [] },
    hydrated: true,
  });
});

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

  // ── History navigation (Task 32) ────────────────────────────────────────

  describe("keyboard history navigation", () => {
    it("ArrowUp on empty input with 3 history entries fills with newest", () => {
      seedConv(["first", "second", "third"]);
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      expect(ta.value).toBe("third");
    });

    it("ArrowUp twice goes to second-newest", () => {
      seedConv(["first", "second", "third"]);
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      expect(ta.value).toBe("second");
    });

    it("ArrowUp past oldest stays at oldest (no wrap)", () => {
      seedConv(["first", "second", "third"]);
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      fireEvent.keyDown(ta, { key: "ArrowUp" }); // over-up
      expect(ta.value).toBe("first");
    });

    it("ArrowDown from a middle history index moves forward to newest", () => {
      seedConv(["first", "second", "third"]);
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: "ArrowUp" }); // third
      fireEvent.keyDown(ta, { key: "ArrowUp" }); // second
      fireEvent.keyDown(ta, { key: "ArrowDown" }); // back to third
      expect(ta.value).toBe("third");
    });

    it("ArrowDown past newest restores empty draft and clears nav state", () => {
      seedConv(["first", "second", "third"]);
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: "ArrowUp" }); // third
      fireEvent.keyDown(ta, { key: "ArrowDown" }); // past newest → ""
      expect(ta.value).toBe("");
    });

    it("ArrowUp with saved draft 'abc', then ArrowDown past newest, restores 'abc'", () => {
      seedConv(["first", "second"]);
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      // Type a draft.
      fireEvent.change(ta, { target: { value: "abc" } });
      // ArrowUp → newest (second), draft "abc" saved.
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      expect(ta.value).toBe("second");
      // ArrowDown past newest → restores "abc".
      fireEvent.keyDown(ta, { key: "ArrowDown" });
      expect(ta.value).toBe("abc");
    });

    it("typing while in nav mode exits nav (next ArrowUp starts from newest again)", () => {
      seedConv(["first", "second", "third"]);
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: "ArrowUp" }); // third
      fireEvent.keyDown(ta, { key: "ArrowUp" }); // second
      // User edits the recalled text → nav exits.
      fireEvent.change(ta, { target: { value: "second edited" } });
      // Next ArrowUp should start fresh from newest.
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      expect(ta.value).toBe("third");
    });

    it("ArrowUp with empty history is a no-op", () => {
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={vi.fn()} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: "ArrowUp" });
      expect(ta.value).toBe("");
    });

    it("submitting clears history nav state", () => {
      seedConv(["first", "second"]);
      const onSend = vi.fn();
      const { container } = render(
        <InputBox streaming={false} noLlm={false} onSend={onSend} onStop={vi.fn()} />,
      );
      const ta = container.querySelector("textarea") as HTMLTextAreaElement;
      fireEvent.keyDown(ta, { key: "ArrowUp" }); // recall "second"
      fireEvent.keyDown(ta, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("second");
      expect(ta.value).toBe("");
    });
  });
});
