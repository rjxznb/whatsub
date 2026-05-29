import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatPanel } from "./ChatPanel";
import { useAgent } from "../../store/agent";

// ConversationHeader uses plugin-dialog's confirm; mock it so it doesn't
// throw outside the Tauri runtime.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  useAgent.setState({
    history: { version: 1, activeConversationId: null, conversations: [] },
    hydrated: true,
  });
});

describe("ChatPanel", () => {
  it("renders the dialog when open=true", () => {
    render(<ChatPanel open={true} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "AI 助手" });
    expect(dialog).toBeTruthy();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <ChatPanel open={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("pressing Escape fires onClose", () => {
    const onClose = vi.fn();
    render(<ChatPanel open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does NOT listen for Escape when open=false", () => {
    const onClose = vi.fn();
    render(<ChatPanel open={false} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders children inside the body slot", () => {
    render(
      <ChatPanel open={true} onClose={vi.fn()}>
        <div data-testid="body-content">hello body</div>
      </ChatPanel>,
    );
    expect(screen.getByTestId("body-content").textContent).toBe("hello body");
  });

  it("renders inputBox when provided", () => {
    render(
      <ChatPanel
        open={true}
        onClose={vi.fn()}
        inputBox={<div data-testid="input-slot">input here</div>}
      />,
    );
    expect(screen.getByTestId("input-slot").textContent).toBe("input here");
  });

  it("omits the input row when inputBox is not provided", () => {
    const { container } = render(
      <ChatPanel open={true} onClose={vi.fn()}>
        <div>body</div>
      </ChatPanel>,
    );
    // No element with the border-t separator from the input row.
    const rows = container.querySelectorAll("div.border-t");
    expect(rows.length).toBe(0);
  });
});
