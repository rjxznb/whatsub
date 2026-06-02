// src/components/voice/VoiceBars.tsx
//
// Waveform bars icon (adapted from Enghub's VoiceBars). Idle = static irregular
// bars; recording = bars react to the mic `volume` (0..1). Colour is inherited
// (bg-current) so the button decides idle/accent colour.

const IDLE_HEIGHTS = [5, 11, 7, 12, 6]; // px, compact for a 32px button

interface Props {
  /** 0..1 mic level while recording; omit for the idle static look. */
  volume?: number;
  className?: string;
}

export function VoiceBars({ volume, className }: Props) {
  const recording = volume !== undefined;
  return (
    <div className={"flex h-4 items-center justify-center gap-[2px] " + (className ?? "")}>
      {IDLE_HEIGHTS.map((h, i) => {
        const height = recording
          ? 3 + Math.max(0, (volume ?? 0) * 10 * (0.5 + Math.sin(i * 1.8) * 0.5 + 0.3))
          : h;
        return (
          <span
            key={i}
            className="w-[2px] rounded-full bg-current transition-[height] duration-75"
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}
