import { useEffect, useState, useCallback } from "react";

const STORAGE_KEY = "speechVoiceURI";

/** Wraps `window.speechSynthesis` for English TTS only. Cross-platform via the
 *  Web Speech API: routes to Windows SAPI on WebView2 and to macOS speech
 *  synthesis on WKWebView. The voice list and selected URI are reactive. */
export function useSpeech() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
  );

  // Load voices. Chromium/WebView2 populates them async — sometimes the
  // voiceschanged event fires, sometimes it doesn't. Be defensive: poll for
  // up to ~3 seconds after mount before giving up.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) {
      console.warn("[useSpeech] window.speechSynthesis is undefined");
      return;
    }
    let cancelled = false;
    const refresh = () => {
      const all = synth.getVoices();
      // Sort English voices first (the obvious choice for English content),
      // then everything else. Don't filter — if the user has no English voice
      // we still want them to see the dropdown so the hint makes sense.
      const sorted = [...all].sort((a, b) => {
        const aEn = a.lang.toLowerCase().startsWith("en") ? 0 : 1;
        const bEn = b.lang.toLowerCase().startsWith("en") ? 0 : 1;
        if (aEn !== bEn) return aEn - bEn;
        return a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
      });
      if (!cancelled) setVoices(sorted);
      const enCount = sorted.filter((v) =>
        v.lang.toLowerCase().startsWith("en")
      ).length;
      if (all.length === 0) {
        console.log(
          "[useSpeech] getVoices() returned 0 — waiting for voiceschanged or poll"
        );
      } else {
        console.log(
          `[useSpeech] ${all.length} total voices, ${enCount} English`
        );
      }
    };
    refresh();
    synth.addEventListener("voiceschanged", refresh);
    // Poll fallback for WebView2 quirks where voiceschanged never fires.
    const intervals = [200, 500, 1000, 2000, 3000].map((ms) =>
      setTimeout(refresh, ms)
    );
    return () => {
      cancelled = true;
      synth.removeEventListener("voiceschanged", refresh);
      intervals.forEach(clearTimeout);
    };
  }, []);

  // Persist voice choice; also pick a sensible default the first time.
  useEffect(() => {
    if (voiceURI) {
      localStorage.setItem(STORAGE_KEY, voiceURI);
      return;
    }
    if (voices.length > 0) {
      // Prefer en-US, else any English, else just the first voice.
      const preferred =
        voices.find((v) => v.lang.toLowerCase().startsWith("en-us")) ??
        voices.find((v) => v.lang.toLowerCase().startsWith("en")) ??
        voices[0];
      setVoiceURI(preferred.voiceURI);
    }
  }, [voices, voiceURI]);

  /** True iff at least one voice has an English language tag. */
  const hasEnglish = voices.some((v) => v.lang.toLowerCase().startsWith("en"));

  const speak = useCallback(
    (text: string) => {
      const synth = window.speechSynthesis;
      if (!synth || !text) return;
      // Cancel any in-flight utterance — clicking a different phrase should
      // interrupt, not queue.
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = voices.find((v) => v.voiceURI === voiceURI);
      if (v) u.voice = v;
      u.rate = 0.95;
      u.pitch = 1;
      synth.speak(u);
    },
    [voices, voiceURI]
  );

  return { voices, voiceURI, setVoiceURI, speak, hasEnglish };
}
