/**
 * VoiceConversation — state machine that orchestrates capture → STT → LLM → TTS
 * in a loop, with barge-in support.
 *
 * All dependencies are injectable so the class is unit-testable without real
 * browser audio, whisper, or network calls.
 */

import type { VoiceState, VoiceTurn } from "./types";
import { startVoiceCapture } from "./voiceCapture";
import { transcribeVoice } from "./voiceStt";
import { getProvider } from "../llm/providers";
import { ttsSpeak, ttsCancel } from "../tutor/tts";
import type { Settings } from "../types/settings";
import type { VoiceCaptureHandlers } from "./voiceCapture";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VoiceCapture {
  stop: () => void;
}

export interface VoiceConversationDeps {
  startCapture: (
    handlers: VoiceCaptureHandlers,
    vadConfig?: Record<string, unknown>,
  ) => Promise<VoiceCapture>;
  transcribe: (wav: string) => Promise<string>;
  streamLlm: (
    systemPrompt: string,
    userPrompt: string,
    signal: AbortSignal,
  ) => AsyncIterable<string>;
  speak: (
    text: string,
    opts: { lang: string; onStart?: () => void; onEnd?: () => void },
  ) => Promise<void>;
  cancelSpeak: () => void;
}

export interface VoiceConversationHandlers {
  onState: (s: VoiceState) => void;
  onLevel: (rms: number) => void;
  onUserText: (text: string) => void;
  onAssistantText: (text: string, done: boolean) => void;
  onError: (msg: string) => void;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a warm, encouraging English conversation partner helping a Chinese " +
  "learner practice speaking. Reply in natural spoken English, 1-3 short sentences. " +
  "Keep the conversation going by asking a simple follow-up question. If the learner " +
  "seems stuck or asks in Chinese, you may briefly use Chinese to help, then steer " +
  "back to English. Gently model better phrasing when they make a clear mistake, " +
  "but don't lecture.";

// ── Helper: build userPrompt from history ─────────────────────────────────────

function buildUserPrompt(history: VoiceTurn[]): string {
  // Fold entire history into the user prompt since provider.stream() only
  // has systemPrompt + userPrompt (no messages array).
  return history
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n");
}

// ── VoiceConversation class ───────────────────────────────────────────────────

export class VoiceConversation {
  private readonly settings: Settings;
  private readonly handlers: VoiceConversationHandlers;
  private readonly deps: VoiceConversationDeps;

  private state: VoiceState = "idle";
  private history: VoiceTurn[] = [];
  private capture: VoiceCapture | null = null;
  private abortController: AbortController | null = null;
  private stopped = false;

  constructor(
    settings: Settings,
    handlers: VoiceConversationHandlers,
    deps?: Partial<VoiceConversationDeps>,
  ) {
    this.settings = settings;
    this.handlers = handlers;

    // Build default deps from real modules; callers can override any subset
    // for testing.
    const self = this;
    this.deps = {
      startCapture: startVoiceCapture as unknown as VoiceConversationDeps["startCapture"],
      transcribe: transcribeVoice,
      streamLlm(systemPrompt, userPrompt, signal) {
        return getProvider(self.settings).stream({ systemPrompt, userPrompt, signal });
      },
      speak(text, opts) {
        return ttsSpeak(text, opts);
      },
      cancelSpeak: ttsCancel,
      ...deps,
    };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.stopped) return;

    try {
      this.capture = await this.deps.startCapture({
        onUtterance: (wav) => this.handleUtterance(wav),
        onLevel: (rms) => this.handlers.onLevel(rms),
        onSpeechStart: () => this.handleSpeechStart(),
        onError: (msg) => this.handleError(msg),
      });
    } catch (err) {
      // startCapture already called onError; nothing extra to do.
      // The caller may inspect state === "error" for UI feedback.
      return;
    }

    this.setState("listening");
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    // Abort any in-flight LLM request.
    this.abortController?.abort();
    this.abortController = null;

    // Stop TTS playback.
    this.deps.cancelSpeak();

    // Release the microphone.
    this.capture?.stop();
    this.capture = null;

    this.setState("idle");
  }

  // ── Private: state transitions ──────────────────────────────────────────────

  private setState(s: VoiceState) {
    this.state = s;
    this.handlers.onState(s);
  }

  // ── Private: capture callbacks ──────────────────────────────────────────────

  /** Fired when VAD detects speech start — used for barge-in. */
  private handleSpeechStart() {
    if (this.stopped) return;
    if (this.state === "speaking") {
      // Barge-in: cancel TTS and switch back to listening.
      this.deps.cancelSpeak();
      this.setState("listening");
    }
    // For thinking/transcribing we don't interrupt — v1 doesn't support
    // interrupting an in-flight turn.
  }

  /** Fired when a complete utterance is ready. Only process if we're in
   *  "listening" state; otherwise the utterance is dropped (one-at-a-time). */
  private handleUtterance(wav: string) {
    if (this.stopped) return;
    if (this.state !== "listening") return;

    // Kick off the async turn; errors surface to onError.
    this.runTurn(wav).catch((err) => {
      if (!this.stopped) {
        this.handleError(String(err));
      }
    });
  }

  private handleError(msg: string) {
    if (this.stopped) return;
    this.setState("error");
    this.handlers.onError(msg);
  }

  // ── Private: single conversation turn ──────────────────────────────────────

  private async runTurn(wav: string): Promise<void> {
    // ── STT ──────────────────────────────────────────────────────────────────
    this.setState("transcribing");
    let userText: string;
    try {
      userText = await this.deps.transcribe(wav);
    } catch (err) {
      this.handleError(`转录失败: ${err}`);
      return;
    }

    // Empty / silence → go back to listening.
    if (!userText.trim()) {
      this.setState("listening");
      return;
    }

    // Commit user turn to history and notify UI.
    this.history.push({ role: "user", text: userText.trim() });
    this.handlers.onUserText(userText.trim());

    // ── LLM ──────────────────────────────────────────────────────────────────
    this.setState("thinking");

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let accumulated = "";
    try {
      const stream = this.deps.streamLlm(
        SYSTEM_PROMPT,
        buildUserPrompt(this.history),
        signal,
      );
      for await (const chunk of stream) {
        if (this.stopped || signal.aborted) break;
        accumulated += chunk;
        this.handlers.onAssistantText(accumulated, false);
      }
    } catch (err) {
      if (this.stopped || signal.aborted) {
        // Normal shutdown — don't report as error.
        return;
      }
      this.handleError(`LLM 错误: ${err}`);
      return;
    }

    if (this.stopped || signal.aborted) return;

    const assistantText = accumulated.trim();
    this.history.push({ role: "assistant", text: assistantText });
    this.handlers.onAssistantText(assistantText, true);

    // ── TTS ──────────────────────────────────────────────────────────────────
    this.setState("speaking");

    await new Promise<void>((resolve) => {
      this.deps.speak(assistantText, {
        lang: "en-US",
        onEnd: () => {
          resolve();
        },
      }).catch(() => {
        resolve();
      });
    });

    if (this.stopped) return;

    // Only advance to listening if the state is still "speaking" (barge-in
    // could have already flipped it back to "listening").
    if (this.state === "speaking") {
      this.setState("listening");
    }
  }
}
