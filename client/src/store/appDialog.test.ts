import { describe, it, expect, beforeEach } from "vitest";
import { useAppDialog, notify, confirmDialog } from "./appDialog";

beforeEach(() => useAppDialog.setState({ queue: [] }));

describe("appDialog", () => {
  it("notify enqueues an info dialog and resolves on OK", async () => {
    const p = notify("hi", { title: "t" });
    const q = useAppDialog.getState().queue;
    expect(q).toHaveLength(1);
    expect(q[0].kind).toBe("info");
    expect(q[0].title).toBe("t");
    useAppDialog.getState().resolveTop(true);
    await expect(p).resolves.toBeUndefined();
    expect(useAppDialog.getState().queue).toHaveLength(0);
  });

  it("confirmDialog resolves true on OK, false on cancel", async () => {
    const p = confirmDialog("sure?");
    expect(useAppDialog.getState().queue[0].kind).toBe("confirm");
    useAppDialog.getState().resolveTop(true);
    await expect(p).resolves.toBe(true);

    const p2 = confirmDialog("sure?", { danger: true });
    useAppDialog.getState().resolveTop(false);
    await expect(p2).resolves.toBe(false);
  });

  it("queues multiple and resolves them FIFO", async () => {
    const a = confirmDialog("a");
    const b = confirmDialog("b");
    expect(useAppDialog.getState().queue).toHaveLength(2);
    useAppDialog.getState().resolveTop(true);
    await expect(a).resolves.toBe(true);
    expect(useAppDialog.getState().queue).toHaveLength(1);
    useAppDialog.getState().resolveTop(false);
    await expect(b).resolves.toBe(false);
  });
});
