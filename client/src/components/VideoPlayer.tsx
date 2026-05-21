import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Captions,
  CaptionsOff,
  Check,
  ChevronLeft,
  ChevronRight,
  PanelRight,
  PanelRightClose,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { formatTime } from "../utils/time";
import { CaptionOverlay } from "./CaptionOverlay";
import type { Subtitle } from "../llm/types";
import {
  DEFAULT_CAPTION_STYLE,
  type CaptionStyle,
  type Settings as AppSettings,
} from "../types/settings";

interface Props {
  src: string;
  /** Whether the right-side subtitle pane is currently shown. Used to render the
   *  toggle button's icon and tooltip. */
  panelOpen?: boolean;
  /** Called when the user clicks the subtitle pane toggle button. The parent
   *  owns the split layout. */
  onTogglePanel?: () => void;
  /** Subtitle whose [time, endTime] currently contains the playhead, or null. */
  currentSubtitle?: Subtitle | null;
  /** Whether the bilingual caption overlay is enabled. */
  showCaptions?: boolean;
  /** Called when the user toggles the caption overlay. */
  onToggleCaptions?: () => void;
  /** Resolved caption visual style. Drives CaptionOverlay rendering and the
   *  captions submenu's current-selection state. */
  captionStyle: CaptionStyle;
  /** Patch one or more caption-style Settings fields. Caller persists via
   *  useSettings().save(). */
  /** Patches caption-related Settings fields. Caption offset (offsetX/offsetY)
   *  is session-only and not persisted, but rides on this same channel — the
   *  caller (Player.tsx) routes the offset keys to local state. */
  onChangeCaptionStyle: (
    patch: Partial<AppSettings> & { captionOffsetX?: number; captionOffsetY?: number }
  ) => void;
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const CAPTION_COLOR_OPTIONS: { label: string; value: string }[] = [
  { label: "白色", value: "#FFFFFF" },
  { label: "黄色", value: "#FFEB3B" },
  { label: "青色", value: "#00BCD4" },
  { label: "绿色", value: "#4CAF50" },
  { label: "蓝色", value: "#2196F3" },
  { label: "品红色", value: "#E91E63" },
  { label: "红色", value: "#F44336" },
  { label: "黑色", value: "#000000" },
];

const FONT_SCALE_OPTIONS: { label: string; value: number }[] = [
  { label: "小 (75%)", value: 0.75 },
  { label: "中 (100%)", value: 1 },
  { label: "大 (125%)", value: 1.25 },
  { label: "特大 (150%)", value: 1.5 },
];

const FONT_OPACITY_OPTIONS: { label: string; value: number }[] = [
  { label: "25%", value: 0.25 },
  { label: "50%", value: 0.5 },
  { label: "75%", value: 0.75 },
  { label: "100%", value: 1 },
];

const BG_OPACITY_OPTIONS: { label: string; value: number }[] = [
  { label: "0%", value: 0 },
  { label: "25%", value: 0.25 },
  { label: "50%", value: 0.5 },
  { label: "75%", value: 0.75 },
  { label: "100%", value: 1 },
];

const HIGHLIGHT_OPTIONS: { label: string; value: boolean; testId: string }[] = [
  { label: "显示", value: true, testId: "highlights-on" },
  { label: "隐藏", value: false, testId: "highlights-off" },
];

function colorLabel(hex: string): string {
  const upper = hex.toUpperCase();
  return CAPTION_COLOR_OPTIONS.find((o) => o.value.toUpperCase() === upper)?.label ?? hex;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** Compositing pass for PiP: draws the bilingual caption onto the same
 *  canvas that holds the video frame. Visual approximation of CaptionOverlay
 *  (Tailwind DOM) but inside canvas — fonts smaller, no highlight spans,
 *  bg + text styles tracked. The native PiP window has no DOM, so all of
 *  this has to be 2d API. */
function drawCaptionOnCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  subtitle: { text: string; translation: string },
  style: CaptionStyle,
): void {
  if (!subtitle.text && !subtitle.translation) return;
  // Reference font size = 4% of video height × user's scale slider.
  const baseEn = Math.max(14, Math.round(height * 0.04 * style.fontScale));
  const baseZh = Math.max(12, Math.round(height * 0.032 * style.fontScale));
  const padX = Math.round(baseEn * 0.7);
  const padY = Math.round(baseEn * 0.45);
  const gap = Math.round(baseEn * 0.25);

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  // Measure both lines independently
  ctx.font = `600 ${baseEn}px sans-serif`;
  const enWidth = subtitle.text ? ctx.measureText(subtitle.text).width : 0;
  ctx.font = `400 ${baseZh}px sans-serif`;
  const zhWidth = subtitle.translation ? ctx.measureText(subtitle.translation).width : 0;

  const blockWidth = Math.min(width * 0.9, Math.max(enWidth, zhWidth) + padX * 2);
  const blockHeight = padY * 2 + baseEn + (subtitle.translation ? gap + baseZh : 0);
  const blockX = (width - blockWidth) / 2;
  const blockY = height - blockHeight - Math.round(height * 0.08);

  // Background (rounded rect approximation via fillRect when radius is 0,
  // otherwise use roundRect if supported by the canvas).
  if (style.bgOpacity > 0) {
    ctx.fillStyle = hexToRgba(style.bgColor, style.bgOpacity);
    const radius = Math.min(10, blockHeight / 4);
    const r = ctx as CanvasRenderingContext2D & {
      roundRect?: (x: number, y: number, w: number, h: number, radii: number) => void;
    };
    if (typeof r.roundRect === "function") {
      ctx.beginPath();
      r.roundRect(blockX, blockY, blockWidth, blockHeight, radius);
      ctx.fill();
    } else {
      ctx.fillRect(blockX, blockY, blockWidth, blockHeight);
    }
  }

  // Foreground text — fontColor + fontOpacity composed into rgba so the
  // overall layer respects the alpha.
  ctx.fillStyle = hexToRgba(style.fontColor, style.fontOpacity);
  const centerX = blockX + blockWidth / 2;

  if (subtitle.text) {
    ctx.font = `600 ${baseEn}px sans-serif`;
    ctx.fillText(subtitle.text, centerX, blockY + padY + baseEn);
  }
  if (subtitle.translation) {
    ctx.font = `400 ${baseZh}px sans-serif`;
    ctx.fillText(
      subtitle.translation,
      centerX,
      blockY + padY + baseEn + gap + baseZh,
    );
  }

  ctx.restore();
}

export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(function VideoPlayer(
  {
    src,
    panelOpen,
    onTogglePanel,
    currentSubtitle,
    showCaptions,
    onToggleCaptions,
    captionStyle,
    onChangeCaptionStyle,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  // PiP rig — canvas painted with video + subtitle, captureStream() → hidden
  // <video> for the actual PiP request. Native pip on the main <video>
  // wouldn't carry the subtitle overlay (PiP only renders the video element
  // itself, not DOM overlays), so we composite onto a canvas first.
  const pipCanvasRef = useRef<HTMLCanvasElement>(null);
  const pipVideoRef = useRef<HTMLVideoElement>(null);
  const pipStreamRef = useRef<MediaStream | null>(null);
  const [pipActive, setPipActive] = useState(false);
  // Static blurred-grayscale poster of the source video, shown over the main
  // <video> while PiP is active. Captured (via drawImage→toDataURL) once at
  // PiP entry, cleared at exit.
  const [pipPosterUrl, setPipPosterUrl] = useState<string | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  type MenuView =
    | "root"
    | "speed"
    | "captions"
    | "captions.fontColor"
    | "captions.fontScale"
    | "captions.fontOpacity"
    | "captions.highlights"
    | "captions.bgColor"
    | "captions.bgOpacity";
  const [menuView, setMenuView] = useState<MenuView | null>(null);
  const [showControls, setShowControls] = useState(true);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [seeking, setSeeking] = useState(false);
  // Hold ←/→ to engage 2x playback. While engaged, the boost overlay shows.
  const [boost2x, setBoost2x] = useState(false);

  // Refs for keyboard handlers — avoid stale closures.
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  const boostActiveRef = useRef(false);

  // Resolve the video element via either a function ref or our own internal use.
  const resolveVideo = useCallback((): HTMLVideoElement | null => {
    if (!ref) return null;
    if (typeof ref === "function") return null; // can't read from function ref
    return ref.current;
  }, [ref]);

  // Sync the hover-preview video's currentTime so it shows the frame at the
  // cursor position. Throttled to one update per animation frame so rapid
  // mousemove doesn't pile up seek requests faster than the decoder can serve.
  useEffect(() => {
    if (hoverTime === null) return;
    const pv = previewVideoRef.current;
    if (!pv) return;
    let cancelled = false;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        pv.currentTime = hoverTime;
      } catch {
        /* video not ready yet — next hover tick will retry */
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [hoverTime]);

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


  // Keyboard shortcuts (when player is mounted and focus is not in an input).
  useEffect(() => {
    const downHandler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          // Held key → OS sends repeated keydowns. First repeat activates 2x.
          if (e.repeat) {
            if (!boostActiveRef.current) {
              e.preventDefault();
              boostActiveRef.current = true;
              setBoost2x(true);
              const v = resolveVideo();
              if (v) v.playbackRate = 2;
            }
          } else {
            e.preventDefault();
            skip(e.key === "ArrowLeft" ? -5 : 5);
          }
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
      }
    };
    const upHandler = (e: KeyboardEvent) => {
      if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        boostActiveRef.current
      ) {
        boostActiveRef.current = false;
        setBoost2x(false);
        const v = resolveVideo();
        if (v) v.playbackRate = speedRef.current;
      }
    };
    // If the window loses focus while user is holding the key, restore speed —
    // otherwise keyup never fires and the player stays stuck at 2x.
    const blurHandler = () => {
      if (boostActiveRef.current) {
        boostActiveRef.current = false;
        setBoost2x(false);
        const v = resolveVideo();
        if (v) v.playbackRate = speedRef.current;
      }
    };
    window.addEventListener("keydown", downHandler);
    window.addEventListener("keyup", upHandler);
    window.addEventListener("blur", blurHandler);
    return () => {
      window.removeEventListener("keydown", downHandler);
      window.removeEventListener("keyup", upHandler);
      window.removeEventListener("blur", blurHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, volume, muted, ended]);

  // ---------- Picture-in-Picture rig ----------
  //
  // Paint loop: video frame → canvas, then bilingual caption text → canvas.
  // Runs only while pipActive. Cancelled on unmount or PiP exit. The captionStyle
  // / currentSubtitle deps drive a fresh paint loop after each style/cue change.
  useEffect(() => {
    if (!pipActive) return;
    const canvas = pipCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    const mainVid = resolveVideo();
    if (!canvas || !ctx || !mainVid) return;
    let raf = 0;
    const paint = () => {
      // Sync canvas size to source video's intrinsic resolution (lazy: only
      // on first paint when video metadata is ready).
      if (canvas.width !== mainVid.videoWidth || canvas.height !== mainVid.videoHeight) {
        if (mainVid.videoWidth > 0 && mainVid.videoHeight > 0) {
          canvas.width = mainVid.videoWidth;
          canvas.height = mainVid.videoHeight;
        }
      }
      try {
        ctx.drawImage(mainVid, 0, 0, canvas.width, canvas.height);
      } catch {
        /* drawImage can throw if source not yet ready — silently retry next frame */
      }
      if (showCaptions && currentSubtitle) {
        drawCaptionOnCanvas(ctx, canvas.width, canvas.height, currentSubtitle, captionStyle);
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [pipActive, currentSubtitle, captionStyle, showCaptions, resolveVideo]);

  // PiP teardown: when system PiP window closes (user hits the ✕ on the
  // floating window or another video takes over), sync our local state +
  // stop the captureStream.
  useEffect(() => {
    const pipVid = pipVideoRef.current;
    if (!pipVid) return;
    const onLeave = () => {
      setPipActive(false);
      setPipPosterUrl(null);
      pipStreamRef.current?.getTracks().forEach((t) => t.stop());
      pipStreamRef.current = null;
    };
    pipVid.addEventListener("leavepictureinpicture", onLeave);
    return () => pipVid.removeEventListener("leavepictureinpicture", onLeave);
  }, []);

  // Close the PiP window when the whatsub window closes — otherwise the
  // floating PiP can survive the source webview destruction on some
  // Chromium builds, leaving an orphaned floating frame.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: undefined | (() => void);
    win
      .onCloseRequested(() => {
        if (document.pictureInPictureElement) {
          document.exitPictureInPicture().catch(() => {});
        }
      })
      .then((u) => {
        unlisten = u;
      });
    const onUnload = () => {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      unlisten?.();
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  async function togglePip() {
    const mainVid = resolveVideo();
    const pipVid = pipVideoRef.current;
    const canvas = pipCanvasRef.current;
    if (!mainVid || !pipVid || !canvas) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }
      // Capture the current frame as the static "封面" overlay shown over
      // the main player while PiP runs. Done off a one-shot scratch canvas
      // (not pipCanvasRef which is locked to the captureStream).
      try {
        const poster = document.createElement("canvas");
        poster.width = mainVid.videoWidth || 1280;
        poster.height = mainVid.videoHeight || 720;
        const pctx = poster.getContext("2d");
        if (pctx) {
          pctx.drawImage(mainVid, 0, 0, poster.width, poster.height);
          setPipPosterUrl(poster.toDataURL("image/jpeg", 0.6));
        }
      } catch (err) {
        // toDataURL throws if the canvas is tainted (CORS). Skip the
        // poster overlay — PiP will still work, the user just won't see
        // the blurred backdrop. Better than blocking PiP entirely.
        console.warn("pip poster capture failed (canvas tainted?)", err);
        setPipPosterUrl(null);
      }
      // Seed canvas size — important: captureStream needs nonzero size.
      canvas.width = mainVid.videoWidth || 1280;
      canvas.height = mainVid.videoHeight || 720;
      // Prime the stream with one frame BEFORE requesting PiP — otherwise
      // captureStream emits no frames until the rAF paint loop catches up,
      // and the PiP window opens on a black canvas for the first ~50ms.
      const ctx = canvas.getContext("2d");
      if (ctx) {
        try {
          ctx.drawImage(mainVid, 0, 0, canvas.width, canvas.height);
        } catch { /* not ready — paint loop will retry */ }
      }
      const stream = canvas.captureStream(30);
      pipStreamRef.current = stream;
      pipVid.srcObject = stream;
      pipVid.muted = true;
      await pipVid.play();
      await pipVid.requestPictureInPicture();
      setPipActive(true);
    } catch (e) {
      console.error("pip toggle failed", e);
      setPipActive(false);
      setPipPosterUrl(null);
      pipStreamRef.current?.getTracks().forEach((t) => t.stop());
      pipStreamRef.current = null;
    }
  }

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

  function changeSpeed(s: number) {
    const v = resolveVideo();
    if (v) v.playbackRate = s;
    setSpeed(s);
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
        // CORS-anonymous load so the PiP rig's canvas.drawImage() on this
        // element doesn't taint the canvas → captureStream(30) returns
        // actual frames instead of black. Tauri 2 asset protocol sends
        // Access-Control-Allow-Origin: *, so CORS load succeeds.
        crossOrigin="anonymous"
        className="h-full w-full object-contain bg-black cursor-pointer"
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        onProgress={onProgress}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEndedEv}
        onClick={togglePlay}
      />
      {/* While PiP is active, hide the live video behind a blurred / grayscale
          freeze frame captured at the moment of toggle — the user wanted the
          source player to read as "已经送到画中画了" rather than show duplicate
          live video. */}
      {pipActive && pipPosterUrl && (
        <img
          src={pipPosterUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-contain bg-black pointer-events-none"
          style={{ filter: "blur(24px) grayscale(1)" }}
        />
      )}

      {/* Bilingual caption overlay — sits above where the controls render,
          stays visible regardless of control auto-hide. */}
      {showCaptions && (
        <CaptionOverlay
          subtitle={currentSubtitle ?? null}
          style={captionStyle}
          onPositionChange={(offsetX, offsetY) =>
            onChangeCaptionStyle({ captionOffsetX: offsetX, captionOffsetY: offsetY })
          }
        />
      )}

      {/* 2x boost indicator (top-center, while ←/→ held) */}
      {boost2x && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none z-20">
          <div className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 backdrop-blur-sm">
            <span className="text-white text-xs font-medium">2x</span>
            <span className="text-white/70 text-xs">▶▶</span>
          </div>
        </div>
      )}

      {/* Center play/replay button — interactive on hover */}
      {(!playing || ended) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            aria-label={ended ? "重播" : "播放"}
            title={ended ? "重播" : "播放"}
            className="pointer-events-auto rounded-full bg-black/40 p-5 backdrop-blur-sm text-white transition-all duration-150 hover:bg-black/60 hover:scale-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-white/40"
          >
            {ended ? (
              <RotateCcw className="h-10 w-10" />
            ) : (
              <Play className="h-10 w-10 fill-white" />
            )}
          </button>
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
          {/* Hover preview: thumbnail + time tooltip above the progress bar.
              The hidden <video> stays mounted (only displays when hoverTime
              is set) so we pay the metadata-load cost once, not per-hover. */}
          <div
            className="absolute -translate-x-1/2 pointer-events-none flex flex-col items-center gap-1"
            style={{
              left: `${hoverX}px`,
              bottom: "100%",
              marginBottom: "10px",
              display: hoverTime !== null ? "flex" : "none",
            }}
          >
            <div className="w-40 aspect-video rounded overflow-hidden border border-white/20 bg-black shadow-xl">
              <video
                ref={previewVideoRef}
                src={src}
                muted
                playsInline
                preload="auto"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="rounded bg-black/80 px-1.5 py-0.5 text-[10px] text-white tabular-nums">
              {hoverTime !== null ? formatTime(hoverTime) : ""}
            </div>
          </div>
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

          {/* Combined settings menu — speed + captions */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuView((v) => (v ? null : "root"))}
              title="播放速度 / 字幕设置"
              className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/20 transition-colors"
            >
              <Settings
                className={
                  "h-6 w-6 transition-transform duration-200 ease-out " +
                  (menuView !== null ? "rotate-[30deg]" : "rotate-0")
                }
              />
            </button>
            {speed !== 1 && menuView === null && (
              <span className="absolute top-0 right-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1 text-[9px] font-bold text-white pointer-events-none">
                {speed}x
              </span>
            )}

            {menuView !== null && (
              <>
                {/* Outside-click capture layer */}
                <div
                  data-testid="menu-outside-capture"
                  className="fixed inset-0 z-[5]"
                  onClick={() => setMenuView(null)}
                />

                <div
                  data-testid="gear-menu"
                  className="absolute bottom-full right-0 mb-2 w-[280px] max-h-[70vh] overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/30 backdrop-blur-2xl shadow-lg z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  {menuView === "root" && (
                    <div className="py-1">
                      <button
                        type="button"
                        data-testid="menu-row-speed"
                        onClick={() => setMenuView("speed")}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors"
                      >
                        <span>播放速度</span>
                        <span className="flex items-center gap-1 text-white/70">
                          <span>{speed === 1 ? "1x" : `${speed}x`}</span>
                          <ChevronRight className="h-4 w-4" />
                        </span>
                      </button>
                      <button
                        type="button"
                        data-testid="menu-row-captions"
                        onClick={() => setMenuView("captions")}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors"
                      >
                        <span>字幕设置</span>
                        <ChevronRight className="h-4 w-4 text-white/70" />
                      </button>
                    </div>
                  )}

                  {menuView === "speed" && (
                    <div data-testid="speed-submenu" className="py-1">
                      <button
                        type="button"
                        data-testid="menu-back"
                        onClick={() => setMenuView("root")}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors border-b border-white/10"
                      >
                        <ChevronLeft className="h-5 w-5" />
                        <span>播放速度</span>
                      </button>
                      {SPEED_OPTIONS.map((s) => {
                        const selected = s === speed;
                        return (
                          <button
                            key={s}
                            type="button"
                            data-testid={`speed-${s}`}
                            onClick={() => {
                              changeSpeed(s);
                              setMenuView(null);
                            }}
                            className="flex w-full items-center gap-3 px-4 py-2 text-base text-white hover:bg-white/10 transition-colors"
                          >
                            <span className="w-4 inline-flex justify-center">
                              {selected && <Check className="h-4 w-4" />}
                            </span>
                            <span>{s === 1 ? "Normal" : `${s}x`}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {menuView === "captions" && (
                    <div data-testid="captions-submenu" className="py-1">
                      <button
                        type="button"
                        data-testid="menu-back"
                        onClick={() => setMenuView("root")}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors border-b border-white/10"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span>字幕设置</span>
                      </button>

                      <button
                        type="button"
                        data-testid="captions-row-fontColor"
                        onClick={() => setMenuView("captions.fontColor")}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors"
                      >
                        <span>字体颜色</span>
                        <span className="flex items-center gap-1 text-white/60">
                          <span>{colorLabel(captionStyle.fontColor)}</span>
                          <ChevronRight className="h-4 w-4" />
                        </span>
                      </button>

                      <button
                        type="button"
                        data-testid="captions-row-fontScale"
                        onClick={() => setMenuView("captions.fontScale")}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors"
                      >
                        <span>字号</span>
                        <span className="flex items-center gap-1 text-white/60">
                          <span>{Math.round(captionStyle.fontScale * 100)}%</span>
                          <ChevronRight className="h-4 w-4" />
                        </span>
                      </button>

                      <button
                        type="button"
                        data-testid="captions-row-fontOpacity"
                        onClick={() => setMenuView("captions.fontOpacity")}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors"
                      >
                        <span>字体不透明度</span>
                        <span className="flex items-center gap-1 text-white/60">
                          <span>{Math.round(captionStyle.fontOpacity * 100)}%</span>
                          <ChevronRight className="h-4 w-4" />
                        </span>
                      </button>

                      <button
                        type="button"
                        data-testid="captions-row-highlights"
                        onClick={() => setMenuView("captions.highlights")}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors"
                      >
                        <span>重点高亮</span>
                        <span className="flex items-center gap-1 text-white/60">
                          <span>{captionStyle.highlightsEnabled ? "显示" : "隐藏"}</span>
                          <ChevronRight className="h-4 w-4" />
                        </span>
                      </button>

                      <button
                        type="button"
                        data-testid="captions-row-bgColor"
                        onClick={() => setMenuView("captions.bgColor")}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors"
                      >
                        <span>背景颜色</span>
                        <span className="flex items-center gap-1 text-white/60">
                          <span>{colorLabel(captionStyle.bgColor)}</span>
                          <ChevronRight className="h-4 w-4" />
                        </span>
                      </button>

                      <button
                        type="button"
                        data-testid="captions-row-bgOpacity"
                        onClick={() => setMenuView("captions.bgOpacity")}
                        className="flex w-full items-center justify-between px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors"
                      >
                        <span>背景不透明度</span>
                        <span className="flex items-center gap-1 text-white/60">
                          <span>{Math.round(captionStyle.bgOpacity * 100)}%</span>
                          <ChevronRight className="h-4 w-4" />
                        </span>
                      </button>

                      <div className="h-px bg-white/10 my-1" />

                      <button
                        type="button"
                        data-testid="reset-captions"
                        onClick={() =>
                          onChangeCaptionStyle({
                            captionFontColor: DEFAULT_CAPTION_STYLE.fontColor,
                            captionFontScale: DEFAULT_CAPTION_STYLE.fontScale,
                            captionFontOpacity: DEFAULT_CAPTION_STYLE.fontOpacity,
                            captionBackgroundColor: DEFAULT_CAPTION_STYLE.bgColor,
                            captionBackgroundOpacity: DEFAULT_CAPTION_STYLE.bgOpacity,
                            captionHighlightsEnabled: DEFAULT_CAPTION_STYLE.highlightsEnabled,
                          })
                        }
                        className="flex w-full items-center px-4 py-2.5 text-base text-white/80 hover:bg-white/10 transition-colors"
                      >
                        重置字幕设置
                      </button>
                    </div>
                  )}

                  {menuView === "captions.fontColor" && (
                    <div data-testid="captions-fontColor-submenu" className="py-1">
                      <button
                        type="button"
                        data-testid="menu-back"
                        onClick={() => setMenuView("captions")}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors border-b border-white/10"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span>字体颜色</span>
                      </button>
                      {CAPTION_COLOR_OPTIONS.map(({ label, value }) => {
                        const selected =
                          captionStyle.fontColor.toUpperCase() === value.toUpperCase();
                        return (
                          <button
                            key={value}
                            type="button"
                            data-testid={`font-color-${value}`}
                            onClick={() => {
                              onChangeCaptionStyle({ captionFontColor: value });
                            }}
                            className="flex w-full items-center gap-3 px-4 py-2 text-base text-white hover:bg-white/10 transition-colors"
                          >
                            <span className="w-4 inline-flex justify-center">
                              {selected && <Check className="h-4 w-4" />}
                            </span>
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {menuView === "captions.fontScale" && (
                    <div data-testid="captions-fontScale-submenu" className="py-1">
                      <button
                        type="button"
                        data-testid="menu-back"
                        onClick={() => setMenuView("captions")}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors border-b border-white/10"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span>字号</span>
                      </button>
                      {FONT_SCALE_OPTIONS.map(({ label, value }) => {
                        const selected = captionStyle.fontScale === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            data-testid={`font-scale-${value}`}
                            onClick={() => {
                              onChangeCaptionStyle({ captionFontScale: value });
                            }}
                            className="flex w-full items-center gap-3 px-4 py-2 text-base text-white hover:bg-white/10 transition-colors"
                          >
                            <span className="w-4 inline-flex justify-center">
                              {selected && <Check className="h-4 w-4" />}
                            </span>
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {menuView === "captions.fontOpacity" && (
                    <div data-testid="captions-fontOpacity-submenu" className="py-1">
                      <button
                        type="button"
                        data-testid="menu-back"
                        onClick={() => setMenuView("captions")}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors border-b border-white/10"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span>字体不透明度</span>
                      </button>
                      {FONT_OPACITY_OPTIONS.map(({ label, value }) => {
                        const selected =
                          Math.round(captionStyle.fontOpacity * 100) ===
                          Math.round(value * 100);
                        return (
                          <button
                            key={value}
                            type="button"
                            data-testid={`font-opacity-${value}`}
                            onClick={() => {
                              onChangeCaptionStyle({ captionFontOpacity: value });
                            }}
                            className="flex w-full items-center gap-3 px-4 py-2 text-base text-white hover:bg-white/10 transition-colors"
                          >
                            <span className="w-4 inline-flex justify-center">
                              {selected && <Check className="h-4 w-4" />}
                            </span>
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {menuView === "captions.highlights" && (
                    <div data-testid="captions-highlights-submenu" className="py-1">
                      <button
                        type="button"
                        data-testid="menu-back"
                        onClick={() => setMenuView("captions")}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors border-b border-white/10"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span>重点高亮</span>
                      </button>
                      {HIGHLIGHT_OPTIONS.map(({ label, value, testId }) => {
                        const selected = captionStyle.highlightsEnabled === value;
                        return (
                          <button
                            key={testId}
                            type="button"
                            data-testid={testId}
                            onClick={() => {
                              onChangeCaptionStyle({ captionHighlightsEnabled: value });
                            }}
                            className="flex w-full items-center gap-3 px-4 py-2 text-base text-white hover:bg-white/10 transition-colors"
                          >
                            <span className="w-4 inline-flex justify-center">
                              {selected && <Check className="h-4 w-4" />}
                            </span>
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {menuView === "captions.bgColor" && (
                    <div data-testid="captions-bgColor-submenu" className="py-1">
                      <button
                        type="button"
                        data-testid="menu-back"
                        onClick={() => setMenuView("captions")}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors border-b border-white/10"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span>背景颜色</span>
                      </button>
                      {CAPTION_COLOR_OPTIONS.map(({ label, value }) => {
                        const selected =
                          captionStyle.bgColor.toUpperCase() === value.toUpperCase();
                        return (
                          <button
                            key={value}
                            type="button"
                            data-testid={`bg-color-${value}`}
                            onClick={() => {
                              onChangeCaptionStyle({ captionBackgroundColor: value });
                            }}
                            className="flex w-full items-center gap-3 px-4 py-2 text-base text-white hover:bg-white/10 transition-colors"
                          >
                            <span className="w-4 inline-flex justify-center">
                              {selected && <Check className="h-4 w-4" />}
                            </span>
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {menuView === "captions.bgOpacity" && (
                    <div data-testid="captions-bgOpacity-submenu" className="py-1">
                      <button
                        type="button"
                        data-testid="menu-back"
                        onClick={() => setMenuView("captions")}
                        className="flex w-full items-center gap-2 px-4 py-2.5 text-base text-white hover:bg-white/10 transition-colors border-b border-white/10"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span>背景不透明度</span>
                      </button>
                      {BG_OPACITY_OPTIONS.map(({ label, value }) => {
                        const selected =
                          Math.round(captionStyle.bgOpacity * 100) ===
                          Math.round(value * 100);
                        return (
                          <button
                            key={value}
                            type="button"
                            data-testid={`bg-opacity-${value}`}
                            onClick={() => {
                              onChangeCaptionStyle({ captionBackgroundOpacity: value });
                            }}
                            className="flex w-full items-center gap-3 px-4 py-2 text-base text-white hover:bg-white/10 transition-colors"
                          >
                            <span className="w-4 inline-flex justify-center">
                              {selected && <Check className="h-4 w-4" />}
                            </span>
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Picture-in-Picture toggle */}
          <button
            type="button"
            onClick={() => void togglePip()}
            title={pipActive ? "退出画中画" : "画中画 (字幕同步显示)"}
            className={
              "flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors " +
              (pipActive ? "bg-white/15 hover:bg-white/25" : "hover:bg-white/20")
            }
          >
            <PictureInPicture2 className="h-6 w-6" />
          </button>

          {/* Toggle bilingual caption overlay */}
          {onToggleCaptions && (
            <button
              type="button"
              onClick={onToggleCaptions}
              title={showCaptions ? "关闭字幕叠加" : "在视频下方显示中英文字幕"}
              className={
                "flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors " +
                (showCaptions ? "bg-white/15 hover:bg-white/25" : "hover:bg-white/20")
              }
            >
              {showCaptions ? (
                <Captions className="h-6 w-6" />
              ) : (
                <CaptionsOff className="h-6 w-6" />
              )}
            </button>
          )}

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

        </div>
      </div>

      {/* PiP rig — kept off-screen but in DOM. Chromium refuses to PiP a
          display:none video, so we position them off-screen at 1×1 px. */}
      <canvas
        ref={pipCanvasRef}
        width={1}
        height={1}
        className="absolute pointer-events-none opacity-0"
        style={{ left: -9999, top: -9999, width: 1, height: 1 }}
      />
      <video
        ref={pipVideoRef}
        muted
        playsInline
        className="absolute pointer-events-none opacity-0"
        style={{ left: -9999, top: -9999, width: 1, height: 1 }}
      />
    </div>
  );
});

VideoPlayer.displayName = "VideoPlayer";
