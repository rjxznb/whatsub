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

/** Curated edge-tts voices for the lesson accent picker, grouped by accent.
 *  Not the full ~300-voice catalog — these are the accents that matter for an
 *  English learner (US / UK / AU / CA / IN / IE) plus Chinese voices for the
 *  Chinese coaching. Picking one overrides the automatic per-content choice. */
export const EDGE_VOICE_GROUPS: {
  group: string;
  voices: { id: string; label: string }[];
}[] = [
  {
    group: "美式英语",
    voices: [
      { id: "en-US-AriaNeural", label: "Aria（女）" },
      { id: "en-US-JennyNeural", label: "Jenny（女）" },
      { id: "en-US-MichelleNeural", label: "Michelle（女）" },
      { id: "en-US-GuyNeural", label: "Guy（男）" },
      { id: "en-US-ChristopherNeural", label: "Christopher（男）" },
      { id: "en-US-EricNeural", label: "Eric（男）" },
    ],
  },
  {
    group: "英式英语",
    voices: [
      { id: "en-GB-SoniaNeural", label: "Sonia（女）" },
      { id: "en-GB-LibbyNeural", label: "Libby（女）" },
      { id: "en-GB-RyanNeural", label: "Ryan（男）" },
      { id: "en-GB-ThomasNeural", label: "Thomas（男）" },
    ],
  },
  {
    group: "澳洲英语",
    voices: [
      { id: "en-AU-NatashaNeural", label: "Natasha（女）" },
      { id: "en-AU-WilliamMultilingualNeural", label: "William（男）" },
    ],
  },
  {
    group: "加拿大英语",
    voices: [
      { id: "en-CA-ClaraNeural", label: "Clara（女）" },
      { id: "en-CA-LiamNeural", label: "Liam（男）" },
    ],
  },
  {
    group: "印度英语",
    voices: [
      { id: "en-IN-NeerjaNeural", label: "Neerja（女）" },
      { id: "en-IN-PrabhatNeural", label: "Prabhat（男）" },
    ],
  },
  {
    group: "爱尔兰英语",
    voices: [
      { id: "en-IE-EmilyNeural", label: "Emily（女）" },
      { id: "en-IE-ConnorNeural", label: "Connor（男）" },
    ],
  },
  {
    group: "中文 · 普通话",
    voices: [
      { id: "zh-CN-XiaoxiaoNeural", label: "晓晓（女）" },
      { id: "zh-CN-XiaoyiNeural", label: "晓伊（女）" },
      { id: "zh-CN-YunxiNeural", label: "云希（男）" },
      { id: "zh-CN-YunjianNeural", label: "云健（男）" },
      { id: "zh-CN-YunyangNeural", label: "云扬（男）" },
    ],
  },
  {
    group: "中文 · 台湾 / 粤语",
    voices: [
      { id: "zh-TW-HsiaoChenNeural", label: "曉臻 · 台湾（女）" },
      { id: "zh-TW-YunJheNeural", label: "雲哲 · 台湾（男）" },
      { id: "zh-HK-HiuMaanNeural", label: "曉曼 · 粤语（女）" },
      { id: "zh-HK-WanLungNeural", label: "雲龍 · 粤语（男）" },
    ],
  },
];

/** Flat set of valid picker voice ids — used to validate a persisted choice. */
export const EDGE_VOICE_IDS: ReadonlySet<string> = new Set(
  EDGE_VOICE_GROUPS.flatMap((g) => g.voices.map((v) => v.id)),
);

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
