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

  // Load voices. Browsers (Chromium especially) populate them async; listen
  // for voiceschanged to catch the late arrival.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const refresh = () => {
      const all = synth.getVoices();
      // Only English voices. Sort by lang for predictable ordering.
      const filtered = all
        .filter((v) => v.lang.toLowerCase().startsWith("en"))
        .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
      setVoices(filtered);
    };
    refresh();
    synth.addEventListener("voiceschanged", refresh);
    return () => synth.removeEventListener("voiceschanged", refresh);
  }, []);

  // Persist voice choice; also pick a sensible default the first time.
  useEffect(() => {
    if (voiceURI) {
      localStorage.setItem(STORAGE_KEY, voiceURI);
      return;
    }
    if (voices.length > 0) {
      // Prefer a US-English voice if available, else first English voice.
      const preferred =
        voices.find((v) => v.lang.toLowerCase().startsWith("en-us")) ?? voices[0];
      setVoiceURI(preferred.voiceURI);
    }
  }, [voices, voiceURI]);

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

  return { voices, voiceURI, setVoiceURI, speak };
}
