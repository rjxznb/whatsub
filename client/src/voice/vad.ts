/**
 * Energy-based Voice Activity Detection state machine.
 *
 * Pure functions-in/events-out design: no Web Audio APIs, no timers.
 * The audio capture layer (`voiceCapture.ts`) feeds RMS values frame-by-frame
 * and acts on the returned events.
 *
 * State transitions:
 *
 *   IDLE ──(rms > startThreshold)──> SPEAKING
 *          emit { type: "speech-start" }
 *
 *   SPEAKING ──(silenceMs >= config.silenceMs)──> IDLE
 *          if totalSpeechMs >= minSpeechMs: emit { type: "speech-end", durationMs }
 *          else: discard (too short, likely noise)
 *
 * A brief dip below stopThreshold that is shorter than silenceMs does NOT end
 * the utterance — it just accumulates trailing silence. If a loud frame arrives
 * before the silence threshold is reached, silenceMs resets to 0, continuing
 * the same utterance.
 */

export interface VadConfig {
  /** RMS above this level signals speech starting. Default 0.015. */
  startThreshold: number;
  /** RMS below this level counts as silence. Default 0.010. */
  stopThreshold: number;
  /** Accumulated silence (ms) after speech needed to end an utterance. Default 800. */
  silenceMs: number;
  /** Utterances shorter than this (ms) are discarded as noise. Default 300. */
  minSpeechMs: number;
  /** Duration of each frame in milliseconds (determined by the caller). Default ~16ms for 256 samples @16kHz. */
  frameMs: number;
}

export type VadEvent =
  | { type: "speech-start" }
  | { type: "speech-end"; durationMs: number };

const DEFAULTS: VadConfig = {
  startThreshold: 0.015,
  stopThreshold: 0.010,
  silenceMs: 800,
  minSpeechMs: 300,
  frameMs: 16,
};

type VadState = "idle" | "speaking";

export class Vad {
  private config: VadConfig;
  private state: VadState = "idle";
  private speechMs = 0;
  private accSilenceMs = 0;

  constructor(config?: Partial<VadConfig>) {
    this.config = { ...DEFAULTS, ...config };
  }

  /** Feed one frame's RMS value. Returns 0 or more events. */
  push(rms: number): VadEvent[] {
    const { startThreshold, stopThreshold, silenceMs, minSpeechMs, frameMs } =
      this.config;
    const events: VadEvent[] = [];

    if (this.state === "idle") {
      if (rms > startThreshold) {
        this.state = "speaking";
        this.speechMs = frameMs;
        this.accSilenceMs = 0;
        events.push({ type: "speech-start" });
      }
      // Below threshold while idle — stay idle, no event.
    } else {
      // state === "speaking"
      this.speechMs += frameMs;

      if (rms < stopThreshold) {
        this.accSilenceMs += frameMs;
      } else {
        this.accSilenceMs = 0; // loud frame resets trailing silence
      }

      if (this.accSilenceMs >= silenceMs) {
        // Utterance ends. The "real" speech duration excludes the trailing
        // silence that triggered the end (the user was silent for silenceMs;
        // that window is the detection tail, not speech content).
        const speechDuration = this.speechMs - this.accSilenceMs;
        this.state = "idle";
        this.speechMs = 0;
        this.accSilenceMs = 0;

        if (speechDuration >= minSpeechMs) {
          events.push({ type: "speech-end", durationMs: speechDuration });
        }
        // else: discard — too short, treat as noise
      }
    }

    return events;
  }

  /**
   * Force-finish any in-progress utterance.
   *
   * Call this when stopping capture so a trailing utterance that hasn't hit
   * the silence threshold yet still gets emitted (if long enough).
   */
  flush(): VadEvent[] {
    if (this.state !== "speaking") return [];
    // On flush we treat the trailing silence as part of the detection tail,
    // same as the normal end path.
    const speechDuration = this.speechMs - this.accSilenceMs;
    this.state = "idle";
    this.speechMs = 0;
    this.accSilenceMs = 0;

    if (speechDuration >= this.config.minSpeechMs) {
      return [{ type: "speech-end", durationMs: speechDuration }];
    }
    return [];
  }

  reset(): void {
    this.state = "idle";
    this.speechMs = 0;
    this.accSilenceMs = 0;
  }

  get speaking(): boolean {
    return this.state === "speaking";
  }
}
