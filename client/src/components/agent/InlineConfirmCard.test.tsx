import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InlineConfirmCard } from "./InlineConfirmCard";
import { useAgentConfirms } from "../../store/agentConfirms";
import type { PendingConfirm } from "../../store/agentConfirms";
import type { ToolDef } from "../../agent/types";

const fakeTool: ToolDef = {
  id: "remove_video",
  description: "",
  parameters: {} as never,
  riskTier: "MID",
  availableOn: () => true,
  runningLabel: "running",
  doneLabel: () => "done",
  execute: async () => null,
};

function pendingFixture(overrides: Partial<PendingConfirm> = {}): PendingConfirm {
  return {
    id: overrides.id ?? "p1",
    toolDef: overrides.toolDef ?? fakeTool,
    args: overrides.args ?? { videoId: "abc123" },
    tier: overrides.tier ?? "MID",
    resolve: overrides.resolve ?? vi.fn(),
  };
}

beforeEach(() => {
  useAgentConfirms.setState({ pending: [] });
});

describe("InlineConfirmCard", () => {
  it("renders the tool id and pretty-printed args", () => {
    const p = pendingFixture({ args: { videoId: "abc123" } });
    useAgentConfirms.getState().push(p);

    render(<InlineConfirmCard pending={p} />);

    expect(screen.getByText("remove_video")).toBeTruthy();
    // Pretty JSON includes the key.
    expect(screen.getByText(/"videoId": "abc123"/)).toBeTruthy();
    // Section banner.
    expect(screen.getByText(/请确认/)).toBeTruthy();
  });

  it("clicking 确认 calls resolveOne(id, 'yes') and removes from the store", () => {
    const resolve = vi.fn();
    const p = pendingFixture({ id: "p_yes", resolve });
    useAgentConfirms.getState().push(p);

    render(<InlineConfirmCard pending={p} />);

    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    expect(resolve).toHaveBeenCalledWith("yes");
    expect(useAgentConfirms.getState().pending).toHaveLength(0);
  });

  it("clicking 取消 calls resolveOne(id, 'no_user_clicked') and removes from the store", () => {
    const resolve = vi.fn();
    const p = pendingFixture({ id: "p_no", resolve });
    useAgentConfirms.getState().push(p);

    render(<InlineConfirmCard pending={p} />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(resolve).toHaveBeenCalledWith("no_user_clicked");
    expect(useAgentConfirms.getState().pending).toHaveLength(0);
  });
});
