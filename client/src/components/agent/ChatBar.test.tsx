import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatBar, type ChatBarMode } from "./ChatBar";

function defaults(overrides: Partial<Parameters<typeof ChatBar>[0]> = {}) {
  return {
    mode: "bar" as ChatBarMode,
    onModeChange: vi.fn(),
    streaming: false,
    hasUnread: false,
    pageDefaultMode: "bar" as "icon" | "bar",
    header: <div>HEADER</div>,
    body: <div>BODY</div>,
    inlineConfirms: <div>CONFIRMS</div>,
    inputBox: (
      <div data-testid="input-box">
        <textarea data-testid="input-textarea" />
      </div>
    ),
    ...overrides,
  };
}

beforeEach(() => {
  // Clean slate for position persistence between tests so loadPos returns the
  // computed default (not whatever a prior test wrote).
  try {
    localStorage.removeItem("agentIconPos");
    localStorage.removeItem("agentBarPos");
  } catch {
    /* ignore */
  }
});

describe("ChatBar — mode rendering", () => {
  it("icon mode: renders Bot pill with NO textarea/header/body", () => {
    render(<ChatBar {...defaults({ mode: "icon" })} />);
    // Bar's input textarea is not in the DOM at all in icon state.
    expect(screen.queryByTestId("input-box")).toBeNull();
    expect(screen.queryByText("HEADER")).toBeNull();
    expect(screen.queryByText("BODY")).toBeNull();
    // Pill text + aria-label.
    expect(screen.getByText("AI")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "打开 AI 助手" }),
    ).toBeTruthy();
  });

  it("icon mode: hasUnread renders the unread dot", () => {
    const { rerender } = render(
      <ChatBar {...defaults({ mode: "icon", hasUnread: false })} />,
    );
    expect(screen.queryByTestId("agent-unread-dot")).toBeNull();
    rerender(<ChatBar {...defaults({ mode: "icon", hasUnread: true })} />);
    expect(screen.getByTestId("agent-unread-dot")).toBeTruthy();
  });

  it("bar mode: renders input only, not header/body", () => {
    render(<ChatBar {...defaults({ mode: "bar" })} />);
    expect(screen.getByTestId("input-box")).toBeTruthy();
    expect(screen.queryByText("HEADER")).toBeNull();
    expect(screen.queryByText("BODY")).toBeNull();
  });

  it("panel mode: renders header + body + input + confirms", () => {
    render(<ChatBar {...defaults({ mode: "panel" })} />);
    expect(screen.getByText("HEADER")).toBeTruthy();
    expect(screen.getByText("BODY")).toBeTruthy();
    expect(screen.getByText("CONFIRMS")).toBeTruthy();
    expect(screen.getByTestId("input-box")).toBeTruthy();
  });

  it("aria-expanded reflects mode (true only for panel)", () => {
    const { rerender, container } = render(
      <ChatBar {...defaults({ mode: "icon" })} />,
    );
    expect(
      (container.firstChild as Element).getAttribute("aria-expanded"),
    ).toBe("false");
    rerender(<ChatBar {...defaults({ mode: "bar" })} />);
    expect(
      (container.firstChild as Element).getAttribute("aria-expanded"),
    ).toBe("false");
    rerender(<ChatBar {...defaults({ mode: "panel" })} />);
    expect(
      (container.firstChild as Element).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("ChatBar — click-to-advance (drag below threshold)", () => {
  it("icon → bar on click (no drag)", () => {
    const onModeChange = vi.fn();
    const { container } = render(
      <ChatBar {...defaults({ mode: "icon", onModeChange })} />,
    );
    const root = container.firstChild as Element;
    // Mousedown then immediately mouseup with no movement → treat as click.
    fireEvent.mouseDown(root, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 100, clientY: 100 });
    expect(onModeChange).toHaveBeenCalledWith("bar");
  });

  it("bar → panel on click (no drag)", () => {
    const onModeChange = vi.fn();
    const { container } = render(
      <ChatBar {...defaults({ mode: "bar", onModeChange })} />,
    );
    const root = container.firstChild as Element;
    fireEvent.mouseDown(root, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 100, clientY: 100 });
    expect(onModeChange).toHaveBeenCalledWith("panel");
  });

  it("tiny move (< 5px) is still a click", () => {
    const onModeChange = vi.fn();
    const { container } = render(
      <ChatBar {...defaults({ mode: "icon", onModeChange })} />,
    );
    const root = container.firstChild as Element;
    fireEvent.mouseDown(root, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 103, clientY: 102 });
    fireEvent.mouseUp(document, { clientX: 103, clientY: 102 });
    expect(onModeChange).toHaveBeenCalledWith("bar");
  });

  it("panel: click on container does NOT call onModeChange", () => {
    const onModeChange = vi.fn();
    const { container } = render(
      <ChatBar {...defaults({ mode: "panel", onModeChange })} />,
    );
    const root = container.firstChild as Element;
    fireEvent.mouseDown(root, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 100, clientY: 100 });
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

describe("ChatBar — drag exclusion (interactive elements)", () => {
  it("mousedown on textarea does NOT initiate drag → onModeChange not called via drag click path", () => {
    const onModeChange = vi.fn();
    render(<ChatBar {...defaults({ mode: "bar", onModeChange })} />);
    const textarea = screen.getByTestId("input-textarea");
    fireEvent.mouseDown(textarea, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 100, clientY: 100 });
    // Textarea mousedown is exempt — no drag started, no fake "click" mode advance.
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

describe("ChatBar — click outside collapse (panel)", () => {
  it("click outside while panel + not streaming → onModeChange(pageDefaultMode)", () => {
    const onModeChange = vi.fn();
    render(
      <>
        <button data-testid="outside-target">outside</button>
        <ChatBar
          {...defaults({
            mode: "panel",
            onModeChange,
            pageDefaultMode: "icon",
          })}
        />
      </>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside-target"));
    expect(onModeChange).toHaveBeenCalledWith("icon");
  });

  it("click outside while streaming is SUPPRESSED", () => {
    const onModeChange = vi.fn();
    render(
      <>
        <button data-testid="outside-target">outside</button>
        <ChatBar
          {...defaults({
            mode: "panel",
            streaming: true,
            onModeChange,
          })}
        />
      </>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside-target"));
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("click outside while bar (not panel) does NOT collapse", () => {
    const onModeChange = vi.fn();
    render(
      <>
        <button data-testid="outside-target">outside</button>
        <ChatBar {...defaults({ mode: "bar", onModeChange })} />
      </>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside-target"));
    // bar's outside listener never installs.
    expect(onModeChange).not.toHaveBeenCalled();
  });
});

describe("ChatBar — drag persists position", () => {
  it("dragging in icon mode persists agentIconPos on mouseup", () => {
    const onModeChange = vi.fn();
    const { container } = render(
      <ChatBar {...defaults({ mode: "icon", onModeChange })} />,
    );
    const root = container.firstChild as Element;
    fireEvent.mouseDown(root, { clientX: 200, clientY: 200 });
    // Big move — past the 5px threshold so it counts as a drag.
    fireEvent.mouseMove(document, { clientX: 260, clientY: 250 });
    fireEvent.mouseUp(document, { clientX: 260, clientY: 250 });
    // Drag, not click → no mode advance.
    expect(onModeChange).not.toHaveBeenCalled();
    // Persisted position is some valid {x, y}; exact value depends on
    // viewport clamping, so just assert it's been written.
    const raw = localStorage.getItem("agentIconPos");
    expect(raw).toBeTruthy();
    const p = JSON.parse(raw!);
    expect(typeof p.x).toBe("number");
    expect(typeof p.y).toBe("number");
  });

  it("dragging in bar mode persists agentBarPos on mouseup", () => {
    const onModeChange = vi.fn();
    const { container } = render(
      <ChatBar {...defaults({ mode: "bar", onModeChange })} />,
    );
    const root = container.firstChild as Element;
    fireEvent.mouseDown(root, { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(document, { clientX: 280, clientY: 220 });
    fireEvent.mouseUp(document, { clientX: 280, clientY: 220 });
    expect(onModeChange).not.toHaveBeenCalled();
    const raw = localStorage.getItem("agentBarPos");
    expect(raw).toBeTruthy();
  });
});
