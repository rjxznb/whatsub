import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Maximize,
  Minimize,
  PanelRight,
  PanelRightClose,
  Pause,
  Play,
  RotateCcw,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { formatTime } from "../utils/time";

interface Props {
  src: string;
  /** Whether the right-side subtitle pane is currently shown. Used to render the
   *  toggle button's icon and tooltip. */
  panelOpen?: boolean;
  /** Called when the user clicks the subtitle pane toggle button. The parent
   *  owns the split layout. */
  onTogglePanel?: () => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(function VideoPlayer(
  { src, panelOpen, onTogglePanel },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Resolve the video element via either a function ref or our own internal use.
  const resolveVideo = useCallback((): HTMLVideoElement | null => {
    if (!ref) return null;
    if (typeof ref === "function") return null; // can't read from function ref
    return ref.current;
  }, [ref]);

  // Auto-hide controls 3s after last mouse move while playing.
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (playing) {
      hideTimerRef.current = setTimeout(() => setShowControls(false), 3000);
    }
  }, [playing]);

  useEffect(() => {
    if (!playing) {
      setShowControls(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    } else {
      resetHideTimer();
    }
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [playing, resetHideTimer]);

  // Sync Tauri window fullscreen state on mount + when user uses keyboard F11/etc.
  useEffect(() => {
    const win = getCurrentWindow();
    win.isFullscreen().then(setIsFullscreen).catch(() => {});
    const unlistenP = win.onResized(() => {
      win.isFullscreen().then(setIsFullscreen).catch(() => {});
    });
    return () => {
      unlistenP.then((u) => u()).catch(() => {});
    };
  }, []);

  // Keyboard shortcuts (when player is mounted and focus is not in an input).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(5);
          break;
        case "ArrowUp":
          e.preventDefault();
          adjustVolume(0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          adjustVolume(-0.1);
          break;
        case "m":
          e.preventDefault();
          toggleMute();
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, volume, muted, ended]);

  function togglePlay() {
    const v = resolveVideo();
    if (!v) return;
    if (ended) {
      v.currentTime = 0;
      setEnded(false);
    }
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  function skip(delta: number) {
    const v = resolveVideo();
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta));
  }

  function adjustVolume(delta: number) {
    const v = resolveVideo();
    if (!v) return;
    const next = Math.max(0, Math.min(1, volume + delta));
    v.volume = next;
    setVolume(next);
    if (next > 0 && muted) {
      v.muted = false;
      setMuted(false);
    }
  }

  function toggleMute() {
    const v = resolveVideo();
    if (!v) return;
    v.muted = !muted;
    setMuted(!muted);
  }

  async function toggleFullscreen() {
    const win = getCurrentWindow();
    const next = !isFullscreen;
    await win.setFullscreen(next);
    setIsFullscreen(next);
  }

  function changeSpeed(s: number) {
    const v = resolveVideo();
    if (v) v.playbackRate = s;
    setSpeed(s);
    setShowSpeed(false);
  }

  function handleVolumeInput(e: React.ChangeEvent<HTMLInputElement>) {
    const v = resolveVideo();
    const next = parseFloat(e.target.value);
    setVolume(next);
    if (v) {
      v.volume = next;
      if (next > 0 && muted) {
        v.muted = false;
        setMuted(false);
      }
    }
  }

  // Progress bar interactions
  function calcSeekTime(clientX: number): number {
    if (!progressRef.current) return 0;
    const rect = progressRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  function handleProgressDown(e: ReactMouseEvent) {
    e.preventDefault();
    setSeeking(true);
    setEnded(false);
    const v = resolveVideo();
    const t = calcSeekTime(e.clientX);
    if (v) v.currentTime = t;
    setCurrentTime(t);
    const onMove = (ev: MouseEvent) => {
      const t2 = calcSeekTime(ev.clientX);
      if (v) v.currentTime = t2;
      setCurrentTime(t2);
    };
    const onUp = () => {
      setSeeking(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleProgressHover(e: ReactMouseEvent) {
    setHoverTime(calcSeekTime(e.clientX));
    if (progressRef.current) {
      const rect = progressRef.current.getBoundingClientRect();
      setHoverX(e.clientX - rect.left);
    }
  }

  // Video element callbacks
  function onTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>) {
    if (seeking) return;
    setCurrentTime(e.currentTarget.currentTime);
  }
  function onLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    setDuration(e.currentTarget.duration);
  }
  function onProgress(e: React.SyntheticEvent<HTMLVideoElement>) {
    const v = e.currentTarget;
    if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
  }
  function onPlay() {
    setPlaying(true);
    setEnded(false);
  }
  function onPause() {
    setPlaying(false);
  }
  function onEndedEv() {
    setPlaying(false);
    setEnded(true);
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className="group relative h-full w-full bg-black overflow-hidden select-none"
      onMouseMove={resetHideTimer}
      onMouseLeave={() => {
        if (playing) setShowControls(false);
      }}
    >
      <video
        ref={ref}
        src={src}
        className="h-full w-full object-contain bg-black cursor-pointer"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        onProgress={onProgress}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEndedEv}
        onClick={togglePlay}
      />

      {/* Center play/replay overlay when paused or ended */}
      {(!playing || ended) && (
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          aria-hidden
        >
          <div className="rounded-full bg-black/40 p-5 backdrop-blur-sm">
            {ended ? (
              <RotateCcw className="h-10 w-10 text-white" />
            ) : (
              <Play className="h-10 w-10 text-white fill-white" />
            )}
          </div>
        </div>
      )}

      {/* Bottom controls — gradient overlay, auto-hide while playing */}
      <div
        className={
          "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent pt-10 transition-opacity duration-300 " +
          (showControls || !playing ? "opacity-100" : "opacity-0 pointer-events-none")
        }
      >
        {/* Progress bar */}
        <div
          ref={progressRef}
          className="group/progress relative mx-3 mb-1 h-1.5 cursor-pointer rounded-full bg-white/20 transition-all hover:h-2.5 before:absolute before:-top-3 before:-bottom-3 before:left-0 before:right-0 before:content-['']"
          onMouseDown={handleProgressDown}
          onMouseMove={handleProgressHover}
          onMouseLeave={() => setHoverTime(null)}
        >
          <div
            className="absolute top-0 left-0 h-full rounded-full bg-white/30"
            style={{ width: `${bufferedPct}%` }}
          />
          <div
            className="absolute top-0 left-0 h-full rounded-full bg-blue-400"
            style={{ width: `${progressPct}%` }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-blue-400 opacity-0 group-hover/progress:opacity-100 transition-opacity shadow"
            style={{ left: `calc(${progressPct}% - 6px)` }}
          />
          {hoverTime !== null && (
            <div
              className="absolute -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-[10px] text-white pointer-events-none"
              style={{ left: `${hoverX}px`, bottom: "100%", marginBottom: "6px" }}
            >
              {formatTime(hoverTime)}
            </div>
          )}
        </div>

        {/* Controls row */}
        <div className="flex items-center px-1 pb-2 pt-1">
          {/* Play / Pause */}
          <button
            type="button"
            onClick={togglePlay}
            title={playing ? "暂停 (空格)" : "播放 (空格)"}
            className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/20 transition-colors"
          >
            {ended ? (
              <RotateCcw className="h-6 w-6" />
            ) : playing ? (
              <Pause className="h-6 w-6 fill-white" />
            ) : (
              <Play className="h-6 w-6 fill-white" />
            )}
          </button>

          {/* Volume — hover-expand slider */}
          <div className="group/vol flex h-10 items-center rounded-full hover:bg-white/15 transition-colors">
            <button
              type="button"
              onClick={toggleMute}
              title={muted ? "取消静音 (M)" : "静音 (M)"}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white"
            >
              {muted || volume === 0 ? (
                <VolumeX className="h-6 w-6" />
              ) : (
                <Volume2 className="h-6 w-6" />
              )}
            </button>
            <div className="overflow-hidden w-0 group-hover/vol:w-20 transition-all duration-200">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={handleVolumeInput}
                className="mr-3 h-1 w-[68px] cursor-pointer appearance-none rounded-full bg-white/30 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
              />
            </div>
          </div>

          {/* Time */}
          <span className="rounded-full px-3 py-1.5 text-sm text-white font-medium tabular-nums hover:bg-white/15 transition-colors cursor-default">
            {formatTime(currentTime)}{" "}
            <span className="text-white/60">/</span> {formatTime(duration)}
          </span>

          <div className="flex-1" />

          {/* Speed */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSpeed((v) => !v)}
              title="播放速度"
              className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/20 transition-colors"
            >
              <Settings className="h-6 w-6" />
            </button>
            {speed !== 1 && (
              <span className="absolute top-0 right-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1 text-[9px] font-bold text-white pointer-events-none">
                {speed}x
              </span>
            )}
            {showSpeed && (
              <div className="absolute bottom-full right-0 mb-2 overflow-hidden rounded-lg border border-white/10 bg-black/90 py-1 backdrop-blur shadow-lg z-10 min-w-[110px]">
                {SPEED_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => changeSpeed(s)}
                    className={
                      "block w-full px-4 py-1.5 text-left text-xs transition-colors " +
                      (s === speed
                        ? "text-blue-400 font-semibold"
                        : "text-white/80 hover:bg-white/10")
                    }
                  >
                    {s === 1 ? "Normal" : `${s}x`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Toggle subtitle pane (only if parent provided handler) */}
          {onTogglePanel && (
            <button
              type="button"
              onClick={onTogglePanel}
              title={panelOpen ? "隐藏字幕栏" : "展开字幕栏"}
              className={
                "flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors " +
                (panelOpen ? "hover:bg-white/20" : "bg-white/15 hover:bg-white/25")
              }
            >
              {panelOpen ? (
                <PanelRightClose className="h-6 w-6" />
              ) : (
                <PanelRight className="h-6 w-6" />
              )}
            </button>
          )}

          {/* Fullscreen */}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? "退出全屏 (F)" : "全屏 (F)"}
            className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/20 transition-colors"
          >
            {isFullscreen ? (
              <Minimize className="h-6 w-6" />
            ) : (
              <Maximize className="h-6 w-6" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
});

VideoPlayer.displayName = "VideoPlayer";
