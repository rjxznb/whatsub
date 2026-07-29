import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelImportAndInvalidateAnalysis,
  deleteVideoAndInvalidateAnalysis,
} from "./analysisPersistence";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown) => invokeMock(command, args),
}));

beforeEach(() => invokeMock.mockReset());

describe("backend-confirmed destructive boundaries", () => {
  it("waits for library deletion instead of resolving optimistically", async () => {
    let finish!: () => void;
    invokeMock.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    let settled = false;

    const deleting = deleteVideoAndInvalidateAnalysis("video-1").then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("library_delete", { id: "video-1" });

    finish();
    await deleting;
    expect(settled).toBe(true);
  });

  it("waits for cancellation cleanup instead of resolving optimistically", async () => {
    let finish!: () => void;
    invokeMock.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    let settled = false;

    const cancelling = cancelImportAndInvalidateAnalysis("video-2").then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("cancel_import", { videoId: "video-2" });

    finish();
    await cancelling;
    expect(settled).toBe(true);
  });
});
