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

/** Split text into consecutive runs of Chinese (CJK) vs non-Chinese
 *  (English/ASCII) so each run can be read by the matching-language voice.
 *  Reading mixed zh+en text with a single voice sounds unnatural for the
 *  other language (English-accented Chinese, or vice-versa) — this is the
 *  core of "区分中英文切换". Whitespace/punctuation attach to the current run
 *  rather than breaking it, so we don't fragment into tiny choppy utterances. */
export function splitByLang(
  text: string,
): Array<{ text: string; lang: "zh" | "en" }> {
  const isCjk = (ch: string) =>
    /[㐀-鿿豈-﫿]/.test(ch); // CJK ideographs
  const isLatin = (ch: string) => /[a-zA-Z]/.test(ch);
  const out: Array<{ text: string; lang: "zh" | "en" }> = [];
  let cur = "";
  let curLang: "zh" | "en" | null = null;
  for (const ch of text) {
    const lang: "zh" | "en" | null = isCjk(ch)
      ? "zh"
      : isLatin(ch)
        ? "en"
        : null; // digits/punctuation/space — stick with the current run
    if (lang === null || curLang === null || lang === curLang) {
      cur += ch;
      if (curLang === null && lang !== null) curLang = lang;
      continue;
    }
    // language boundary — flush the current run, start a new one
    if (cur.trim()) out.push({ text: cur, lang: curLang });
    cur = ch;
    curLang = lang;
  }
  if (cur.trim() && curLang) out.push({ text: cur, lang: curLang });
  return out;
}

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

  // Resolve a voice per language ONCE. CRITICAL: always hand the engine a
  // REAL installed voice — setting u.lang to a language with no installed
  // voice produces total SILENCE in Chromium/WebView2 (the silent-精讲 bug).
  const zhVoice = pickVoice(voices, "zh-CN");
  const enVoice =
    pickVoice(voices, "en-US") ??
    voices.find((v) => v.lang.toLowerCase().startsWith("en"));
  const anyVoice = enVoice ?? zhVoice ?? voices[0];

  const segments = splitByLang(clean);
  if (segments.length === 0) {
    opts.onEnd?.();
    return;
  }

  // Speak each language run with its matching voice. speechSynthesis queues
  // utterances and plays them in order; onStart fires on the first, onEnd
  // once the last finishes.
  let startedFired = false;
  let remaining = segments.length;
  const finishOne = () => {
    remaining -= 1;
    if (remaining <= 0) opts.onEnd?.();
  };
  for (const seg of segments) {
    const u = new SpeechSynthesisUtterance(seg.text);
    const voice = seg.lang === "zh" ? (zhVoice ?? anyVoice) : (enVoice ?? anyVoice);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    // A touch faster than the 1.0 default — the previous pace felt sluggish.
    u.rate = opts.rate ?? 1.12;
    if (opts.pitch != null) u.pitch = opts.pitch;
    u.onstart = () => {
      if (!startedFired) {
        startedFired = true;
        opts.onStart?.();
      }
    };
    u.onend = () => {
      _liveUtterances.delete(u);
      finishOne();
    };
    u.onerror = () => {
      _liveUtterances.delete(u);
      opts.onError?.();
      finishOne();
    };
    _liveUtterances.add(u);
    synth.speak(u);
  }
  // WebView2 sometimes leaves the synthesis queue paused; resume defensively.
  try {
    synth.resume();
  } catch {
    /* ignore */
  }
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
