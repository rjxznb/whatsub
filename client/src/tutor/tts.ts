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
import { encodeWav16 } from "../voice/wav";
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

// ── Symbols the voice would VERBALIZE ────────────────────────────────────────
// A neural voice reads "/" as "slash", "*" as "asterisk", "→" as "right arrow".
// The tutor's text is LLM output — markdown-flavoured, full of notation that
// exists purely for the eye — so everything below is either dropped or turned
// into a pause. This is the single choke point: EVERY spoken line in the app
// (精讲 / 角色扮演 / 语料库 / 生词本 / 关键短语) goes through ttsSpeak → here.

/** Characters that only occur in IPA/phonetic transcription (IPA Extensions +
 *  spacing modifiers ˈ ˌ ː, plus the stray Latin/Greek borrowings æ ð ø θ). */
const IPA_CHARS = "ɐ-ʯʰ-˿æðøθ";
/** A phonetic span — `/prəˈnaʊns/` or `[ˈwɜːd]`. Dropped WHOLE: a TTS engine
 *  can't pronounce IPA, it spells the glyphs out as noise. Only spans that
 *  actually contain an IPA glyph match, so `and/or` and `[1]` are untouched. */
const IPA_SLASH_SPAN = new RegExp(`/[^/\\n]*[${IPA_CHARS}][^/\\n]*/`, "g");
const IPA_BRACKET_SPAN = new RegExp(`\\[[^\\]\\n]*[${IPA_CHARS}][^\\]\\n]*\\]`, "g");
const IPA_STRAY = new RegExp(`[${IPA_CHARS}]`, "g");
/** Arrows ("go → went") become a comma: a pause reads as the intended
 *  "becomes", where the glyph itself would be spoken as "right arrow". */
const ARROWS = /[←-⇿⟰-⟿⬀-⬑➔➜➡]/g;
/** Pictographs — several voices announce the emoji's NAME ("party popper"). */
const EMOJI = /[\p{Extended_Pictographic}‍️⃣]/gu;
/** Leftover notation with no spoken form. Becomes a space, never a word. */
const MUTE_SYMBOLS = /[/*_~^\\<>|#`•·‣▪◦※–]/g;

/** Strip markdown / notation noise so the voice doesn't read "asterisk
 *  asterisk word" or "slash" etc., and turn line / paragraph breaks into a
 *  spoken pause.
 *
 *  Pause handling: the free Edge readaloud endpoint ignores SSML `<break>`, and
 *  neural voices read a bare newline as a plain space (no breath) — so the only
 *  way to get "段落感" at "换行换段" is punctuation. We append a full stop to any
 *  line that doesn't already end with sentence/clause punctuation, then join
 *  with a space, so the voice pauses between paragraphs. */
export function stripForSpeech(text: string): string {
  const stripped = text
    // ── structural markdown — must run BEFORE the per-character strips, which
    //    would otherwise shred the delimiters these patterns need to match ──
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // link → link text, NEVER the URL
    .replace(/<[^<>\n]{1,60}>/g, " ") // html-ish tags
    .replace(/\bhttps?:\/\/\S+/gi, " ") // bare URL — unspeakable, and the "//"
    .replace(/\bwww\.\S+/gi, " ") //   would come out as "slash slash"
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/_([^_]+)_/g, "$1") // underscore emphasis
    .replace(/^[ \t]*[-*+•]\s+/gm, "") // list bullets (a lone "-" reads as "dash")
    // ── notation with no spoken form ──
    .replace(IPA_SLASH_SPAN, " ")
    .replace(IPA_BRACKET_SPAN, " ")
    .replace(IPA_STRAY, "")
    .replace(EMOJI, "")
    .replace(ARROWS, ", ")
    .replace(MUTE_SYMBOLS, " ")
    .replace(/[^\S\n]+/g, " "); // collapse spaces/tabs, keep newlines for now

  const lines = stripped
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    lines
      .map((line, i) =>
        // last line needs no trailing pause; earlier lines get a full stop so the
        // voice breathes at the break (unless they already end with punctuation)
        i === lines.length - 1 || TERMINAL_PUNCT.test(line) ? line : line + "。",
      )
      .join(" ")
      // A strip can strand a space before punctuation ("好的 。") or leave a
      // doubled separator (", 。") — both make the voice stumble.
      .replace(/([,，])\s*(?=[。.!?！？;；:：、…])/g, "")
      .replace(/\s+(?=[,，。.!?！？;；:：、…])/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  );
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

// ── TTS audio analysis (opt-in) ──────────────────────────────────────────
// The voice-mode orb visualizes the AI's spoken reply (amplitude + spectrum).
// Routing the <audio> through a Web Audio AnalyserNode is OPT-IN (voice mode
// turns it on while open) so it never touches the 精讲 lesson playback path.
let _ttsAnalyseEnabled = false;
let _ttsAudioCtx: AudioContext | null = null;
let _ttsAnalyser: AnalyserNode | null = null;
let _ttsTimeBuf: Uint8Array | null = null;
let _ttsFreqBuf: Uint8Array | null = null;

/** Enable/disable routing TTS playback through an analyser (voice mode only). */
export function setTtsAnalyse(on: boolean): void {
  _ttsAnalyseEnabled = on;
}

function attachTtsAnalyser(audio: HTMLAudioElement): void {
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    if (!_ttsAudioCtx) _ttsAudioCtx = new Ctx();
    void _ttsAudioCtx.resume().catch(() => {});
    const src = _ttsAudioCtx.createMediaElementSource(audio);
    const an = _ttsAudioCtx.createAnalyser();
    an.fftSize = 256;
    an.smoothingTimeConstant = 0.72;
    src.connect(an);
    an.connect(_ttsAudioCtx.destination);
    _ttsAnalyser = an;
  } catch {
    // Web Audio unavailable / element already sourced — play normally; the orb
    // just won't get a real spectrum (falls back to its idle motion).
    _ttsAnalyser = null;
  }
}

/** Current TTS amplitude (0..1) — RMS of the playing reply, 0 when silent. */
export function getTtsLevel(): number {
  const an = _ttsAnalyser;
  if (!an) return 0;
  if (!_ttsTimeBuf || _ttsTimeBuf.length !== an.fftSize)
    _ttsTimeBuf = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(_ttsTimeBuf);
  let sum = 0;
  for (let i = 0; i < _ttsTimeBuf.length; i++) {
    const v = (_ttsTimeBuf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / _ttsTimeBuf.length) * 3.4);
}

/** Downsampled TTS frequency spectrum into `n` bands (0..1 each) for the
 *  waveform ring. Uses the lower ~70% of bins (where voice energy lives). */
export function getTtsBands(n: number, out?: Float32Array): Float32Array {
  const res = out && out.length === n ? out : new Float32Array(n);
  const an = _ttsAnalyser;
  if (!an) {
    res.fill(0);
    return res;
  }
  const bins = an.frequencyBinCount;
  if (!_ttsFreqBuf || _ttsFreqBuf.length !== bins)
    _ttsFreqBuf = new Uint8Array(bins);
  an.getByteFrequencyData(_ttsFreqBuf);
  const used = Math.floor(bins * 0.7);
  for (let i = 0; i < n; i++) {
    const s = Math.floor((i / n) * used);
    const e = Math.max(s + 1, Math.floor(((i + 1) / n) * used));
    let m = 0;
    for (let j = s; j < e; j++) m = Math.max(m, _ttsFreqBuf[j]);
    res[i] = m / 255;
  }
  return res;
}

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

// ── Voice combo preference (persisted) ───────────────────────────────────
// The user picks ONE Chinese voice + ONE English voice; mixed lines are read
// with the combo (Chinese runs in the zh voice, English runs in the en voice).
// A missing/invalid stored id falls back to the language's default voice.
const TTS_VOICE_ZH_KEY = "tutor.ttsVoiceZh";
const TTS_VOICE_EN_KEY = "tutor.ttsVoiceEn";

function readVoice(key: string, prefix: "zh-" | "en-", fallback: string): string {
  try {
    const v = localStorage.getItem(key) ?? "";
    return v && v.startsWith(prefix) && EDGE_VOICE_IDS.has(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Chosen Chinese voice id (resolved — defaults to 晓晓). */
export function getTtsVoiceZh(): string {
  return readVoice(TTS_VOICE_ZH_KEY, "zh-", EDGE_VOICE_ZH);
}

/** Chosen English voice id (resolved — defaults to Aria). */
export function getTtsVoiceEn(): string {
  return readVoice(TTS_VOICE_EN_KEY, "en-", EDGE_VOICE_EN);
}

export function setTtsVoiceZh(id: string): void {
  try {
    localStorage.setItem(TTS_VOICE_ZH_KEY, id);
  } catch {
    /* ignore */
  }
}

export function setTtsVoiceEn(id: string): void {
  try {
    localStorage.setItem(TTS_VOICE_EN_KEY, id);
  } catch {
    /* ignore */
  }
}

/** Concatenate MP3 byte buffers into one (edge-tts CBR mp3 segments concatenate
 *  into a playable stream — lets one <audio> play a multi-voice line). */
function concatArrayBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

// ── Gapless concat for mixed-language lines ──────────────────────────────────
// Every Edge MP3 run is padded with ~0.3–0.5s of silence at its head AND tail.
// Concatenating runs raw stacks two paddings at each zh↔en boundary → a long
// dead gap mid-sentence. For mixed lines we decode each run to PCM, trim that
// silence, splice the runs with ONE small uniform gap, and re-encode to a single
// WAV so the line plays continuously. Single-run lines have no boundary and skip
// this entirely (keep the fast direct-MP3 path).
let _decodeCtx: AudioContext | null = null;
function getDecodeCtx(): AudioContext | null {
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return null;
    if (!_decodeCtx) _decodeCtx = new Ctx();
    return _decodeCtx;
  } catch {
    return null;
  }
}

/** First/last sample indices above a silence threshold, padded slightly so the
 *  speech onset/offset isn't clipped. */
function voiceBounds(ch: Float32Array, sampleRate: number): [number, number] {
  const thresh = 0.006;
  let start = 0;
  let end = ch.length;
  while (start < end && Math.abs(ch[start]) < thresh) start++;
  while (end > start && Math.abs(ch[end - 1]) < thresh) end--;
  const pad = Math.floor(sampleRate * 0.012); // ~12ms guard so onsets aren't clipped
  return [Math.max(0, start - pad), Math.min(ch.length, end + pad)];
}

/** Decode each MP3 run, trim head/tail silence, splice with a small uniform gap,
 *  and re-encode to one WAV. Returns null when Web Audio can't decode (no
 *  AudioContext / decode error) so the caller falls back to a raw MP3 concat. */
async function concatRunsGapless(parts: ArrayBuffer[]): Promise<Uint8Array | null> {
  const ctx = getDecodeCtx();
  if (!ctx) return null;
  let buffers: AudioBuffer[];
  try {
    // decodeAudioData detaches its argument — pass a copy so `parts` stays
    // usable for the raw-concat fallback.
    buffers = await Promise.all(parts.map((p) => ctx.decodeAudioData(p.slice(0))));
  } catch {
    return null;
  }
  const sr = ctx.sampleRate;
  const gap = Math.floor(sr * 0.06); // ~60ms breath between runs (not dead air)
  const trimmed = buffers.map((b) => {
    const ch = b.getChannelData(0);
    const [s, e] = voiceBounds(ch, sr);
    return ch.subarray(s, e);
  });
  const total =
    trimmed.reduce((n, t) => n + t.length, 0) +
    gap * Math.max(0, trimmed.length - 1);
  const merged = new Float32Array(total);
  let off = 0;
  trimmed.forEach((t, i) => {
    merged.set(t, off);
    off += t.length + (i < trimmed.length - 1 ? gap : 0);
  });
  return encodeWav16(merged, sr);
}

async function edgeTtsSpeak(
  clean: string,
  opts: SpeakOptions,
): Promise<boolean> {
  const ac = new AbortController();
  _currentAbort = ac;
  const rate = opts.rate ?? getTtsRate();

  // Read each language's runs in its OWN chosen voice: split the line into
  // zh / en runs and synthesize each at NORMAL speed with the matching voice,
  // then concatenate the MP3s into one clip. A pure-Chinese line is a single
  // run (one request); only mixed lines split. This is what lets the user pick
  // a Chinese voice + an English voice and hear the whole passage in the combo
  // — a lone English voice can't pronounce Chinese and SKIPS it.
  //
  // Speed is NOT baked into the SSML (synthesize at rate 1) — it's applied
  // client-side via audio.playbackRate below, so the user can pause/resume and
  // drag the speed slider LIVE at the current position instead of re-synthing.
  const zhVoice = getTtsVoiceZh();
  const enVoice = getTtsVoiceEn();
  const segs = splitByLang(clean);
  const runs = segs.length ? segs : [{ text: clean, lang: "zh" as const }];

  let clip: ArrayBuffer | Uint8Array;
  let mime = "audio/mpeg";
  try {
    const parts = await Promise.all(
      runs.map((r) =>
        edgeSynthesize(r.text, {
          voice: r.lang === "zh" ? zhVoice : enVoice,
          rate: 1,
          signal: ac.signal,
        }),
      ),
    );
    // Mixed lines: decode + trim the per-run silence padding so zh↔en plays
    // gaplessly. Falls back to a raw MP3 concat if Web Audio can't decode.
    if (runs.length > 1) {
      const wav = await concatRunsGapless(parts);
      if (wav) {
        clip = wav;
        mime = "audio/wav";
      } else {
        clip = concatArrayBuffers(parts);
      }
    } else {
      clip = concatArrayBuffers(parts);
    }
  } catch (e) {
    _lastEdgeError = e instanceof Error ? e.message : String(e);
    if (_currentAbort === ac) _currentAbort = null;
    return false; // → fall back to Web Speech
  }
  if (_cancelled || ac.signal.aborted) {
    opts.onEnd?.();
    return true;
  }
  if (clip.byteLength === 0) {
    _lastEdgeError = "edge-tts: no audio";
    if (_currentAbort === ac) _currentAbort = null;
    return false;
  }

  const url = URL.createObjectURL(new Blob([clip], { type: mime }));
  const audio = new Audio(url);
  audio.preservesPitch = true; // keep natural pitch when sped up / slowed down
  audio.playbackRate = rate;
  _currentAudio = audio;
  if (_ttsAnalyseEnabled) attachTtsAnalyser(audio); // voice-mode orb spectrum
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
