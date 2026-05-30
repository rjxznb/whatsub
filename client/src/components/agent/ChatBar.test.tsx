import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatBar } from "./ChatBar";

function defaults(overrides: Partial<Parameters<typeof ChatBar>[0]> = {}) {
  return {
    expanded: false,
    onExpand: vi.fn(),
    onCollapse: vi.fn(),
    streaming: false,
    header: <div>HEADER</div>,
    body: <div>BODY</div>,
    inlineConfirms: <div>CONFIRMS</div>,
    inputBox: <div data-testid="input-box">INPUT</div>,
    ...overrides,
  };
}

describe("ChatBar", () => {
  it("collapsed: renders input only, not header/body", () => {
    render(<ChatBar {...defaults()} />);
    expect(screen.getByTestId("input-box")).toBeTruthy();
    expect(screen.queryByText("HEADER")).toBeNull();
    expect(screen.queryByText("BODY")).toBeNull();
  });

  it("expanded: renders header + body + input + confirms", () => {
    render(<ChatBar {...defaults({ expanded: true })} />);
    expect(screen.getByText("HEADER")).toBeTruthy();
    expect(screen.getByText("BODY")).toBeTruthy();
    expect(screen.getByText("CONFIRMS")).toBeTruthy();
    expect(screen.getByTestId("input-box")).toBeTruthy();
  });

  it("clicking container when collapsed calls onExpand", () => {
    const onExpand = vi.fn();
    const { container } = render(<ChatBar {...defaults({ onExpand })} />);
    fireEvent.click(container.firstChild as Element);
    expect(onExpand).toHaveBeenCalled();
  });

  it("clicking container when expanded does NOT call onCollapse", () => {
    const onCollapse = vi.fn();
    const { container } = render(
      <ChatBar {...defaults({ expanded: true, onCollapse })} />,
    );
    fireEvent.click(container.firstChild as Element);
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("click outside while expanded + not streaming calls onCollapse", () => {
    const onCollapse = vi.fn();
    render(
      <>
        <button data-testid="outside-target">outside</button>
        <ChatBar {...defaults({ expanded: true, onCollapse })} />
      </>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside-target"));
    expect(onCollapse).toHaveBeenCalled();
  });

  it("click outside while streaming is SUPPRESSED", () => {
    const onCollapse = vi.fn();
    render(
      <>
        <button data-testid="outside-target">outside</button>
        <ChatBar {...defaults({ expanded: true, streaming: true, onCollapse })} />
      </>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside-target"));
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it("aria-expanded reflects state", () => {
    const { rerender, container } = render(
      <ChatBar {...defaults({ expanded: false })} />,
    );
    expect((container.firstChild as Element).getAttribute("aria-expanded")).toBe(
      "false",
    );
    rerender(<ChatBar {...defaults({ expanded: true })} />);
    expect((container.firstChild as Element).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
});
