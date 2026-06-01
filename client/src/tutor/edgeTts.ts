// src/tutor/edgeTts.ts
//
// Thin wrapper over the Rust `edge_tts_synthesize` command. The actual Edge
// neural-TTS WebSocket runs in Rust (src-tauri/src/commands/edge_tts.rs), NOT
// here: the synthesize endpoint requires an Edge Origin + User-Agent on the WS
// upgrade that a WebView WebSocket cannot set, so Microsoft accepts the upgrade
// then immediately closes the socket ("edge-tts closed early"). Rust sets those
// headers and returns the MP3 as base64, which we decode to an ArrayBuffer for
// playback.
//
// Network-only — callers fall back to local Web Speech (tts.ts) on any error so
// TTS still works offline.

import { invoke } from "@tauri-apps/api/core";

// Natural neural voices. Both read mixed zh+en in ONE request (gap-free) — the
// zh-native 晓晓 voice handles embedded English acceptably, and vice-versa — so
// the caller picks ONE by the text's dominant script rather than splitting into
// per-language requests (which reintroduced pauses at every switch). NOTE: the
// old single multilingual voice (zh-CN-XiaoxiaoMultilingualNeural) was removed
// by Microsoft and now returns "no audio" — don't reintroduce it.
export const EDGE_VOICE_ZH = "zh-CN-XiaoxiaoNeural"; // 晓晓 — warm female
export const EDGE_VOICE_EN = "en-US-AriaNeural"; // Aria — natural female

export interface EdgeSynthOptions {
  voice: string;
  rate?: number; // multiplier; default 1 (converted to the +N% Edge expects)
  signal?: AbortSignal;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Synthesize `text` to MP3 bytes via the Rust Edge-TTS command. Rejects on any
 *  failure (offline, blocked, empty) so callers can fall back to Web Speech.
 *  Rust enforces its own connect + read timeouts. */
export async function edgeSynthesize(
  text: string,
  opts: EdgeSynthOptions,
): Promise<ArrayBuffer> {
  if (opts.signal?.aborted) throw new Error("edge-tts aborted");
  const ratePct = Math.round(((opts.rate ?? 1) - 1) * 100);
  const b64 = await invoke<string>("edge_tts_synthesize", {
    text,
    voice: opts.voice,
    ratePct,
  });
  if (!b64) throw new Error("edge-tts: empty response");
  return base64ToArrayBuffer(b64);
}
