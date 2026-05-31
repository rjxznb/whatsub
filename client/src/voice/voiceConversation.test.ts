/**
 * Tests for VoiceConversation state machine.
 *
 * All real browser APIs (AudioContext, getUserMedia), whisper, agent, and TTS
 * are replaced by fakes injected through `deps`.
 *
 * The `streamLlm` dep was replaced by `respond` (a simple async fn that
 * accepts userText + signal and returns the reply string). Tests inject a fake
 * `respond` that resolves with a predetermined string.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoiceConversation, detectLang } from "./voiceConversation";
import type { VoiceConversationHandlers, VoiceConversationDeps } from "./voiceConversation";
import type { VoiceState } from "./types";
import type { Settings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Drain all pending microtasks. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

describe("detectLang", () => {
  it("returns en-US when > 60% of chars are ASCII letters", () => {
    expect(detectLang("Hello world")).toBe("en-US");
    expect(detectLang("Nice to meet you!")).toBe("en-US");
  });

  it("returns zh-CN for Chinese text", () => {
    expect(detectLang("你好，有什么需要帮助的吗？")).toBe("zh-CN");
    expect(detectLang("好的，我明白了")).toBe("zh-CN");
  });

  it("returns zh-CN for empty string", () => {
    expect(detectLang("")).toBe("zh-CN");
  });
});

describe("VoiceConversation", () => {
  describe("(a) happy path — full turn", () => {
    it("transcribe → onUserText → respond → onAssistantText(done) → speak(detected lang) → state ends listening", async () => {
      const { startCapture, fire } = makeFakeCapture();
      const handlers = makeHandlers();

      const transcribe = vi.fn<VoiceConversationDeps["transcribe"]>().mockResolvedValue("Hello world");
      const speak = vi.fn<VoiceConversationDeps["speak"]>().mockImplementation(async (_text, opts) => {
        opts.onEnd?.();
      });
      const cancelSpeak = vi.fn();
      const respond = vi.fn<VoiceConversationDeps["respond"]>().mockResolvedValue("你好");

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        respond,
        speak,
        cancelSpeak,
      });

      await conv.start();
      expect(handlers.states).toContain("listening");

      fire.utterance("wav-data");

      await vi.waitFor(
        () => {
          const last = handlers.states[handlers.states.length - 1];
          if (handlers.states.length < 5) throw new Error("states not ready");
          if (last !== "listening") throw new Error("not yet back to listening");
        },
        { timeout: 5000, interval: 10 },
      );

      expect(transcribe).toHaveBeenCalledWith("wav-data");
      expect(handlers.userTexts).toEqual(["Hello world"]);
      expect(respond).toHaveBeenCalledOnce();
      // respond is called with trimmed user text + a signal
      expect(respond.mock.calls[0][0]).toBe("Hello world");
      expect(respond.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
      expect(handlers.assistantFinals).toEqual(["你好"]);
      // speak should be called with a lang from detectLang("你好") = "zh-CN"
      expect(speak).toHaveBeenCalledWith(
        "你好",
        expect.objectContaining({ lang: "zh-CN" }),
      );
      // State sequence: listening → transcribing → thinking → speaking → listening
      expect(handlers.states).toEqual(
        expect.arrayContaining(["listening", "transcribing", "thinking", "speaking"]),
      );
      const lastState = handlers.states[handlers.states.length - 1];
      expect(lastState).toBe("listening");

      conv.stop();
    });

    it("uses en-US lang when agent replies in English", async () => {
      const { startCapture, fire } = makeFakeCapture();
      const handlers = makeHandlers();

      const transcribe = vi.fn<VoiceConversationDeps["transcribe"]>().mockResolvedValue("Say something");
      const speak = vi.fn<VoiceConversationDeps["speak"]>().mockImplementation(async (_text, opts) => {
        opts.onEnd?.();
      });
      const cancelSpeak = vi.fn();
      const respond = vi.fn<VoiceConversationDeps["respond"]>().mockResolvedValue("Nice to meet you!");

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        respond,
        speak,
        cancelSpeak,
      });

      await conv.start();
      fire.utterance("wav-data");

      await vi.waitFor(
        () => {
          const last = handlers.states[handlers.states.length - 1];
          if (last !== "listening") throw new Error("not yet back to listening");
        },
        { timeout: 5000, interval: 10 },
      );

      expect(speak).toHaveBeenCalledWith(
        "Nice to meet you!",
        expect.objectContaining({ lang: "en-US" }),
      );

      conv.stop();
    });
  });

  describe("(b) empty transcript", () => {
    it("returns to listening without calling agent", async () => {
      const { startCapture, fire } = makeFakeCapture();
      const handlers = makeHandlers();

      const transcribe = vi.fn<VoiceConversationDeps["transcribe"]>().mockResolvedValue("   ");
      const respond = vi.fn<VoiceConversationDeps["respond"]>();
      const speak = vi.fn<VoiceConversationDeps["speak"]>();
      const cancelSpeak = vi.fn();

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        respond,
        speak,
        cancelSpeak,
      });

      await conv.start();
      fire.utterance("silent-wav");

      await vi.waitFor(
        () => {
          if (handlers.states.length < 3) throw new Error("states not ready");
          const last = handlers.states[handlers.states.length - 1];
          if (last !== "listening") throw new Error("not yet back to listening");
        },
        { timeout: 3000, interval: 10 },
      );

      expect(respond).not.toHaveBeenCalled();
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
      const respond = vi.fn<VoiceConversationDeps["respond"]>().mockResolvedValue("Sure!");

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        respond,
        speak,
        cancelSpeak,
      });

      await conv.start();

      fire.utterance("wav1");

      await vi.waitFor(
        () => {
          if (!handlers.states.includes("speaking")) throw new Error("not speaking yet");
        },
        { timeout: 3000, interval: 10 },
      );

      await flushMicrotasks();

      fire.speechStart();

      await flushMicrotasks();

      expect(cancelSpeak).toHaveBeenCalled();

      const last = handlers.states[handlers.states.length - 1];
      expect(last).toBe("listening");

      conv.stop();
    });
  });

  describe("(d) stop() aborts in-flight agent + calls capture.stop", () => {
    it("capture.stop is called and no further state changes after stop", async () => {
      const { startCapture, stopSpy } = makeFakeCapture();
      const handlers = makeHandlers();

      // respond that never finishes.
      const respond = vi.fn<VoiceConversationDeps["respond"]>().mockReturnValue(
        new Promise(() => { /* never resolves */ }),
      );
      const transcribe = vi.fn<VoiceConversationDeps["transcribe"]>().mockResolvedValue("test");
      const speak = vi.fn<VoiceConversationDeps["speak"]>();
      const cancelSpeak = vi.fn();

      const conv = new VoiceConversation(SETTINGS, handlers, {
        startCapture,
        transcribe,
        respond,
        speak,
        cancelSpeak,
      });

      await conv.start();

      conv.stop();

      expect(stopSpy).toHaveBeenCalled();
      expect(cancelSpeak).toHaveBeenCalled();

      const last = handlers.states[handlers.states.length - 1];
      expect(last).toBe("idle");
    });
  });
});
