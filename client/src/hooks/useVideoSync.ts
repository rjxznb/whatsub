import { useEffect, useState, type RefObject } from "react";

/**
 * Returns the currently-playing subtitle index based on video.currentTime.
 */
export function useVideoSync(
  videoRef: RefObject<HTMLVideoElement | null>,
  cues: { time: number; endTime: number }[]
): number {
  const [currentIdx, setCurrentIdx] = useState(-1);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    let raf: number;
    const loop = () => {
      const t = v.currentTime;
      const idx = cues.findIndex((c) => t >= c.time && t < c.endTime);
      setCurrentIdx(idx);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, cues]);

  return currentIdx;
}
