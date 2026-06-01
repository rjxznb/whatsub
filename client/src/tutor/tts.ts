// src/tutor/tts.ts
//
// Text-to-speech for 精讲 (guided lessons) + voice mode — reads the tutor's
// explanations / replies aloud so it feels like a class, not a wall of text.
//
// PRIMARY engine: Microsoft Edge neural TTS (edgeTts.ts) — natural cloud
// voices (晓晓 / Aria) that need no locally-installed voice. FALLBACK: the
// local Web Speech API (window.speechSynthesis / OS SAPI voices) when edge-tts
// is unreachable (offline / blocked). Text is split by language so Chinese
// runs use a Chinese voice and English runs an English voice.

import {
  edgeSynthesize,
  EDGE_VOICE_ZH,
  EDGE_VOICE_EN,
  EDGE_VOICE_IDS,
} from "./edgeTts";
import { useTtsStatus } from "./ttsStatus";

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

/** Trailing sentence/clause punctuation (zh + en) the neural voices pause on. */
const TERMINAL_PUNCT = /[。.!?！？…，,、;；:：]$/;

/** Strip markdown / formatting noise so the voice doesn't read "asterisk
 *  asterisk word" etc., and turn line / paragraph breaks into a spoken pause.
 *
 *  Pause handling: the free Edge readaloud endpoint ignores SSML `<break>`, and
 *  neural voices read a bare newline as a plain space (no breath) — so the only
 *  way to get "段落感" at "换行换段" is punctuation. We append a full stop to any
 *  line that doesn't already end with sentence/clause punctuation, then join
 *  with a space, so the voice pauses between paragraphs. */
export function stripForSpeech(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/_([^_]+)_/g, "$1") // underscore emphasis
    .replace(/[#>|]/g, " ") // headings / quotes / table pipes
    .replace(/[^\S\n]+/g, " "); // collapse spaces/tabs, keep newlines for now

  const lines = stripped
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines
    .map((line, i) =>
      // last line needs no trailing pause; earlier lines get a full stop so the
      // voice breathes at the break (unless they already end with punctuation)
      i === lines.length - 1 || TERMINAL_PUNCT.test(line) ? line : line + "。",
    )
    .join(" ")
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

// ── Playback state (for cancellation across both engines) ────────────────
let _currentAudio: HTMLAudioElement | null = null;
let _currentAbort: AbortController | null = null;
let _cancelled = false;
// Why edge-tts last failed (surfaced as the local-fallback reason).
let _lastEdgeError = "";

/** Primary path: synthesize each language run via Edge neural TTS and play the
 *  MP3s in order. Returns true if it handled playback (firing onStart/onEnd as
 *  needed), or false if it could not even start (synth failed / autoplay
 *  blocked on the first clip) so the caller can fall back to Web Speech. Never
 *  fires onStart/onEnd when it returns false. */
/** Pick the Edge voice by the text's dominant script: the zh-native 晓晓 voice
 *  for Chinese-dominant text (the tutor coaches in Chinese), Aria for
 *  English-dominant. Reading the whole line with one voice keeps it gap-free;
 *  each voice handles the other language's occasional words acceptably. Ties go
 *  to Chinese (the common case for 精讲). Exported for testing. */
export function pickEdgeVoice(text: string): string {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    if (/[㐀-鿿豈-﫿]/.test(ch)) cjk++;
    else if (/[a-zA-Z]/.test(ch)) latin++;
  }
  return latin > cjk ? EDGE_VOICE_EN : EDGE_VOICE_ZH;
}

// ── Voice preference (persisted) ─────────────────────────────────────────
// "" = auto (pickEdgeVoice by dominant script); otherwise a specific edge-tts
// voice id the user chose in the lesson accent dropdown.
const TTS_VOICE_KEY = "tutor.ttsVoice";

/** The user's chosen edge-tts voice, or "" for auto. Falls back to "" if the
 *  stored id is no longer in the catalog. */
export function getTtsVoice(): string {
  try {
    const v = localStorage.getItem(TTS_VOICE_KEY) ?? "";
    return v && EDGE_VOICE_IDS.has(v) ? v : "";
  } catch {
    return "";
  }
}

export function setTtsVoice(id: string): void {
  try {
    localStorage.setItem(TTS_VOICE_KEY, id);
  } catch {
    /* ignore */
  }
}

async function edgeTtsSpeak(
  clean: string,
  opts: SpeakOptions,
): Promise<boolean> {
  const ac = new AbortController();
  _currentAbort = ac;
  const rate = opts.rate ?? getTtsRate();

  // ONE request, ONE continuous MP3 — a single voice reads the whole line
  // (incl. embedded English) so there's no pause at language switches (separate
  // per-segment clips each had padding silence → long gaps). The voice is the
  // one matching the dominant script: 晓晓 for Chinese-dominant coaching, Aria
  // for English-dominant.
  //
  // Synthesize at NORMAL speed (rate 1) and apply the user's speed client-side
  // via audio.playbackRate below. Decoupling speed from synthesis is what lets
  // the user pause/resume and drag the speed slider LIVE at the current
  // position — baking the rate into the SSML would force a re-synth from the
  // start on every change.
  // The user's chosen accent overrides the automatic per-content pick.
  const voice = getTtsVoice() || pickEdgeVoice(clean);
  let mp3: ArrayBuffer;
  try {
    mp3 = await edgeSynthesize(clean, {
      voice,
      rate: 1,
      signal: ac.signal,
    });
  } catch (e) {
    _lastEdgeError = e instanceof Error ? e.message : String(e);
    if (_currentAbort === ac) _currentAbort = null;
    return false; // → fall back to Web Speech
  }
  if (_cancelled || ac.signal.aborted) {
    opts.onEnd?.();
    return true;
  }

  const url = URL.createObjectURL(new Blob([mp3], { type: "audio/mpeg" }));
  const audio = new Audio(url);
  audio.preservesPitch = true; // keep natural pitch when sped up / slowed down
  audio.playbackRate = rate;
  _currentAudio = audio;
  try {
    await audio.play(); // resolves once playback begins; throws if blocked
  } catch (e) {
    // Autoplay blocked before any sound — fall back to Web Speech (not
    // subject to the autoplay policy).
    _lastEdgeError = "音频自动播放被拦截: " + (e instanceof Error ? e.message : String(e));
    URL.revokeObjectURL(url);
    _currentAudio = null;
    if (_currentAbort === ac) _currentAbort = null;
    return false;
  }
  useTtsStatus.getState().set("edge");
  opts.onStart?.();
  await new Promise<void>((res) => {
    audio.onended = () => res();
    audio.onerror = () => res();
  });
  URL.revokeObjectURL(url);
  _currentAudio = null;
  if (_currentAbort === ac) _currentAbort = null;
  opts.onEnd?.();
  return true;
}

/** Speak `text`: Edge neural TTS first, local Web Speech as fallback. */
export async function ttsSpeak(
  text: string,
  opts: SpeakOptions = {},
): Promise<void> {
  const clean = stripForSpeech(text);
  if (!clean) {
    opts.onEnd?.();
    return;
  }
  _cancelled = false;
  // Stop anything currently playing on either engine.
  ttsCancel();
  _cancelled = false; // ttsCancel set it true; reset for this new utterance

  let handled = false;
  try {
    handled = await edgeTtsSpeak(clean, opts);
  } catch {
    handled = false;
  }
  if (handled || _cancelled) return;
  // Edge failed → local Web Speech fallback. Record why so the UI can show it.
  const reason = _lastEdgeError || "edge-tts 不可用";
  useTtsStatus.getState().set("local", reason);
  // eslint-disable-next-line no-console
  console.warn("[tts] edge-tts failed → local Web Speech fallback. reason:", reason);
  await webSpeechSpeak(clean, opts);
}

async function webSpeechSpeak(
  clean: string,
  opts: SpeakOptions = {},
): Promise<void> {
  if (!ttsSupported()) {
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
    u.rate = opts.rate ?? getTtsRate();
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
  _cancelled = true;
  if (_currentAbort) {
    try {
      _currentAbort.abort();
    } catch {
      /* ignore */
    }
    _currentAbort = null;
  }
  if (_currentAudio) {
    try {
      _currentAudio.pause();
      _currentAudio.src = "";
    } catch {
      /* ignore */
    }
    _currentAudio = null;
  }
  if (ttsSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** Pause in-flight speech, keeping the position so ttsResume() continues from
 *  the same spot (NOT a restart). Edge path pauses the <audio> element; Web
 *  Speech pauses the synth queue. No-op if nothing is playing. */
export function ttsPause(): void {
  if (_currentAudio && !_currentAudio.paused) {
    try {
      _currentAudio.pause();
    } catch {
      /* ignore */
    }
    return;
  }
  if (ttsSupported()) {
    try {
      window.speechSynthesis.pause();
    } catch {
      /* ignore */
    }
  }
}

/** Resume speech paused via ttsPause(). No-op if nothing is paused. */
export function ttsResume(): void {
  if (_currentAudio && _currentAudio.paused) {
    void _currentAudio.play().catch(() => {});
    return;
  }
  if (ttsSupported()) {
    try {
      window.speechSynthesis.resume();
    } catch {
      /* ignore */
    }
  }
}

/** Set the speaking rate: persist it AND apply LIVE to any in-flight edge
 *  playback (audio.playbackRate) so dragging the slider changes speed at the
 *  current position instead of restarting. Web Speech can't retune a running
 *  utterance — the next line picks up the new rate. */
export function ttsSetRate(rate: number): void {
  const clamped = Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate));
  setTtsRate(clamped); // persist
  if (_currentAudio) _currentAudio.playbackRate = clamped;
}

// ── Rate preference (persisted) ──────────────────────────────────────────
// Speaking rate multiplier (1 = normal). Tunable via the lesson overlay
// slider; used as the default for every utterance.

const TTS_RATE_KEY = "tutor.ttsRate";
export const TTS_RATE_DEFAULT = 1.12;
export const TTS_RATE_MIN = 0.7;
export const TTS_RATE_MAX = 1.8;

export function getTtsRate(): number {
  try {
    const v = parseFloat(localStorage.getItem(TTS_RATE_KEY) ?? "");
    if (!isNaN(v) && v >= TTS_RATE_MIN && v <= TTS_RATE_MAX) return v;
  } catch {
    /* ignore */
  }
  return TTS_RATE_DEFAULT;
}

export function setTtsRate(rate: number): void {
  const clamped = Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate));
  try {
    localStorage.setItem(TTS_RATE_KEY, String(clamped));
  } catch {
    /* ignore */
  }
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
