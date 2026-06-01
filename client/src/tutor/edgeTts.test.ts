import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { edgeSynthesize, EDGE_VOICE_ZH } from "./edgeTts";

// invoke is globally mocked in src/test-setup.ts. The real WebSocket synthesis
// now lives in Rust (commands/edge_tts.rs, unit-tested there); here we only
// assert this wrapper talks to that command correctly.
const mockInvoke = vi.mocked(invoke);

function toB64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("edgeSynthesize", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("invokes edge_tts_synthesize with the voice and +N% rate, decoding base64", async () => {
    mockInvoke.mockResolvedValueOnce(toB64([1, 2, 3, 255]));
    const buf = await edgeSynthesize("你好 hello", {
      voice: EDGE_VOICE_ZH,
      rate: 1.12,
    });
    expect(mockInvoke).toHaveBeenCalledWith("edge_tts_synthesize", {
      text: "你好 hello",
      voice: EDGE_VOICE_ZH,
      ratePct: 12,
    });
    expect(Array.from(new Uint8Array(buf))).toEqual([1, 2, 3, 255]);
  });

  it("formats a slower rate as a negative percent", async () => {
    mockInvoke.mockResolvedValueOnce(toB64([0]));
    await edgeSynthesize("x", { voice: "v", rate: 0.9 });
    expect(mockInvoke).toHaveBeenCalledWith("edge_tts_synthesize", {
      text: "x",
      voice: "v",
      ratePct: -10,
    });
  });

  it("rejects on an empty response so callers fall back", async () => {
    mockInvoke.mockResolvedValueOnce("");
    await expect(edgeSynthesize("x", { voice: "v" })).rejects.toThrow();
  });

  it("rejects immediately if already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      edgeSynthesize("x", { voice: "v", signal: ac.signal }),
    ).rejects.toThrow("aborted");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
