import { forwardRef, useState } from "react";
import { formatTime } from "../utils/time";

interface Props {
  src: string;
}

export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(({ src }, ref) => {
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  function togglePlay() {
    if (!ref || typeof ref === "function") return;
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }

  function seek(t: number) {
    if (!ref || typeof ref === "function") return;
    if (ref.current) ref.current.currentTime = t;
  }

  return (
    <div className="flex flex-col bg-black h-full">
      <video
        ref={ref}
        src={src}
        className="flex-1 w-full bg-black"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="flex items-center gap-3 px-3 py-2 bg-zinc-950 border-t border-zinc-800">
        <button
          onClick={togglePlay}
          className="w-7 h-7 rounded-full bg-blue-500 text-black text-xs flex items-center justify-center"
        >
          {playing ? "⏸" : "▶"}
        </button>
        <span className="text-zinc-500 text-[10px] w-10">{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={currentTime}
          onChange={(e) => seek(parseFloat(e.target.value))}
          className="flex-1 accent-blue-400"
        />
        <span className="text-zinc-500 text-[10px] w-10 text-right">{formatTime(duration)}</span>
      </div>
    </div>
  );
});

VideoPlayer.displayName = "VideoPlayer";
