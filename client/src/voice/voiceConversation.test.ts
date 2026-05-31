/**
 * Tests for VoiceConversation state machine.
 *
 * All real browser APIs (AudioContext, getUserMedia), whisper, LLM, and TTS
 * are replaced by fakes injected through `deps`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoiceConversation } from "./voiceConversation";
import type { VoiceConversationHandlers, VoiceConversationDeps } from "./voiceConversation";
import type { VoiceState } from "./types";
import type { Settings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Drain all pending microtasks. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake AsyncIterable that yields the given string chunks. */
async function* fakeStream(chunks: string[]): AsyncIterable<string> {
  for (const c of chunks) {
    yield c;
  }
}

type CaptureHandlers = Parameters<VoiceConversationDeps["startCapture"]>[0];

/**
 * Creates a fake `startCapture` that returns handles to fire `onUtterance`,
 * `onSpeechStart`, and `onLevel` from tests, plus a spy on `stop()`.
 */
function makeFakeCapture() {
  let capturedHandlers: CaptureHandlers | null = null;
  const stopSpy = vi.fn();

  const startCapture = vi.fn<VoiceConversationDeps["startCapture"]>(
    async (handlers) => {
      capturedHandlers = handlers;
      return { stop: stopSpy };
    },
  );

  const fire = {
    utterance: (wav: string) => capturedHandlers?.onUtterance(wav),
    speechStart: () => capturedHandlers?.onSpeechStart?.(),
    level: (rms: number) => capturedHandlers?.onLevel?.(rms),
    error: (msg: string) => capturedHandlers?.onError?.(msg),
  };

  return { startCapture, stopSpy, fire };
}

function makeHandlers(): VoiceConversationHandlers & {
  states: VoiceState[];
  userTexts: string[];
  assistantFinals: string[];
  errors: string[];
} {
  const states: VoiceState[] = [];
  const userTexts: string[] = [];
  const assistantFinals: string[] = [];
  const errors: string[] = [];

  return {
    states,
    userTexts,
    assistantFinals,
    errors,
    onState: (s) => states.push(s),
    onLevel: vi.fn(),
    onUserText: (t) => userTexts.push(t),
    onAssistantText: (t, done) => { if (done) assistantFinals.push(t); },
    onError: (msg) => errors.push(msg),
  };
}

const SETTINGS: Settings = DEFAULT_SETTINGS;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VoiceConversation", () => {
  describe("(a) happy path — full turn", () => {
    it("transcribe → onUserText → streamLlm → onAssistantText(done) → speak(en-US) → state ends speaking then listening", async () => {
      const { startCapture, fire } = makeFakeCapture();
      const handlers = makeHandlers();

      const transcribe = vi.fn<VoiceConversationDeps["transcribe"]>().mockResolvedValue("Hello world");
      const speak = vi.fn<VoiceConversationDeps["speak"]>().mockImplementation(async (_text, opts) => {
        opts.onEnd?.();
      });
      const cancelSpeak = vi.fn();
      const streamLlm = vi.fn<VoiceConversationDeps["streamLlm"]>().mockImplementation(
        () => fakeStream(["Nice ", "to meet you!"]),
      );

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        streamLlm,
        speak,
        cancelSpeak,
      });

      await conv.start();
      expect(handlers.states).toContain("listening");

      // Fire a fake utterance and then wait for the full async turn to finish.
      // We fire it and then flush microtasks repeatedly until the state sequence
      // reaches the expected end state.
      fire.utterance("wav-data");

      // Allow the async turn to run to completion.
      // Use vi.waitFor to poll until the full state sequence appears.
      await vi.waitFor(
        () => {
          const last = handlers.states[handlers.states.length - 1];
          // We expect at minimum: listening(1) + transcribing(2) + thinking(3) + speaking(4) + listening(5)
          if (handlers.states.length < 5) throw new Error("states not ready");
          if (last !== "listening") throw new Error("not yet back to listening");
        },
        { timeout: 5000, interval: 10 },
      );

      expect(transcribe).toHaveBeenCalledWith("wav-data");
      expect(handlers.userTexts).toEqual(["Hello world"]);
      expect(streamLlm).toHaveBeenCalledOnce();
      expect(handlers.assistantFinals).toEqual(["Nice to meet you!"]);
      expect(speak).toHaveBeenCalledWith(
        "Nice to meet you!",
        expect.objectContaining({ lang: "en-US" }),
      );
      // State sequence: listening → transcribing → thinking → speaking → listening
      expect(handlers.states).toEqual(
        expect.arrayContaining(["listening", "transcribing", "thinking", "speaking"]),
      );
      const lastState = handlers.states[handlers.states.length - 1];
      expect(lastState).toBe("listening");

      conv.stop();
    });
  });

  describe("(b) empty transcript", () => {
    it("returns to listening without calling LLM", async () => {
      const { startCapture, fire } = makeFakeCapture();
      const handlers = makeHandlers();

      const transcribe = vi.fn<VoiceConversationDeps["transcribe"]>().mockResolvedValue("   ");
      const streamLlm = vi.fn<VoiceConversationDeps["streamLlm"]>();
      const speak = vi.fn<VoiceConversationDeps["speak"]>();
      const cancelSpeak = vi.fn();

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        streamLlm,
        speak,
        cancelSpeak,
      });

      await conv.start();
      fire.utterance("silent-wav");

      // Wait for state to return to listening: listening(1) → transcribing(2) → listening(3)
      await vi.waitFor(
        () => {
          if (handlers.states.length < 3) throw new Error("states not ready");
          const last = handlers.states[handlers.states.length - 1];
          if (last !== "listening") throw new Error("not yet back to listening");
        },
        { timeout: 3000, interval: 10 },
      );

      expect(streamLlm).not.toHaveBeenCalled();
      expect(speak).not.toHaveBeenCalled();

      conv.stop();
    });
  });

  describe("(c) barge-in while speaking", () => {
    it("calls cancelSpeak and sets state to listening", async () => {
      const { startCapture, fire } = makeFakeCapture();
      const handlers = makeHandlers();

      // A speak that never calls onEnd — simulates TTS that keeps going.
      const speak = vi.fn<VoiceConversationDeps["speak"]>().mockReturnValue(
        new Promise(() => { /* never resolves */ }),
      );
      const cancelSpeak = vi.fn();
      const transcribe = vi.fn<VoiceConversationDeps["transcribe"]>().mockResolvedValue("barge in test");
      const streamLlm = vi.fn<VoiceConversationDeps["streamLlm"]>().mockImplementation(
        () => fakeStream(["Sure!"]),
      );

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        streamLlm,
        speak,
        cancelSpeak,
      });

      await conv.start();

      // Trigger a full turn so we reach "speaking".
      fire.utterance("wav1");

      // Wait until state reaches "speaking" before barge-in.
      await vi.waitFor(
        () => {
          if (!handlers.states.includes("speaking")) throw new Error("not speaking yet");
        },
        { timeout: 3000, interval: 10 },
      );

      // Allow any in-flight microtasks to settle so the state machine has
      // fully committed to the speaking await before we fire the interrupt.
      await flushMicrotasks();

      // Now fire speech-start (barge-in).
      fire.speechStart();

      // Give microtasks a chance to run after the synchronous handler.
      await flushMicrotasks();

      // Should have cancelled TTS and gone back to listening.
      expect(cancelSpeak).toHaveBeenCalled();

      const last = handlers.states[handlers.states.length - 1];
      expect(last).toBe("listening");

      conv.stop();
    });
  });

  describe("(d) stop() aborts in-flight LLM + calls capture.stop", () => {
    it("capture.stop is called and no further state changes after stop", async () => {
      const { startCapture, stopSpy } = makeFakeCapture();
      const handlers = makeHandlers();

      // LLM stream that never finishes.
      async function* infiniteStream(): AsyncIterable<string> {
        while (true) {
          await new Promise((r) => setTimeout(r, 50));
          yield "chunk";
        }
      }

      const transcribe = vi.fn<VoiceConversationDeps["transcribe"]>().mockResolvedValue("test");
      const streamLlm = vi.fn<VoiceConversationDeps["streamLlm"]>().mockReturnValue(infiniteStream());
      const speak = vi.fn<VoiceConversationDeps["speak"]>();
      const cancelSpeak = vi.fn();

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        streamLlm,
        speak,
        cancelSpeak,
      });

      await conv.start();

      // Stop immediately without firing any utterance.
      conv.stop();

      expect(stopSpy).toHaveBeenCalled();
      // cancelSpeak must have been called.
      expect(cancelSpeak).toHaveBeenCalled();

      // State should be idle after stop.
      const last = handlers.states[handlers.states.length - 1];
      expect(last).toBe("idle");
    });
  });
});
