/**
 * VoiceConversation — state machine that orchestrates capture → STT → Agent → TTS
 * in a loop, with barge-in support.
 *
 * The LLM step now goes through `sendAgentMessage` (the shared 22-tool agent)
 * instead of a standalone one-shot `streamLlm`. All other dependencies remain
 * injectable so the class is unit-testable without real browser audio, whisper,
 * or network calls.
 *
 * HIGH-risk tool confirmations are auto-declined in voice mode (no UI for
 * inline confirm cards). LOW / MID tools proceed normally.
 */

import type { VoiceState } from "./types";
import { startVoiceCapture } from "./voiceCapture";
import { transcribeVoice } from "./voiceStt";
import { ttsSpeak, ttsCancel } from "../tutor/tts";
import type { Settings } from "../types/settings";
import type { VoiceCaptureHandlers } from "./voiceCapture";
import type { ToolDef } from "../agent/types";
import type { ConfirmDecision } from "../agent/runtime";
import { sendAgentMessage } from "../agent/send";

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
  /** Send user text through the agent and resolve with the reply text. */
  respond: (userText: string, signal: AbortSignal) => Promise<string>;
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

// ── TTS language auto-detect ──────────────────────────────────────────────────

/**
 * Pick a TTS language based on the character composition of `text`.
 * If > 60% of non-space characters are ASCII letters, we treat the reply as
 * English; otherwise Chinese. The agent typically replies in Chinese unless
 * the conversation is explicitly in English.
 */
export function detectLang(text: string): "en-US" | "zh-CN" {
  const stripped = text.replace(/\s/g, "");
  if (!stripped.length) return "zh-CN";
  const asciiLetters = stripped.replace(/[^A-Za-z]/g, "").length;
  return asciiLetters / stripped.length > 0.6 ? "en-US" : "zh-CN";
}

// ── Voice confirm — auto-decline HIGH-risk tools ──────────────────────────────

/**
 * Confirm callback for voice mode. HIGH-risk tools (delete_video, etc.) are
 * automatically declined because there are no visible confirm cards in the
 * full-screen orb. LOW tools never call confirm; MID tools are allowed through
 * with "yes" (they are reversible and non-destructive).
 */
export async function voiceConfirm(
  _toolDef: ToolDef,
  _args: unknown,
  tier: "MID" | "HIGH",
): Promise<ConfirmDecision> {
  if (tier === "HIGH") return "no_user_clicked";
  return "yes";
}

// ── VoiceConversation class ───────────────────────────────────────────────────

export class VoiceConversation {
  private readonly handlers: VoiceConversationHandlers;
  private readonly deps: VoiceConversationDeps;

  private state: VoiceState = "idle";
  private capture: VoiceCapture | null = null;
  private abortController: AbortController | null = null;
  private stopped = false;

  constructor(
    settings: Settings,
    handlers: VoiceConversationHandlers,
    deps?: Partial<VoiceConversationDeps>,
  ) {
    // settings is accepted for API compatibility but not needed internally
    // (sendAgentMessage reads it from the store). Kept in the constructor so
    // callers don't need to change their instantiation code.
    void settings;
    this.handlers = handlers;

    this.deps = {
      startCapture: startVoiceCapture as unknown as VoiceConversationDeps["startCapture"],
      transcribe: transcribeVoice,
      respond(userText, signal) {
        return sendAgentMessage(userText, { signal, confirm: voiceConfirm });
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
    } catch {
      // startCapture already called onError; nothing extra to do.
      return;
    }

    this.setState("listening");
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    // Abort any in-flight agent request.
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

    this.handlers.onUserText(userText.trim());

    // ── Agent ─────────────────────────────────────────────────────────────────
    this.setState("thinking");

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    let replyText = "";
    try {
      replyText = await this.deps.respond(userText.trim(), signal);
    } catch (err) {
      if (this.stopped || signal.aborted) {
        // Normal shutdown — don't report as error.
        return;
      }
      this.handleError(`Agent 错误: ${err}`);
      return;
    }

    if (this.stopped || signal.aborted) return;

    this.handlers.onAssistantText(replyText, true);

    // ── TTS ──────────────────────────────────────────────────────────────────
    this.setState("speaking");

    const lang = detectLang(replyText);

    await new Promise<void>((resolve) => {
      this.deps.speak(replyText, {
        lang,
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
