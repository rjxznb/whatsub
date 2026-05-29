import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useAgentConfirms,
  confirmViaUI,
  summarizeArgsForDisplay,
} from "./agentConfirms";
import type { PendingConfirm } from "./agentConfirms";
import type { ToolDef } from "../agent/types";

// Module-level mock for HIGH-risk path. Tests can override the return value
// via `mockResolvedValueOnce` per case.
const confirmMock = vi.fn().mockResolvedValue(true);
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
}));

const fakeTool: ToolDef = {
  id: "test_tool",
  description: "",
  parameters: {} as never,
  riskTier: "MID",
  availableOn: () => true,
  runningLabel: "running",
  doneLabel: () => "done",
  execute: async () => null,
};

function pending(opts: Partial<PendingConfirm> = {}): PendingConfirm {
  return {
    id: opts.id ?? "p1",
    toolDef: opts.toolDef ?? fakeTool,
    args: opts.args ?? { foo: 1 },
    tier: opts.tier ?? "MID",
    resolve: opts.resolve ?? vi.fn(),
  };
}

beforeEach(() => {
  useAgentConfirms.setState({ pending: [] });
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

describe("useAgentConfirms store", () => {
  it("push adds to pending array", () => {
    const p = pending();
    useAgentConfirms.getState().push(p);
    expect(useAgentConfirms.getState().pending).toHaveLength(1);
    expect(useAgentConfirms.getState().pending[0]).toBe(p);
  });

  it("resolveOne resolves the pending Promise and removes it from the array", () => {
    const resolve = vi.fn();
    const p = pending({ id: "p1", resolve });
    useAgentConfirms.getState().push(p);

    useAgentConfirms.getState().resolveOne("p1", "yes");

    expect(resolve).toHaveBeenCalledWith("yes");
    expect(useAgentConfirms.getState().pending).toHaveLength(0);
  });

  it("resolveOne with unknown id is a no-op", () => {
    const resolve = vi.fn();
    const p = pending({ id: "p1", resolve });
    useAgentConfirms.getState().push(p);

    useAgentConfirms.getState().resolveOne("nonexistent", "yes");

    expect(resolve).not.toHaveBeenCalled();
    expect(useAgentConfirms.getState().pending).toHaveLength(1);
  });

  it("rejectAllPanelClosed resolves every pending with 'no_panel_closed' and clears the array", () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    useAgentConfirms.getState().push(pending({ id: "p1", resolve: r1 }));
    useAgentConfirms.getState().push(pending({ id: "p2", resolve: r2 }));

    useAgentConfirms.getState().rejectAllPanelClosed();

    expect(r1).toHaveBeenCalledWith("no_panel_closed");
    expect(r2).toHaveBeenCalledWith("no_panel_closed");
    expect(useAgentConfirms.getState().pending).toEqual([]);
  });
});

describe("confirmViaUI", () => {
  it("MID: pushes a pending and resolves the Promise when the store entry is resolved", async () => {
    const promise = confirmViaUI(fakeTool, { foo: 1 }, "MID");

    // One pending entry created synchronously.
    const pendings = useAgentConfirms.getState().pending;
    expect(pendings).toHaveLength(1);
    expect(pendings[0].tier).toBe("MID");
    expect(pendings[0].toolDef.id).toBe("test_tool");

    // Resolve via the store and await the original Promise.
    useAgentConfirms.getState().resolveOne(pendings[0].id, "yes");
    await expect(promise).resolves.toBe("yes");
    expect(useAgentConfirms.getState().pending).toHaveLength(0);
  });

  it("MID: panel close routes through rejectAllPanelClosed → 'no_panel_closed'", async () => {
    const promise = confirmViaUI(fakeTool, {}, "MID");
    useAgentConfirms.getState().rejectAllPanelClosed();
    await expect(promise).resolves.toBe("no_panel_closed");
  });

  it("HIGH: calls plugin-dialog confirm; returns 'yes' when user clicks OK", async () => {
    confirmMock.mockResolvedValueOnce(true);
    const result = await confirmViaUI(fakeTool, { foo: 1 }, "HIGH");
    expect(result).toBe("yes");
    expect(confirmMock).toHaveBeenCalledTimes(1);
    // Does NOT push to the store (HIGH path is modal-only).
    expect(useAgentConfirms.getState().pending).toHaveLength(0);
  });

  it("HIGH: returns 'no_user_clicked' when user cancels the system dialog", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const result = await confirmViaUI(fakeTool, {}, "HIGH");
    expect(result).toBe("no_user_clicked");
  });

  it("HIGH: returns 'no_user_clicked' when the dialog itself throws", async () => {
    confirmMock.mockRejectedValueOnce(new Error("dialog plugin failed"));
    const result = await confirmViaUI(fakeTool, {}, "HIGH");
    expect(result).toBe("no_user_clicked");
  });
});

describe("summarizeArgsForDisplay", () => {
  it("returns pretty JSON for normal args", () => {
    expect(summarizeArgsForDisplay("any", { a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("falls back to String() on circular references (JSON.stringify throws)", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const out = summarizeArgsForDisplay("any", cyc);
    expect(typeof out).toBe("string");
    // String([object Object]) — what matters is that we don't throw.
    expect(out.length).toBeGreaterThan(0);
  });
});
