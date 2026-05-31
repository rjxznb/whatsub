import { describe, it, expect, beforeEach } from "vitest";
import { Vad } from "./vad";
import type { VadEvent, VadConfig } from "./vad";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Push N frames of the same RMS, return all emitted events. */
function pushN(vad: Vad, rms: number, frames: number): VadEvent[] {
  const events: VadEvent[] = [];
  for (let i = 0; i < frames; i++) {
    events.push(...vad.push(rms));
  }
  return events;
}

// Config that makes arithmetic easy: frameMs=100ms so frame counts = 10×ms
const cfg: Partial<VadConfig> = {
  frameMs: 100,       // 100 ms per frame
  startThreshold: 0.02,
  stopThreshold: 0.01,
  silenceMs: 800,     // 8 frames of silence to end utterance
  minSpeechMs: 300,   // 3 frames minimum speech
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Vad — basic lifecycle", () => {
  let vad: Vad;
  beforeEach(() => {
    vad = new Vad(cfg);
  });

  it("starts in idle, not speaking", () => {
    expect(vad.speaking).toBe(false);
  });

  it("(a) loud burst then silence → speech-start then speech-end with plausible duration", () => {
    // 5 loud frames (500ms of speech)
    const events1 = pushN(vad, 0.05, 5);
    expect(events1).toContainEqual({ type: "speech-start" });
    expect(vad.speaking).toBe(true);

    // 8 silent frames → triggers utterance end (500ms speech ≥ 300ms minSpeech)
    const events2 = pushN(vad, 0.005, 8);
    const endEvt = events2.find((e) => e.type === "speech-end") as
      | Extract<VadEvent, { type: "speech-end" }>
      | undefined;
    expect(endEvt).toBeDefined();
    expect(endEvt!.durationMs).toBeGreaterThanOrEqual(300); // ≥ minSpeechMs
    expect(vad.speaking).toBe(false);
  });

  it("(b) too-short blip → speech-start but NO speech-end (discarded as noise)", () => {
    // 2 loud frames (200ms) — below minSpeechMs=300ms
    const events1 = pushN(vad, 0.05, 2);
    expect(events1).toContainEqual({ type: "speech-start" });

    // 8 silent frames → utterance too short → discarded
    const events2 = pushN(vad, 0.005, 8);
    expect(events2.find((e) => e.type === "speech-end")).toBeUndefined();
    expect(vad.speaking).toBe(false);
  });

  it("(c) loud → brief-dip → loud → silence → ONE utterance (brief dip doesn't split)", () => {
    // 5 loud frames (500ms)
    pushN(vad, 0.05, 5);
    expect(vad.speaking).toBe(true);

    // 4 silent frames (400ms) — below silenceMs=800ms threshold, so no end yet
    const midEvents = pushN(vad, 0.005, 4);
    expect(midEvents.find((e) => e.type === "speech-end")).toBeUndefined();
    expect(vad.speaking).toBe(true); // still speaking

    // Loud again — resets silence accumulator
    pushN(vad, 0.05, 3);

    // Now 8 full silence frames → utterance ends
    const endEvents = pushN(vad, 0.005, 8);
    const endEvt = endEvents.find((e) => e.type === "speech-end");
    expect(endEvt).toBeDefined();
    expect(vad.speaking).toBe(false);
  });

  it("(d) flush() mid-speech → emits speech-end if long enough", () => {
    // 5 loud frames (500ms ≥ 300ms minSpeech) — no silence yet
    pushN(vad, 0.05, 5);
    expect(vad.speaking).toBe(true);

    const flushed = vad.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ type: "speech-end" });
    expect(vad.speaking).toBe(false);
  });

  it("flush() on idle returns empty array", () => {
    expect(vad.flush()).toEqual([]);
  });

  it("flush() with too-short utterance returns empty (discarded)", () => {
    pushN(vad, 0.05, 1); // 100ms < minSpeechMs=300ms
    expect(vad.flush()).toEqual([]);
  });

  it("reset() clears state mid-speech", () => {
    pushN(vad, 0.05, 5);
    expect(vad.speaking).toBe(true);
    vad.reset();
    expect(vad.speaking).toBe(false);
    // After reset, a full cycle works again
    pushN(vad, 0.05, 5);
    expect(vad.speaking).toBe(true);
  });

  it("emits exactly one speech-start per utterance even over many loud frames", () => {
    const events = pushN(vad, 0.05, 20);
    const starts = events.filter((e) => e.type === "speech-start");
    expect(starts).toHaveLength(1);
  });

  it("two separate utterances after a full silence gap", () => {
    // Utterance 1
    pushN(vad, 0.05, 5); // 500ms speech
    const endEvents1 = pushN(vad, 0.005, 8); // 800ms silence → end
    expect(endEvents1.find((e) => e.type === "speech-end")).toBeDefined();
    expect(vad.speaking).toBe(false);

    // Utterance 2
    const startEvents2 = vad.push(0.05);
    expect(startEvents2).toContainEqual({ type: "speech-start" });
    pushN(vad, 0.05, 4);
    const endEvents2 = pushN(vad, 0.005, 8);
    expect(endEvents2.find((e) => e.type === "speech-end")).toBeDefined();
  });
});

describe("Vad — default config", () => {
  it("uses sensible defaults when no config provided", () => {
    const vad = new Vad();
    // Speaking after exceeding default startThreshold (0.015)
    vad.push(0.02);
    expect(vad.speaking).toBe(true);
  });
});

describe("Vad — edge cases", () => {
  it("rms exactly at startThreshold is NOT above it (no speech-start)", () => {
    const vad = new Vad({ ...cfg, startThreshold: 0.02 });
    const events = vad.push(0.02); // not strictly greater than
    expect(events.find((e) => e.type === "speech-start")).toBeUndefined();
  });

  it("rms exactly at stopThreshold IS counted as silence (< check)", () => {
    // stopThreshold=0.01 — value 0.01 is NOT < 0.01, so not silence
    const vad = new Vad({ ...cfg, stopThreshold: 0.01 });
    vad.push(0.05); // start speaking
    // Push exactly at stopThreshold — should NOT count as silence
    vad.push(0.01);
    expect(vad.speaking).toBe(true); // still speaking, no accumulation
  });
});
