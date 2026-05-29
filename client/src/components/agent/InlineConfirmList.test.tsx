import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InlineConfirmList } from "./InlineConfirmList";
import { useAgentConfirms } from "../../store/agentConfirms";
import type { PendingConfirm } from "../../store/agentConfirms";
import type { ToolDef } from "../../agent/types";

function mkTool(id: string): ToolDef {
  return {
    id,
    description: "",
    parameters: {} as never,
    riskTier: "MID",
    availableOn: () => true,
    runningLabel: "running",
    doneLabel: () => "done",
    execute: async () => null,
  };
}

function mkPending(opts: Partial<PendingConfirm> & { id: string }): PendingConfirm {
  return {
    id: opts.id,
    toolDef: opts.toolDef ?? mkTool("test_tool"),
    args: opts.args ?? {},
    tier: opts.tier ?? "MID",
    resolve: opts.resolve ?? vi.fn(),
  };
}

beforeEach(() => {
  useAgentConfirms.setState({ pending: [] });
});

describe("InlineConfirmList", () => {
  it("renders nothing when there are no pending confirms", () => {
    const { container } = render(<InlineConfirmList />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one InlineConfirmCard per MID-risk pending confirm", () => {
    useAgentConfirms.getState().push(
      mkPending({ id: "p1", toolDef: mkTool("seek_to") }),
    );
    useAgentConfirms.getState().push(
      mkPending({ id: "p2", toolDef: mkTool("remove_video") }),
    );
    render(<InlineConfirmList />);
    expect(screen.getByText("seek_to")).toBeTruthy();
    expect(screen.getByText("remove_video")).toBeTruthy();
    // Two 请确认 banners, one per card.
    expect(screen.getAllByText(/请确认/)).toHaveLength(2);
  });

  it("filters out HIGH-tier pending confirms (those go to the system dialog)", () => {
    useAgentConfirms.getState().push(
      mkPending({ id: "p_mid", toolDef: mkTool("mid_tool"), tier: "MID" }),
    );
    useAgentConfirms.getState().push(
      mkPending({ id: "p_high", toolDef: mkTool("high_tool"), tier: "HIGH" }),
    );
    render(<InlineConfirmList />);
    expect(screen.getByText("mid_tool")).toBeTruthy();
    expect(screen.queryByText("high_tool")).toBeNull();
  });

  it("renders nothing when all pending confirms are HIGH-tier", () => {
    useAgentConfirms.getState().push(
      mkPending({ id: "p_high", toolDef: mkTool("high_tool"), tier: "HIGH" }),
    );
    const { container } = render(<InlineConfirmList />);
    expect(container.firstChild).toBeNull();
  });
});
