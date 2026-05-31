// src/tutor/tts.ts
//
// Text-to-speech for 精讲 (guided lessons) — makes the tutor read its
// explanations / questions / feedback aloud so a lesson feels like a real
// class instead of a wall of text.
//
// Uses the Web Speech API (`window.speechSynthesis`), which is the WebView's
// binding to the OS-native TTS engine: SAPI voices on Windows (WebView2),
// AVSpeechSynthesizer voices on macOS (WKWebView). No sidecar, no network
// (TTS runs locally), no permissions — so there's no CSP impact.
//
// Everything degrades gracefully when speechSynthesis is unavailable: speak
// becomes a no-op that still fires onEnd, so callers never hang.

let cachedVoices: SpeechSynthesisVoice[] = [];

export function ttsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/** Voices load asynchronously on some platforms (getVoices() is empty until
 *  `onvoiceschanged` fires). Resolve with whatever is available, with a
 *  short timeout fallback for platforms that never fire the event. */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!ttsSupported()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length > 0) {
    cachedVoices = now;
    return Promise.resolve(now);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cachedVoices = synth.getVoices();
      resolve(cachedVoices);
    };
    synth.onvoiceschanged = finish;
    setTimeout(finish, 500);
  });
}

/** Prefer an exact lang match, then a language-family match (zh-* for zh-CN),
 *  else fall back to the engine default (undefined). */
function pickVoice(
  voices: SpeechSynthesisVoice[],
  lang: string,
): SpeechSynthesisVoice | undefined {
  const lower = lang.toLowerCase();
  const family = lower.split("-")[0];
  return (
    voices.find((v) => v.lang.toLowerCase() === lower) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(family))
  );
}

/** Strip markdown / formatting noise so the voice doesn't read "asterisk
 *  asterisk word" etc. Keeps the actual words + punctuation. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/_([^_]+)_/g, "$1") // underscore emphasis
    .replace(/[#>|]/g, " ") // headings / quotes / table pipes
    .replace(/\s+/g, " ")
    .trim();
}

export interface SpeakOptions {
  lang?: string; // default "zh-CN" (the tutor explains in Chinese)
  rate?: number; // default 1
  pitch?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
}

/** Speak `text`, cancelling any in-flight utterance first. Resolves
 *  immediately after queuing — use the onStart/onEnd callbacks for state. */
// Strong references to in-flight utterances. Chromium/WebView2 garbage-collect
// SpeechSynthesisUtterance objects that aren't referenced anywhere, which
// silently kills playback before any sound comes out — the single most common
// cause of "speechSynthesis.speak() does nothing". Holding them here until
// they end/error keeps them alive.
const _liveUtterances = new Set<SpeechSynthesisUtterance>();

export async function ttsSpeak(
  text: string,
  opts: SpeakOptions = {},
): Promise<void> {
  const clean = stripForSpeech(text);
  if (!ttsSupported() || !clean) {
    opts.onEnd?.();
    return;
  }
  const synth = window.speechSynthesis;
  try {
    synth.cancel(); // never overlap two utterances
  } catch {
    /* ignore */
  }
  const voices = cachedVoices.length ? cachedVoices : await loadVoices();
  // Calling speak() in the same tick as cancel() can no-op on some Chromium
  // builds — yield a macrotask so the queue settles first.
  await new Promise((r) => setTimeout(r, 0));
  const lang = opts.lang ?? "zh-CN";
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = lang;
  u.rate = opts.rate ?? 1;
  if (opts.pitch != null) u.pitch = opts.pitch;
  const v = pickVoice(voices, lang);
  if (v) u.voice = v;
  u.onstart = () => opts.onStart?.();
  u.onend = () => {
    _liveUtterances.delete(u);
    opts.onEnd?.();
  };
  u.onerror = () => {
    _liveUtterances.delete(u);
    opts.onError?.();
    opts.onEnd?.();
  };
  _liveUtterances.add(u);
  // WebView2 sometimes leaves the synthesis queue in a paused state; resume
  // defensively right before speaking.
  try {
    synth.resume();
  } catch {
    /* ignore */
  }
  synth.speak(u);
}

export function ttsCancel(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

// ── Mute preference (persisted) ──────────────────────────────────────────
// Lessons auto-speak by default; the user can mute via the overlay toggle.

const TTS_ENABLED_KEY = "tutor.ttsEnabled";

export function isTtsEnabled(): boolean {
  try {
    return localStorage.getItem(TTS_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setTtsEnabled(on: boolean): void {
  try {
    localStorage.setItem(TTS_ENABLED_KEY, on ? "true" : "false");
  } catch {
    /* ignore */
  }
  if (!on) ttsCancel();
}
