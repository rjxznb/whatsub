// src/components/voice/VoiceOrb.tsx
//
// Voice-mode orb: a CSS rotating-glow ring (adapted from a Uiverse.io loader by
// joao-canais) with per-letter brand shimmer. No WebGL — pure CSS animation on a
// transparent background so the app stays visible behind the voice overlay.
//
// Stays voice-reactive: each frame we feed a smoothed amplitude (TTS level while
// speaking, mic level while listening) into the `--vorb-amp` CSS var, which the
// ring scales with — so it still breathes with the voice.

import { useEffect, useRef } from "react";
import type { VoiceState } from "../../voice/types";
import { getTtsLevel } from "../../tutor/tts";
import "./VoiceOrb.css";

interface Props {
  state: VoiceState;
  /** Mic level 0..1 (the user speaking). */
  level: number;
  size?: number;
}

const BRAND = "whatsub";

export function VoiceOrb({ state, level, size = 200 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const levelRef = useRef(level);
  levelRef.current = level;

  useEffect(() => {
    let raf = 0;
    let amp = 0;
    const tick = () => {
      const st = stateRef.current;
      let raw = 0;
      if (st === "speaking") raw = getTtsLevel();
      else if (st === "listening") raw = Math.min(1, Math.max(0, levelRef.current));
      else if (st === "thinking" || st === "transcribing") raw = 0.2;
      amp += (raw - amp) * (raw > amp ? 0.3 : 0.12);
      wrapRef.current?.style.setProperty("--vorb-amp", amp.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={wrapRef}
      className="vorb-wrapper pointer-events-none"
      style={{ width: size, height: size }}
    >
      <div className="vorb-circle" />
      <div className="vorb-letters">
        {BRAND.split("").map((c, i) => (
          <span key={i} className="vorb-letter">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}
