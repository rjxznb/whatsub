import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolsPopover } from "./ToolsPopover";
import { TOOLS } from "../../agent/registry";

function anchor(): HTMLElement {
  const el = document.createElement("button");
  document.body.appendChild(el);
  return el;
}

describe("ToolsPopover", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ToolsPopover open={false} anchorEl={anchor()} onClose={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the total tool count from the registry", () => {
    render(<ToolsPopover open anchorEl={anchor()} onClose={() => {}} />);
    expect(screen.getByText(new RegExp(`共 ${TOOLS.length} 个`))).toBeTruthy();
  });

  it("lists every registered tool (none hidden)", () => {
    render(<ToolsPopover open anchorEl={anchor()} onClose={() => {}} />);
    // A few representative labels across groups.
    expect(screen.getByText("推荐复习")).toBeTruthy();
    expect(screen.getByText("开始精讲")).toBeTruthy();
    expect(screen.getByText("删视频")).toBeTruthy();
    // Risk badges surface for non-LOW tools.
    expect(screen.getAllByText("高风险").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需确认").length).toBeGreaterThan(0);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ToolsPopover open anchorEl={anchor()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
