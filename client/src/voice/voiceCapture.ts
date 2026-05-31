/**
 * Mic capture + VAD + WAV encoding wiring.
 *
 * Captures 16kHz mono audio via getUserMedia → Web Audio ScriptProcessorNode,
 * feeds RMS values frame-by-frame into the Vad state machine, accumulates
 * Float32 samples while speech is active, and emits a base64 WAV via
 * `onUtterance` once the utterance ends.
 *
 * NOT unit-tested (requires real browser audio APIs). Kept small and defensive.
 *
 * WebView2 / Chromium compatibility notes:
 * - AudioContext({ sampleRate: 16000 }) — honored by Chromium/WebView2.
 *   We pass ctx.sampleRate (the ACTUAL rate) to encodeWav16 as a fallback
 *   in case the browser ignores our hint.
 * - ScriptProcessorNode is used instead of AudioWorklet because AudioWorklet
 *   requires a separate module file loadable as a Worker, which complicates
 *   Tauri's CSP and asset bundling. ScriptProcessorNode is deprecated but
 *   well-supported in WebView2 and fires reliably.
 * - The processor is connected to a 0-gain GainNode before ctx.destination so
 *   the browser actually fires onaudioprocess (some engines require the graph
 *   to be connected to the destination), without feeding mic audio back through
 *   the speakers.
 */

import { Vad } from "./vad";
import type { VadConfig } from "./vad";
import { encodeWav16, wavToBase64 } from "./wav";

export interface VoiceCaptureHandlers {
  /** Called with a complete spoken utterance encoded as base64 WAV. */
  onUtterance: (wavBase64: string) => void;
  /** Called each frame with the current RMS level (0–1) for visualisation. */
  onLevel?: (rms: number) => void;
  /** Called when speech starts — lets the caller interrupt TTS (barge-in). */
  onSpeechStart?: () => void;
  /** Called on microphone permission denial or AudioContext failure. */
  onError?: (err: string) => void;
}

export interface VoiceCapture {
  /** Stop capture, release the microphone, and close the AudioContext. */
  stop: () => void;
}

export async function startVoiceCapture(
  handlers: VoiceCaptureHandlers,
  vadConfig?: Partial<VadConfig>,
): Promise<VoiceCapture> {
  const { onUtterance, onLevel, onSpeechStart, onError } = handlers;

  // ── AudioContext ──────────────────────────────────────────────────────────
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
  } catch (err) {
    const msg = `AudioContext init failed: ${err}`;
    onError?.(msg);
    throw new Error(msg);
  }

  // ── Microphone ────────────────────────────────────────────────────────────
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (err) {
    await ctx.close().catch(() => {});
    const msg = "microphone permission denied or unavailable";
    onError?.(msg);
    throw new Error(msg);
  }

  // ── Web Audio graph ───────────────────────────────────────────────────────
  const source = ctx.createMediaStreamSource(stream);

  // ScriptProcessorNode: 4096-sample buffer, 1 input channel, 1 output channel.
  // Deprecated but reliably supported in WebView2 / Chromium without extra
  // Worker module files.
  const bufferSize = 4096;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processor: ScriptProcessorNode = (ctx as any).createScriptProcessor(
    bufferSize,
    1, // input channels
    1, // output channels
  );

  // Zero-gain node: required so the graph reaches ctx.destination (otherwise
  // some browsers don't fire onaudioprocess), but mic audio is NOT monitored.
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;

  source.connect(processor);
  processor.connect(muteGain);
  muteGain.connect(ctx.destination);

  // ── VAD + sample accumulator ──────────────────────────────────────────────
  const frameMs = (bufferSize / ctx.sampleRate) * 1000;
  const vad = new Vad({ ...vadConfig, frameMs });

  let sampleBuffer: Float32Array[] = [];
  let stopped = false;

  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    if (stopped) return;

    const channel = e.inputBuffer.getChannelData(0);

    // Compute RMS
    let sumSq = 0;
    for (let i = 0; i < channel.length; i++) sumSq += channel[i] * channel[i];
    const rms = Math.sqrt(sumSq / channel.length);
    onLevel?.(rms);

    const events = vad.push(rms);

    for (const evt of events) {
      if (evt.type === "speech-start") {
        // Start buffering — include this frame (it triggered speech-start).
        sampleBuffer = [channel.slice()];
        onSpeechStart?.();
      } else if (evt.type === "speech-end") {
        // Grab whatever was already buffered (speech-start frame included).
        const chunks = sampleBuffer;
        sampleBuffer = [];

        // Concatenate all Float32 chunks into a single array.
        const totalLength = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Float32Array(totalLength);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }

        const wav = encodeWav16(merged, ctx.sampleRate);
        const b64 = wavToBase64(wav);
        onUtterance(b64);
      }
    }

    // Accumulate samples while VAD is in speaking state.
    if (vad.speaking && events.find((e) => e.type === "speech-start") === undefined) {
      // speech-start already pushed the first frame; accumulate subsequent frames.
      sampleBuffer.push(channel.slice());
    }
  };

  // ── stop() ────────────────────────────────────────────────────────────────
  let stopCalled = false;
  function stop() {
    if (stopCalled) return;
    stopCalled = true;
    stopped = true;

    // Flush any in-progress utterance before tearing down.
    const flushed = vad.flush();
    for (const evt of flushed) {
      if (evt.type === "speech-end" && sampleBuffer.length > 0) {
        const totalLength = sampleBuffer.reduce((n, c) => n + c.length, 0);
        const merged = new Float32Array(totalLength);
        let off = 0;
        for (const c of sampleBuffer) {
          merged.set(c, off);
          off += c.length;
        }
        const wav = encodeWav16(merged, ctx.sampleRate);
        onUtterance(wavToBase64(wav));
      }
    }
    sampleBuffer = [];

    processor.disconnect();
    muteGain.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  }

  return { stop };
}
