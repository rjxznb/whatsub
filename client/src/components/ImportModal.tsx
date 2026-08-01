import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog, notify } from "../store/appDialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../store/settings";
import { useLibrary } from "../store/library";
import { useAnalysis } from "../store/analysis";
import { getTier } from "../llm/modelTiers";
import { cancelImportAndInvalidateAnalysis } from "../llm/analysisPersistence";
import type { WhisperModelSize } from "../types/settings";
import { friendlyError, siteKeyForUrl, loginAction } from "../utils/friendlyError";
import type { SiteLoginAction } from "../utils/friendlyError";
import type { TranslationStyle } from "../types/settings";
import { cookieStatusFor } from "../lib/cookieStatus";
import { SiteLoginModal } from "./SiteLoginModal";
import {
  preflightManagedQuota,
  quotaRecoveryMessage,
  SETTINGS_LLM_LINK,
  type QuotaExhaustedDetails,
} from "../llm/quotaRecovery";

export function shouldPromptLogin(
  cookieSource: string | undefined,
  status: { exists: boolean; expired: boolean } | null,
): boolean {
  return cookieSource === "in-app" && !!status && status.exists && status.expired;
}

// One-click sample URL offered during onboarding as ghost-text
// (placeholder) + a Tab-to-fill affordance inside the URL input, for
// first-time users who land in the modal without a video in mind.
// "Me at the zoo" — first ever YouTube upload (April 2005), 18 seconds,
// English narration with auto-captions, will never be removed.
const SAMPLE_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

// Slider positions, left → right. Anything outside this trio is a legacy
// entry style that the slider snaps to the nearest position via sliderIdx.
const STYLE_SLIDER_ORDER: TranslationStyle[] = ["formal", "neutral", "colloquial"];
const STYLE_LABEL: Record<"formal" | "neutral" | "colloquial", string> = {
  formal: "正式",
  neutral: "中性",
  colloquial: "口语",
};
function sliderIdx(style: TranslationStyle): number {
  if (style === "formal" || style === "literary") return 0;
  if (style === "colloquial" || style === "playful") return 2;
  return 1;
}

interface Props {
  onClose: () => void;
  /** Pre-fill the local-file path; switches the modal to the "本地文件" tab.
   *  Used when a file is dropped onto the window. */
  initialFilePath?: string;
  /** Show the "试试示例" sample-link hint. Only true during the onboarding tour
   *  (first-time users) — hidden in normal use to keep the card clean. */
  showSampleLink?: boolean;
}

type PipelineEventPayload =
  | { stage: "Started"; video_id: string; source_kind?: string; source_value?: string; background?: boolean }
  | { stage: "Waiting"; video_id: string; resource: "download" | "compute" }
  | { stage: "Preparing"; video_id: string; step: string }
  | { stage: "Downloading"; video_id: string; percent: number; total?: string; speed?: string; eta?: string }
  | { stage: "Retrying"; video_id: string; attempt: number; delay_sec: number; message: string }
  | { stage: "ExtractingAudio"; video_id: string }
  | { stage: "Transcribing"; video_id: string; percent: number }
  | { stage: "Transcribed"; video_id: string; srt_path: string; duration_sec: number }
  | { stage: "Failed"; video_id: string; error: string }
  | { stage: "ModelDownload"; progress: number; total_mb: number; downloaded_mb: number }
  | { stage: "Log"; video_id: string; source: string; line: string };

interface ImportPreflight {
  videoId: string;
  state: "missing" | "existing" | "running";
  title?: string;
}

/**
 * Sub-step labels for the "准备中" phase. Keys must match the
 * `step` field on the Rust `PipelineEvent::Preparing` event
 * (emitted by ytdlp.rs's stderr scanner). Unknown step → fall back
 * to the bare "准备中" label, so adding new steps in Rust without
 * matching TS is safe.
 */
const PREPARING_SUBSTEP_LABEL: Record<string, string> = {
  "fetching-webpage": "获取视频信息",
  "fetching-player": "获取播放器",
  "solving-signature": "解算签名 (这一步常常最慢)",
  "fetching-manifest": "获取清晰度列表",
  "format-selected": "格式已选,即将下载",
};

interface LogLine {
  source: string;
  text: string;
  /** Monotonic per-mount counter — guaranteed unique even when multiple
   *  log events fire in the same millisecond with the same text (which
   *  ffmpeg routinely does, e.g. emitting "Metadata:" and
   *  "handler_name    : ISO Media file produced by Google Inc." many
   *  times during a single mp4 mux). Previously we used
   *  `Date.now() + text` which broke React's key uniqueness contract. */
  id: number;
}
const LOG_BUFFER_SIZE = 80;

type Phase =
  | "idle"
  | "started"
  | "waiting_download"
  | "downloading"
  | "extracting"
  | "waiting_compute"
  | "transcribing"
  | "done"
  | "error";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  started: "准备中",
  waiting_download: "等待下载…",
  downloading: "下载视频",
  extracting: "抽取音频",
  waiting_compute: "等待转录…",
  transcribing: "本地转录",
  done: "完成，跳转到播放页",
  error: "失败",
};

// Per-whisper-tier rough estimates for transcribing 10 min of video on a
// machine with GPU acceleration (Vulkan / Metal). CPU-only is ~3-5x slower.
const TRANSCRIBE_ETA_PER_TIER: Record<WhisperModelSize, string> = {
  tiny: "约 10-30 秒",
  base: "约 30 秒-1 分钟",
  small: "约 1-3 分钟",
  medium: "约 3-8 分钟",
  "large-v3": "约 8-15 分钟",
};

function transcribeDuration(size: WhisperModelSize): string {
  const tier = getTier(size);
  const eta = TRANSCRIBE_ETA_PER_TIER[size] ?? "约 1-3 分钟";
  const tierName = tier?.name ?? size;
  return `${eta} / 10 分钟视频（${tierName}）`;
}

function phaseDuration(phase: Phase, whisperModel: WhisperModelSize): string {
  switch (phase) {
    case "started":      return "约 5-30 秒";
    case "waiting_download": return "等待空闲下载任务";
    case "downloading":  return "随网速：几秒到几分钟";
    case "extracting":   return "约 1-5 秒";
    case "waiting_compute": return "等待空闲转录任务";
    case "transcribing": return transcribeDuration(whisperModel);
    case "done":         return "立即";
    default:             return "";
  }
}

export function ImportModal({ onClose, initialFilePath, showSampleLink }: Props) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { reload } = useLibrary();
  const { startFor } = useAnalysis();

  const [tab, setTab] = useState<"local" | "url">(initialFilePath ? "local" : "url");
  const [urlValue, setUrlValue] = useState("");
  const [filePath, setFilePath] = useState(initialFilePath ?? "");
  const [expiredPrompt, setExpiredPrompt] = useState<SiteLoginAction | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  useEffect(() => {
    const siteKey = siteKeyForUrl(urlValue);
    if (!siteKey) { setExpiredPrompt(null); return; }
    const cookieSource = useSettings.getState().settings.cookieSource;
    if (cookieSource !== "in-app") { setExpiredPrompt(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      void cookieStatusFor(siteKey).then((s) => {
        if (cancelled) return;
        setExpiredPrompt(
          shouldPromptLogin(cookieSource, s)
            ? (loginAction(siteKey) ?? null)
            : null,
        );
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [urlValue]);
  // Inline validation message shown directly under the URL input /
  // file picker when the user clicks 开始解析 / 后台下载 with no
  // source filled in. Kept SEPARATE from `error` (which is reserved
  // for real download failures and auto-opens the 排查清单 dialog);
  // we don't want an empty-input click to open the VPN/cookies
  // troubleshooter — that would be misleading.
  const [validationError, setValidationError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  // yt-dlp quality preset: "low" (480p) / "standard" (720p) / "high" (1080p)
  // / "best" (no cap). 720p default — subtitle learning doesn't benefit from
  // 1080p+ and 720p downloads in 1/3 the time on most connections.
  const [quality, setQuality] = useState<"low" | "standard" | "high" | "best">("standard");
  // Translation register for AI analysis. Default 中性 — the natural
  // middle of the slider; user can drag toward 正式 or 口语 per import.
  // Persists onto the library entry's analysisStyle so the Player picks
  // it up at analysis time. (Legacy entries without analysisStyle still
  // fall back to "colloquial" via the buildSystemPrompt default.)
  const [analysisStyle, setAnalysisStyle] = useState<TranslationStyle>("neutral");
  // Continuous 0-100 drag position, decoupled from the committed style.
  // With native range step=1 on a 0-100 axis the thumb moves pixel-by-
  // pixel (smooth feel) — we then snap to the nearest of 3 anchors
  // (0/50/100) on pointerup so the saved style stays discrete. Without
  // this we used min=0 max=2 step=1 and the thumb hopped 1/3 of the
  // track per pixel of cursor motion → felt jerky.
  const [dragPercent, setDragPercent] = useState<number>(() => sliderIdx(analysisStyle) * 50);
  const previewIdx: 0 | 1 | 2 = dragPercent < 25 ? 0 : dragPercent > 75 ? 2 : 1;
  function commitStyle(idx: number) {
    const clamped = Math.max(0, Math.min(2, idx)) as 0 | 1 | 2;
    setDragPercent(clamped * 50);
    setAnalysisStyle(STYLE_SLIDER_ORDER[clamped]);
  }
  const [submitting, setSubmitting] = useState(false);
  // React state does not update synchronously, so it cannot stop two clicks
  // in the same event turn from opening duplicate confirmation dialogs or
  // starting two destructive replacements. This ref is the synchronous gate.
  const submitGateRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaBlock, setQuotaBlock] = useState<QuotaExhaustedDetails | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  // Diagnosed-error dialog. Deterministic failures get one focused action
  // (login, retry, or background retry); only genuinely unknown failures fall
  // back to the broader checklist. Raw stderr remains available underneath.
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  // Track the last error we auto-opened the dialog for so the dialog
  // doesn't re-pop every render — only when a NEW error appears. If
  // the user closes the dialog and the error hasn't changed, we
  // respect their dismiss.
  const lastShownErrorRef = useRef<string | null>(null);

  // ── In-modal site-login state ──────────────────────────────────────
  //
  // When the error checklist's "立即登录 X" button fires we DON'T
  // navigate the user away to Settings — that breaks their mental
  // context ("why am I on the settings page now?"). Instead we keep
  // ImportModal open and swap its view for a focused "等待保存"
  // panel: explanation + 保存 / 取消 buttons. Once cookies land
  // (site-login-success event), we auto-retry the original import
  // so the user gets a one-click path from "failed" → "logged in" →
  // "succeeded" without leaving the modal.
  const [pendingLogin, setPendingLogin] = useState<{
    key: string;
    label: string;
  } | null>(null);
  const [savingLogin, setSavingLogin] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const retryAfterLoginRef = useRef(false);

  async function beginSiteLogin(action: SiteLoginAction) {
    setLoginError(null);
    try {
      await invoke("site_login_start", {
        args: {
          key: action.siteKey,
          label: action.siteLabel,
          loginUrl: action.loginUrl,
          harvestDomains: action.harvestDomains,
        },
      });
      retryAfterLoginRef.current = true;
      setShowErrorDialog(false);
      setPendingLogin({ key: action.siteKey, label: action.siteLabel });
    } catch (e) {
      // Automatic launch failed: fall back to the focused error dialog so the
      // user still has context and can explicitly retry opening the browser.
      setShowErrorDialog(true);
      void notify(`登录窗口启动失败：${e}`);
    }
  }

  useEffect(() => {
    if (!error) {
      lastShownErrorRef.current = null;
      return;
    }
    if (error === lastShownErrorRef.current) return;

    lastShownErrorRef.current = error;
    console.error("[whatsub import error]", error);
    setShowErrorDialog(true);
  }, [error]);

  // submit() is defined further down + captures form state via closure;
  // we ref it so the site-login-success listener (mounted once with
  // [] deps) always invokes the LATEST version, not a stale snapshot
  // from the first render.
  const submitRef = useRef<() => Promise<void>>(async () => {});
  const retryImportOptionsRef = useRef<{
    background?: boolean;
    overwriteAuthorized?: boolean;
  }>({});

  function restoreDiagnosisAfterLoginCancel() {
    retryAfterLoginRef.current = false;
    setPendingLogin(null);
    setSavingLogin(false);
    setLoginError(null);
    setSubmitting(false);
    setShowErrorDialog(true);
  }

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let disposed = false;
    void Promise.all([
      listen("site-login-success", () => {
        if (!retryAfterLoginRef.current) return;
        retryAfterLoginRef.current = false;
        setPendingLogin(null);
        setSavingLogin(false);
        setLoginError(null);
        setError(null);
        // Auto-retry the original import. Cookies are now in the jar
        // so yt-dlp will pick them up on the next invocation.
        void submitRef.current();
      }).then((un) => {
        if (disposed) un();
        else unlistens.push(un);
      }),
      listen("site-login-cancelled", () => {
        if (!retryAfterLoginRef.current) return;
        restoreDiagnosisAfterLoginCancel();
      }).then((un) => {
        if (disposed) un();
        else unlistens.push(un);
      }),
    ]);
    return () => {
      disposed = true;
      retryAfterLoginRef.current = false;
      unlistens.forEach((u) => u());
    };
  }, []);

  async function finishLogin() {
    setLoginError(null);
    setSavingLogin(true);
    try {
      await invoke("site_login_finish");
      // success event will fire → handlers above clear state + retry
    } catch (e) {
      setLoginError(String(e));
      setSavingLogin(false);
    }
  }

  async function cancelLoginInModal() {
    restoreDiagnosisAfterLoginCancel();
    try {
      await invoke("site_login_cancel");
    } catch {
      // ignore — even if cancel fails, we still want to clear UI state
    }
  }

  // Esc dismisses overlays in priority order: error dialog → close modal.
  // Closing the modal during an in-flight foreground import ALSO cancels
  // the backing Rust task (kills yt-dlp/ffmpeg/whisper, cleans partial
  // files) — without this the download silently continued in the
  // background after Esc, surfacing a "phantom" library entry minutes
  // later.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showErrorDialog) {
        setShowErrorDialog(false);
      } else {
        void (async () => {
          if (await cancelInFlight()) onClose();
        })();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showErrorDialog, onClose]);

  const [percent, setPercent] = useState<number>(0);
  // Fine-grained sub-step within "准备中". Cleared on each phase change.
  const [preparingStep, setPreparingStep] = useState<string | null>(null);
  // Download-only metrics from yt-dlp's progress template; null when unknown
  // (e.g. before yt-dlp has resolved size, or during non-download phases).
  const [dlSpeed, setDlSpeed] = useState<string | null>(null);
  const [dlEta, setDlEta] = useState<string | null>(null);
  const [dlTotal, setDlTotal] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  // video_id of the in-flight import. Captured from the Started event so
  // we can call cancel_import on Esc / ✕ / 取消 — Rust computes the id
  // (sha256/youtube id/url hash) and we don't replicate that logic JS-side.
  const currentVideoIdRef = useRef<string | null>(null);
  const videoIdWaiterRef = useRef<((id: string) => void) | null>(null);
  const pipelineListenerReadyRef = useRef<Promise<void> | null>(null);
  const foregroundImportActiveRef = useRef(false);
  const cancelPromiseRef = useRef<Promise<boolean> | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  function waitForCurrentVideoId(): Promise<string | null> {
    if (currentVideoIdRef.current) return Promise.resolve(currentVideoIdRef.current);
    return new Promise((resolve) => {
      const finish = (id: string | null) => {
        if (videoIdWaiterRef.current === onVideoId) {
          videoIdWaiterRef.current = null;
        }
        clearTimeout(timeoutId);
        resolve(id);
      };
      const onVideoId = (id: string) => finish(id);
      const timeoutId = window.setTimeout(() => finish(null), 3_000);
      videoIdWaiterRef.current = onVideoId;
    });
  }

  function cancelInFlight(): Promise<boolean> {
    if (cancelPromiseRef.current) return cancelPromiseRef.current;

    const promise = (async () => {
      setCanceling(true);
      setCancelError(null);
      try {
        const id = await waitForCurrentVideoId();
        if (!id) {
          throw new Error("尚未取得任务编号，请稍候再试");
        }
        await cancelImportAndInvalidateAnalysis(id);
        currentVideoIdRef.current = null;
        foregroundImportActiveRef.current = false;
        return true;
      } catch (e) {
        console.warn("cancel_import failed", e);
        setCancelError(`停止失败：${String(e)}`);
        return false;
      } finally {
        setCanceling(false);
        cancelPromiseRef.current = null;
      }
    })();
    cancelPromiseRef.current = promise;
    return promise;
  }
  // Monotonic id source for log lines. Increments on every push so
  // simultaneous log events get distinct React keys.
  const logIdRef = useRef(0);
  // Default to OPEN — too many users report "no logs visible" without
  // realising the panel was collapsed. They can still flip it closed.
  // The trade-off: a bit more vertical real estate during normal imports.
  const [showLog, setShowLog] = useState(true);

  // Register once on mount, before any import can be invoked. submit() awaits
  // this readiness promise so one-shot Started/Waiting events cannot land in
  // the gap between setSubmitting(true) and React running an effect.
  useLayoutEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    let markReady!: () => void;
    pipelineListenerReadyRef.current = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    void listen<PipelineEventPayload>("pipeline-event", (e) => {
      if (!foregroundImportActiveRef.current) return;
      const ev = e.payload;
      // submit() awaits listener readiness before invoking Rust, so the
      // foreground Started event is the authoritative task binding. Once
      // bound, ignore events from concurrent background imports; otherwise a
      // background retry could overwrite this modal and make ✕ cancel the
      // wrong task. Pre-bind events may still update visual state for backward
      // compatibility, but never claim the cancellation id.
      if (ev.stage === "Started") {
        if (ev.background) return;
        if (currentVideoIdRef.current && currentVideoIdRef.current !== ev.video_id) return;
        currentVideoIdRef.current = ev.video_id;
        videoIdWaiterRef.current?.(ev.video_id);
      } else if (
        "video_id" in ev &&
        currentVideoIdRef.current &&
        ev.video_id !== currentVideoIdRef.current
      ) {
        return;
      }
      switch (ev.stage) {
        case "Started":
          setPhase("started");
          setPercent(0);
          setPreparingStep(null);
          setRetryMessage(null);
          break;
        case "Waiting":
          setPhase(ev.resource === "download" ? "waiting_download" : "waiting_compute");
          setPercent(0);
          break;
        case "Preparing":
          setPreparingStep(ev.step);
          break;
        case "Downloading":
          setPhase("downloading");
          setPercent(ev.percent);
          setDlSpeed(ev.speed ?? null);
          setDlEta(ev.eta ?? null);
          setDlTotal(ev.total ?? null);
          setRetryMessage(null);
          // Clear sub-step now that we've moved on.
          setPreparingStep(null);
          break;
        case "Retrying":
          setPhase("downloading");
          setDlSpeed(null);
          setDlEta(null);
          setPreparingStep(null);
          setRetryMessage(ev.message);
          break;
        case "ExtractingAudio":
          setPhase("extracting");
          setPercent(0);
          setPreparingStep(null);
          setRetryMessage(null);
          break;
        case "Transcribing":
          setPhase("transcribing");
          setPercent(ev.percent);
          setRetryMessage(null);
          break;
        case "Transcribed":
          setPhase("done");
          setPercent(100);
          setRetryMessage(null);
          break;
        case "Failed":
          setPhase("error");
          setError(ev.error);
          setRetryMessage(null);
          break;
        case "Log":
          setLogLines((prev) => {
            const next = [
              ...prev,
              { source: ev.source, text: ev.line, id: ++logIdRef.current },
            ];
            // Keep only the most recent N lines so the panel stays manageable.
            return next.length > LOG_BUFFER_SIZE
              ? next.slice(-LOG_BUFFER_SIZE)
              : next;
          });
          break;
      }
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((error) => {
        console.warn("pipeline-event listener failed", error);
      })
      .finally(markReady);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function pickFile() {
    const result = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "avi"] }],
    });
    if (typeof result === "string") {
      setFilePath(result);
      if (validationError) setValidationError(null);
    }
  }

  async function confirmExistingVideo(title?: string): Promise<boolean> {
    const label = title?.trim() ? `“${title.trim()}”` : "这个视频";
    return confirmDialog(
      `${label}已经在语料库中。是否覆盖并重新下载、转录和解析？`,
      {
        title: "视频已存在",
        okText: "覆盖并重新解析",
        cancelText: "取消",
        danger: true,
      },
    );
  }

  async function submit(
    opts: { background?: boolean; overwriteAuthorized?: boolean } = {},
  ) {
    if (submitGateRef.current) return;
    submitGateRef.current = true;
    try {
      await submitOnce(opts);
    } finally {
      submitGateRef.current = false;
    }
  }

  async function submitOnce(
    opts: { background?: boolean; overwriteAuthorized?: boolean } = {},
  ) {
    const background = opts.background ?? false;
    setError(null);
    setQuotaBlock(null);
    const sourceKind = tab;
    const sourceValue = tab === "url" ? urlValue.trim() : filePath;
    if (!sourceValue) {
      // Empty-input validation: inline message + focus, NOT the
      // troubleshooting checklist (which is for real download
      // failures and would be confusing here).
      setValidationError(
        tab === "url" ? "请先粘贴视频链接" : "请先选择视频文件"
      );
      if (tab === "url") urlInputRef.current?.focus();
      return;
    }
    setValidationError(null);
    if (!settings.whisperModel) {
      setError("Whisper 模型未配置（去设置页选一个并下载）");
      return;
    }

    const managedQuotaBlock =
      settings.vendorId === "whatsub-managed"
        ? await preflightManagedQuota(settings)
        : null;
    if (managedQuotaBlock) {
      setQuotaBlock(managedQuotaBlock);
      return;
    }

    let overwrite = opts.overwriteAuthorized ?? false;
    if (!overwrite) {
      let preflight: ImportPreflight;
      try {
        preflight = await invoke<ImportPreflight>("import_preflight", {
          sourceKind,
          sourceValue,
        });
      } catch (e) {
        setValidationError(`检查视频是否已存在失败：${String(e)}`);
        return;
      }
      if (preflight.state === "running") {
        setValidationError("该视频正在下载或解析，请等待当前任务完成。");
        return;
      }
      if (preflight.state === "existing") {
        overwrite = await confirmExistingVideo(preflight.title);
        if (!overwrite) return;
      }
    }

    const req = {
      sourceKind,
      sourceValue,
      whisperModel: settings.whisperModel,
      quality,
      analysisStyle,
      background,
      overwrite,
    };
    retryImportOptionsRef.current = {
      background,
      overwriteAuthorized: overwrite,
    };

    if (background) {
      // Fire-and-forget. We don't await — the modal closes immediately
      // and the Rust task keeps running. (Eventual progress visibility
      // is delivered by the queue widget added in v0.1.36; for now the
      // user sees the library entry appear once whisper completes.)
      void (async () => {
        try {
          await invoke("import_video", { req });
          await reload();
        } catch (e) {
          console.warn("background import failed", e);
        }
      })();
      onClose();
      return;
    }

    setSubmitting(true);
    foregroundImportActiveRef.current = true;
    setPhase("started");
    setPercent(0);
    setDlSpeed(null);
    setDlEta(null);
    setDlTotal(null);
    setLogLines([]);

    await pipelineListenerReadyRef.current;

    try {
      const result = await invoke<{
        videoId: string;
        srtPath: string;
        durationSec: number;
      }>("import_video", { req });
      // Cleared early so a subsequent close doesn't try to cancel an
      // already-completed import.
      currentVideoIdRef.current = null;
      foregroundImportActiveRef.current = false;
      startFor(result.videoId);
      await reload();
      onClose();
      navigate(`/player/${result.videoId}?srt=${encodeURIComponent(result.srtPath)}`);
    } catch (e) {
      const msg = String(e);
      // "cancelled" comes from AppError::Cancelled when the user pressed
      // Esc / ✕ — that's not a failure to show in the error dialog,
      // just a quiet abort. The cancel path already calls onClose().
      if (msg.includes("cancelled")) {
        setSubmitting(false);
        currentVideoIdRef.current = null;
        foregroundImportActiveRef.current = false;
        return;
      }
      if (msg.includes("video_exists:") && !overwrite) {
        setSubmitting(false);
        setPhase("idle");
        currentVideoIdRef.current = null;
        foregroundImportActiveRef.current = false;
        if (await confirmExistingVideo()) {
          await submitOnce({ background, overwriteAuthorized: true });
        }
        return;
      }
      console.error("import_video failed", e);
      setPhase("error");
      setError(msg);
      setSubmitting(false);
      foregroundImportActiveRef.current = false;
    }
  }
  // Keep submitRef pointed at the latest submit() so the in-modal
  // site-login flow's auto-retry (triggered from a `[]`-deps effect)
  // doesn't fire a stale closure with outdated form state.
  // A login-success retry is an internal continuation of the same logical
  // submit. It must not be blocked by the user-click gate while the original
  // invoke is still unwinding after emitting its Failed event.
  submitRef.current = () => submitOnce(retryImportOptionsRef.current);

  function reset() {
    setSubmitting(false);
    foregroundImportActiveRef.current = false;
    setPhase("idle");
    setPercent(0);
    setDlSpeed(null);
    setDlEta(null);
    setDlTotal(null);
    setError(null);
    setLogLines([]);
  }

  // Error dialog. Rendered in BOTH the progress view and
  // the form view (yt-dlp failures bounce submitting back to false,
  // so the user sees the failure on the form view). Defining once
  // here as a const keeps the JSX shared between the two return
  // branches without duplication.
  const errorChecklistDialog =
    showErrorDialog && error
      ? (() => {
          // friendlyError identifies focused diagnoses and decides which
          // site's login button to surface (action.siteKey + label + URL +
          // harvestDomains). Generic errors continue to use the broader
          // troubleshooting checklists.
          const fe = friendlyError(
            error,
            tab === "url" ? "downloading" : phase,
            tab === "url" ? urlValue : undefined,
          );
          const act = fe.action;
          // Local-file imports never run yt-dlp — the failure is in ffmpeg
          // (corrupt/unsupported file, no audio track) or whisper, NOT a
          // download/cookies/network problem. Generic local failures get
          // their own checklist instead of the download one.
          const isLocal = tab === "local";
          const isDiagnosedLocal = isLocal && !fe.generic;
          const isDiagnosedDownload = !isLocal && !fe.generic;
          const isDiagnosed = isDiagnosedLocal || isDiagnosedDownload;
          return (
            <div
              className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]"
              onClick={() => setShowErrorDialog(false)}
            >
              <div
                className="bg-zinc-900 border border-zinc-700 rounded-lg w-[640px] max-w-[90vw] max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-zinc-800">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-zinc-100 mb-1">
                      {isDiagnosed
                        ? fe.title
                        : isLocal
                          ? "解析失败 — 排查清单"
                          : "下载失败 — 排查清单"}
                    </div>
                    <div className="text-xs leading-relaxed text-zinc-400">
                      {isDiagnosed
                        ? fe.suggestion
                        : isLocal
                          ? "本地视频不走下载，失败多半出在文件本身或音轨解码。逐条对照检查。"
                          : "暂时无法确定唯一原因，请按相关性逐项检查。"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowErrorDialog(false)}
                    className="shrink-0 text-zinc-500 hover:text-zinc-200 text-xl leading-none px-1"
                    title="关闭 (Esc)"
                  >
                    ×
                  </button>
                </div>

                <div className="px-5 py-4 flex-1 min-h-0 overflow-y-auto space-y-2.5">
                  {isLocal && !isDiagnosedLocal && (
                    <>
                      <ChecklistItem
                        index="①"
                        title="视频文件本身有问题"
                        badge={{ text: "最常见", color: "rose" }}
                      >
                        文件没下完整、传输中断、或本来就损坏，都会让解析失败。先用系统播放器
                        （VLC / PotPlayer 等）确认这个文件能完整播放、能听到声音 —— 能正常播放的
                        完整文件才能识别；不行就换个文件再导。
                      </ChecklistItem>

                      <ChecklistItem
                        index="②"
                        title="没有音轨 / 编码不支持"
                        badge={{ text: "无声 / 冷门编码", color: "amber" }}
                      >
                        字幕识别靠音频。纯画面、静音录屏、或音轨用了少见编码（ffmpeg / whisper
                        解不出）都会失败。确认视频里能听到人说话；必要时先用剪辑软件转成常见的
                        mp4（H.264 + AAC）再导入。
                      </ChecklistItem>

                      <ChecklistItem index="③" title="文件被占用 / 路径异常">
                        文件正被别的程序打开、放在只读目录、或路径含特殊字符，都可能让 ffmpeg
                        读不到。关掉占用它的程序，或把文件拷到桌面这种简单路径再试。
                      </ChecklistItem>
                    </>
                  )}

                  {!isLocal && !isDiagnosedDownload && (
                  <>
                  <ChecklistItem
                    index="①"
                    title="国际站点需要梯子"
                    badge={{ text: "YouTube / Ins / X", color: "amber" }}
                  >
                    YouTube / Instagram / X / TikTok 等国外站点要开梯子才能访问。
                  </ChecklistItem>

                  <ChecklistItem
                    index="②"
                    title="登录目标网站抓 cookies"
                    badge={{ text: "最常见", color: "rose" }}
                  >
                    <div className="text-[11px] text-zinc-400 mb-2 leading-relaxed">
                      cookies 是浏览器里存的登录凭据。很多视频要求登录账号才能下载（YouTube
                      反 bot、B 站会员、Instagram 等）—— 在 whatsub
                      里同一个网站登一次就能用几天，不用反复配（每个网站各自登一次即可）。
                      如果配过 cookies 还失败，多半是网络抖动，直接试「后台下载」更省事。
                    </div>
                    {act ? (
                      <button
                        type="button"
                        onClick={() => void beginSiteLogin(act)}
                        className="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-xs font-medium rounded"
                      >
                        立即登录 {act.siteLabel} →
                      </button>
                    ) : (
                      <span className="text-[11px] text-zinc-500">
                        进设置 →「网站 Cookies 来源」→「快速获取」选站点登录
                      </span>
                    )}
                  </ChecklistItem>

                  <ChecklistItem index="③" title="网络偶尔抽风">
                    <div className="text-[11px] text-zinc-400 mb-2 leading-relaxed">
                      如果 cookies 配过、前台又一直失败，建议直接换「后台下载」
                      — 后台模式会用更耐心的重试策略反复尝试（~3 分钟预算），
                      碰到 GFW / CDN 间歇性掐 TLS 这种抖动更可能磨过去；
                      你不用一直盯着，跑完会自动在库里出现。
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowErrorDialog(false);
                        setError(null);
                        void submit({ background: true });
                      }}
                      className="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-xs font-medium rounded"
                    >
                      后台下载 →
                    </button>
                  </ChecklistItem>
                  </>
                  )}

                  {isDiagnosed && (
                    <div
                      className={`rounded-lg border p-4 ${
                        fe.loginRequired
                          ? "border-amber-500/40 bg-amber-500/5"
                          : fe.retryable
                            ? "border-blue-500/40 bg-blue-500/5"
                            : "border-zinc-700 bg-zinc-950/50"
                      }`}
                    >
                      <div className="text-sm font-medium text-zinc-100 mb-1">
                        {fe.loginRequired
                          ? "需要重新登录"
                          : fe.retryable
                            ? "网络连接失败"
                            : "已识别失败原因"}
                      </div>
                      <p className="text-xs leading-relaxed text-zinc-400">
                        {fe.suggestion}
                      </p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        {fe.loginRequired && act && (
                          <button
                            type="button"
                            onClick={() => void beginSiteLogin(act)}
                            className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-xs font-medium rounded"
                          >
                            重新登录 {act.siteLabel}
                          </button>
                        )}
                        {fe.retryable && (
                          <button
                            type="button"
                            onClick={() => {
                              setShowErrorDialog(false);
                              setError(null);
                              void submit({ background: true });
                            }}
                            className="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-xs font-medium rounded"
                          >
                            放到后台重试
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Raw error tail — surfaces the actual stderr (yt-dlp for
                      downloads, ffmpeg/whisper for local files) to power users
                      without forcing them to dig into the log panel. Most
                      useful when the items above don't pinpoint the cause
                      (format unavailable, ffmpeg merge/decode error, signature
                      extraction failed — stuff specific to a particular
                      video). */}
                  {error && (
                    <ChecklistItem
                      index="④"
                      title={
                        isLocal
                          ? "详细错误信息（ffmpeg / whisper 原始输出）"
                          : "详细错误信息（yt-dlp 原始输出）"
                      }
                    >
                      <div className="text-[10px] text-zinc-400 mb-1.5 leading-relaxed">
                        {isLocal
                          ? "以下是 ffmpeg / whisper 实际报的错(stderr 末尾)。遇到上面三条都不对症时,这里通常能定位具体原因。长按选中可以拷贝。"
                          : "以下是后台 yt-dlp 实际报的错(stderr 末尾)。遇到上面三条都不对症的情况下,这里通常能定位具体原因。长按选中可以拷贝。"}
                      </div>
                      <pre className="text-[10px] font-mono leading-relaxed bg-zinc-950 border border-zinc-800 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-zinc-300 select-text">
                        {error}
                      </pre>
                    </ChecklistItem>
                  )}

                </div>

                <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800">
                  <button
                    onClick={() => setShowErrorDialog(false)}
                    className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-xs rounded font-medium"
                  >
                    关闭
                  </button>
                  {/* 重试 — only shown when friendlyError flagged the error
                      as retryable (network / SSL / DNS / CDN flake). Other
                      error classes (cookies expired / video private /
                      banned) wouldn't benefit from a same-params retry,
                      so we don't surface the button there. Closing the
                      dialog + re-submitting kicks off a fresh foreground
                      import. */}
                  {fe.retryable && (
                    <button
                      onClick={() => {
                        setShowErrorDialog(false);
                        setError(null);
                        void submit({ background: false });
                      }}
                      className="px-4 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-xs rounded font-medium"
                    >
                      重试
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })()
      : null;

  // ------- Pending-login view -------
  // Active whenever the user clicked "立即登录 X" from the error
  // checklist. Replaces both the form and progress views with a
  // focused "等待保存" panel; once the user clicks 保存 cookies and
  // the site-login-success event fires, the listener above auto-
  // retries submit() and the modal returns to the progress view.
  if (pendingLogin) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[480px] max-w-full">
          <h2 className="text-lg font-semibold text-zinc-100 mb-3">
            等待 {pendingLogin.label} 登录完成
          </h2>
          <div className="px-3 py-3 rounded border border-blue-500/40 bg-blue-500/5 mb-4">
            <ol className="space-y-1.5 text-xs leading-relaxed text-zinc-300 list-none">
              <li className="flex gap-2">
                <span className="text-blue-300 font-medium shrink-0">1.</span>
                <span>
                  whatsub 已经在你电脑上打开了 {pendingLogin.label}{" "}
                  的登录页（一个独立的浏览器窗口）
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-300 font-medium shrink-0">2.</span>
                <span>
                  在浏览器里完成登录（Google / Apple / 手机号 / 扫码均可）
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-blue-300 font-medium shrink-0">3.</span>
                <span>
                  回到这里点{" "}
                  <span className="text-blue-300 font-medium">「保存 cookies」</span>
                  ，whatsub 会自动重新导入这个视频
                </span>
              </li>
            </ol>
          </div>
          {loginError && (
            <div className="mb-3 px-2.5 py-1.5 bg-rose-500/10 border border-rose-500/30 rounded text-[11px] text-rose-200">
              {loginError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancelLoginInModal}
              disabled={savingLogin}
              className="px-3 py-1.5 text-sm text-zinc-300 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={finishLogin}
              disabled={savingLogin}
              className="px-4 py-1.5 bg-blue-500 hover:bg-blue-400 disabled:opacity-60 text-black text-sm rounded font-medium"
            >
              {savingLogin ? "保存中..." : "保存 cookies"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ------- Progress view -------
  if (submitting) {
    const showBar = phase === "downloading" || phase === "transcribing";
    // 准备中 + 下载视频 are shown as ONE step (the "started" step also covers the
    // download phase for URL imports). Local imports have no download phase.
    const visiblePhases: Phase[] = ["started", "extracting", "transcribing", "done"];
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[520px] max-w-full max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-zinc-100">解析进行中</h2>
            {/* Cancel during import. Calls cancel_import which kills
                yt-dlp/ffmpeg/whisper and wipes the partial files +
                library entry on the Rust side, then closes the modal.
                Esc has the same effect (handled in the keydown
                listener above). */}
            {(phase === "started" ||
              phase === "waiting_download" ||
              phase === "downloading" ||
              phase === "extracting" ||
              phase === "waiting_compute" ||
              phase === "transcribing") && (
              <button
                type="button"
                disabled={canceling}
                onClick={() => {
                  void (async () => {
                    if (await cancelInFlight()) onClose();
                  })();
                }}
                className="text-zinc-500 hover:text-zinc-200 disabled:opacity-50 text-xl leading-none px-2 -mr-2"
                title={canceling ? "正在取消…" : "取消下载 (Esc)"}
              >
                ×
              </button>
            )}
          </div>

          {canceling && (
            <div role="status" className="mb-3 text-sm text-amber-300">
              正在停止并清理…
            </div>
          )}
          {cancelError && (
            <div role="alert" className="mb-3 text-sm text-red-300">
              {cancelError}
            </div>
          )}

          <div className="space-y-3">
            {visiblePhases.map((p) => {
              // The "started" step is the merged 准备中 + 下载视频 stage: for URL
              // imports it stays current through the download phase, and is only
              // "done" once we move past downloading (extracting+).
              const isStarted = p === "started";
              const isCurrent = isStarted
                ? phase === "started" || phase === "waiting_download" || phase === "downloading"
                : p === "transcribing" && phase === "waiting_compute"
                  ? true
                  : phase === p;
              const isDone = isStarted
                ? phaseOrder(phase) > phaseOrder("downloading")
                : phaseOrder(p) < phaseOrder(phase);
              const label = phase === "waiting_download" && isStarted
                ? PHASE_LABEL.waiting_download
                : phase === "waiting_compute" && p === "transcribing"
                  ? PHASE_LABEL.waiting_compute
                  : isStarted && tab !== "local"
                    ? "下载视频"
                    : PHASE_LABEL[p];
              return (
                <div
                  key={p}
                  className={
                    "flex items-center gap-3 text-sm " +
                    (isCurrent
                      ? "text-blue-300"
                      : isDone
                      ? "text-green-400"
                      : "text-zinc-500")
                  }
                >
                  <span className="w-5 h-5 flex items-center justify-center shrink-0">
                    {isDone ? (
                      <span className="text-green-400">✓</span>
                    ) : isCurrent ? (
                      <span className="w-3.5 h-3.5 border-2 border-blue-300 border-t-transparent rounded-full animate-spin inline-block" />
                    ) : (
                      <span className="w-2 h-2 border border-zinc-600 rounded-full inline-block" />
                    )}
                  </span>
                  <span className="font-medium">
                    {label}
                    {/* Sub-step badge inside the merged step when active —
                        shows which yt-dlp sub-task is currently running
                        so a long preparation isn't a black box. */}
                    {isCurrent && isStarted && preparingStep && (
                      <span className="ml-2 text-[11px] text-blue-200/80 font-normal">
                        · {PREPARING_SUBSTEP_LABEL[preparingStep] ?? preparingStep}
                      </span>
                    )}
                  </span>
                  <span className="flex-1 text-[10px] text-zinc-600 italic">
                    {isStarted && tab !== "local"
                      ? "随网速：几秒到几分钟"
                      : phaseDuration(p, settings.whisperModel)}
                  </span>
                  {isCurrent && showBar && (
                    <span className="text-xs text-zinc-400 tabular-nums">
                      {percent}%
                      {phase === "downloading" && dlTotal && ` · ${dlTotal}`}
                      {phase === "downloading" && dlSpeed && ` · ${dlSpeed}`}
                      {phase === "downloading" && dlEta && ` · 剩余 ${dlEta}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {retryMessage && (
            <div role="status" className="mt-3 text-xs text-amber-300">
              {retryMessage}
            </div>
          )}

          {showBar && (
            <div className="mt-4 w-full h-1.5 bg-zinc-800 rounded overflow-hidden">
              <div
                className="h-full bg-blue-400 transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {error && (
            // The dialog auto-opens via useEffect; this button is the
            // "re-open if I closed it" affordance. Intentionally
            // generic — we don't surface yt-dlp's actual error text
            // here, the user reads the checklist inside the dialog.
            <button
              type="button"
              onClick={() => setShowErrorDialog(true)}
              className="mt-4 w-full flex items-center gap-2 px-3 py-2 bg-red-900/30 border border-red-800 rounded text-sm text-red-200 hover:bg-red-900/50 transition-colors text-left"
            >
              <span className="shrink-0">⚠️</span>
              <span className="font-medium flex-1">下载失败 — 看排查清单</span>
              <span className="shrink-0 text-[10px] text-red-300/70">▸</span>
            </button>
          )}

          {/* Live sub-process log — collapsible. Lets the user see exactly
              what step yt-dlp / ffmpeg / whisper-cli is on during the
              "preparing" / "transcribing" phases that don't expose percent. */}
          <div className="mt-4 border-t border-zinc-800 pt-3">
            <button
              type="button"
              onClick={() => setShowLog((v) => !v)}
              className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <span className="inline-block w-3 text-zinc-500">
                {showLog ? "▾" : "▸"}
              </span>
              详细日志
              <span className="text-zinc-600">({logLines.length} 行)</span>
            </button>
            {showLog && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded bg-black/40 border border-zinc-800 p-2 font-mono text-[10px] leading-relaxed">
                {logLines.length === 0 ? (
                  <div className="text-zinc-600 italic">暂无输出...</div>
                ) : (
                  logLines.map((l) => (
                    <div key={l.id} className="text-zinc-400">
                      <span className="text-blue-400">[{l.source}]</span>{" "}
                      <span className="break-all">{l.text}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 mt-5">
            {error ? (
              <>
                <button
                  onClick={reset}
                  className="px-3 py-1.5 text-sm text-zinc-300"
                >
                  返回
                </button>
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm bg-zinc-700 text-zinc-100 rounded"
                >
                  关闭
                </button>
              </>
            ) : (
              <span className="text-xs text-zinc-500 self-center">
                跨阶段总耗时取决于网速、视频长度和模型大小，请耐心等候...
              </span>
            )}
          </div>
        </div>

        {/* Error-checklist dialog — shared between progress + form
            views; defined as `errorChecklistDialog` const above. */}
        {errorChecklistDialog}
      </div>
    );
  }

  // ------- Form view -------
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[480px] max-w-full">
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">导入视频</h2>

        <div className="flex gap-2 mb-3">
          {(["url", "local"] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                if (validationError) setValidationError(null);
              }}
              className={
                "px-3 py-1 text-sm rounded " +
                (tab === t ? "bg-blue-500 text-black" : "bg-zinc-800 text-zinc-300")
              }
            >
              {t === "url" ? "粘贴 URL" : "本地文件"}
            </button>
          ))}
        </div>

        {tab === "url" ? (
          <>
            {/* During onboarding the sample URL is offered as ghost-text
                (placeholder) + a Tab-to-fill affordance INSIDE the input,
                not as a separate button below it. The old below-input
                button sat under the tour's spotlight tooltip + dim mask, so
                first-time users literally couldn't see it. Keeping the hint
                inside the highlighted input keeps it in the cutout. */}
            <div className="relative">
              <input
                ref={urlInputRef}
                type="text"
                data-tour="url-input"
                value={urlValue}
                onChange={(e) => {
                  setUrlValue(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                onKeyDown={(e) => {
                  // Tab (without Shift) on an EMPTY field during onboarding
                  // accepts the sample URL instead of moving focus — the
                  // ghost-text-autocomplete gesture the placeholder promises.
                  // Gated on showSampleLink so normal users keep Tab as plain
                  // focus navigation.
                  if (
                    showSampleLink &&
                    e.key === "Tab" &&
                    !e.shiftKey &&
                    urlValue.trim() === ""
                  ) {
                    e.preventDefault();
                    setUrlValue(SAMPLE_URL);
                    if (validationError) setValidationError(null);
                  }
                }}
                placeholder={
                  showSampleLink
                    ? SAMPLE_URL
                    : "https://www.youtube.com/watch?v="
                }
                className={
                  "w-full px-3 py-2 bg-zinc-800 text-zinc-100 rounded text-sm border " +
                  (showSampleLink && !urlValue ? "pr-24 " : "") +
                  (validationError ? "border-rose-500" : "border-zinc-700")
                }
              />
              {showSampleLink && !urlValue && (
                <button
                  type="button"
                  data-tour="sample-link"
                  onClick={() => {
                    setUrlValue(SAMPLE_URL);
                    if (validationError) setValidationError(null);
                    urlInputRef.current?.focus();
                  }}
                  title="填入示例链接：Me at the zoo（YouTube 第一支视频，18 秒）"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1 px-1.5 py-1 rounded bg-zinc-700/80 hover:bg-zinc-600 text-[10px] text-zinc-300 hover:text-zinc-100 transition-colors"
                >
                  <kbd className="font-mono text-[10px] px-1 py-px rounded bg-zinc-900/70 border border-zinc-600">
                    Tab
                  </kbd>
                  填入示例
                </button>
              )}
            </div>
            {validationError && (
              <div className="mt-1.5 text-xs text-rose-300">
                {validationError}
              </div>
            )}
            {expiredPrompt && (
              <div className="mt-2 text-xs text-amber-400 flex items-center gap-2">
                <span>{expiredPrompt.siteLabel} 登录可能已过期，下载失败时可先重新登录。</span>
                <button className="underline hover:text-amber-300" onClick={() => setLoginOpen(true)}>
                  重新登录
                </button>
              </div>
            )}
            {expiredPrompt && (
              <SiteLoginModal open={loginOpen} action={expiredPrompt} onClose={() => setLoginOpen(false)} />
            )}
            <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
              <span className="shrink-0">画质</span>
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as typeof quality)}
                className="flex-1 px-2 py-1.5 bg-zinc-800 text-zinc-100 rounded border border-zinc-700"
              >
                <option value="low">标清 480p（最小、最快）</option>
                <option value="standard">高清 720p（推荐）</option>
                <option value="high">超清 1080p</option>
                <option value="best">原画 1080p（H.264 最高兼容）</option>
              </select>
            </div>
          </>
        ) : (
          <>
            <div className="flex gap-2">
              <input
                type="text"
                value={filePath}
                readOnly
                placeholder="未选择文件"
                className={
                  "flex-1 px-3 py-2 bg-zinc-800 text-zinc-300 rounded text-sm border " +
                  (validationError ? "border-rose-500" : "border-zinc-700")
                }
              />
              <button
                onClick={pickFile}
                className="px-3 py-2 bg-zinc-700 text-zinc-100 rounded text-sm"
              >
                选择...
              </button>
            </div>
            {validationError && (
              <div className="mt-1.5 text-xs text-rose-300">
                {validationError}
              </div>
            )}
          </>
        )}

        {/* Translation style — 3-stop slider (正式 / 中性 / 口语). The
            thumb position IS the active-state indicator; the labels
            below are also clickable so users can tap instead of drag.
            Saved on the library entry → Player picks the matching
            system prompt at analysis time. */}
        <div className="mt-4">
          <div className="text-xs text-zinc-400 mb-3">翻译风格</div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={dragPercent}
            onChange={(e) => setDragPercent(Number(e.target.value))}
            onPointerUp={() => commitStyle(previewIdx)}
            onPointerCancel={() => commitStyle(previewIdx)}
            onTouchEnd={() => commitStyle(previewIdx)}
            onBlur={() => commitStyle(previewIdx)}
            onKeyDown={(e) => {
              // Keyboard nav jumps between anchors instead of crawling
              // by 1% — Arrow ← / → / ↑ / ↓ move one stop; Home/End
              // jump to either end.
              if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                e.preventDefault();
                commitStyle(previewIdx - 1);
              } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                e.preventDefault();
                commitStyle(previewIdx + 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                commitStyle(0);
              } else if (e.key === "End") {
                e.preventDefault();
                commitStyle(2);
              }
            }}
            aria-label="翻译风格"
            className="w-full appearance-none bg-transparent cursor-pointer outline-none
                       [&::-webkit-slider-runnable-track]:h-2
                       [&::-webkit-slider-runnable-track]:rounded-full
                       [&::-webkit-slider-runnable-track]:bg-gradient-to-r
                       [&::-webkit-slider-runnable-track]:from-zinc-700
                       [&::-webkit-slider-runnable-track]:via-blue-500/40
                       [&::-webkit-slider-runnable-track]:to-blue-400
                       [&::-webkit-slider-thumb]:appearance-none
                       [&::-webkit-slider-thumb]:w-5
                       [&::-webkit-slider-thumb]:h-5
                       [&::-webkit-slider-thumb]:rounded-full
                       [&::-webkit-slider-thumb]:bg-blue-400
                       [&::-webkit-slider-thumb]:shadow-[0_0_0_4px_rgba(96,165,250,0.25)]
                       [&::-webkit-slider-thumb]:-mt-1.5
                       [&::-webkit-slider-thumb]:cursor-grab
                       [&::-webkit-slider-thumb]:active:cursor-grabbing
                       [&::-webkit-slider-thumb]:transition-transform
                       [&::-webkit-slider-thumb]:hover:scale-110"
          />
          <div className="flex justify-between mt-2.5 px-0.5 text-xs">
            {(["formal", "neutral", "colloquial"] as const).map((s, i) => (
              <button
                key={s}
                type="button"
                onClick={() => commitStyle(i)}
                className={
                  "transition-colors " +
                  (i === previewIdx
                    ? "text-blue-400 font-medium"
                    : "text-zinc-500 hover:text-zinc-300")
                }
              >
                {STYLE_LABEL[s]}
              </button>
            ))}
          </div>
        </div>

        {/* Error display: replaces the old red stderr dump with a
            compact button that opens the troubleshooting checklist
            dialog. The dialog also auto-opens on new errors via the
            useEffect above, so this button is the "re-open after I
            closed it" affordance. */}
        {error && (
          <button
            type="button"
            onClick={() => setShowErrorDialog(true)}
            className="mt-3 w-full flex items-center gap-2 px-3 py-2 bg-red-900/30 border border-red-800 rounded text-sm text-red-200 hover:bg-red-900/50 transition-colors text-left"
          >
            <span className="shrink-0">⚠️</span>
            <span className="font-medium flex-1">下载失败 — 看排查清单</span>
            <span className="shrink-0 text-[10px] text-red-300/70">▸</span>
          </button>
        )}

        {quotaBlock && (
          <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            <div className="leading-relaxed">
              {quotaRecoveryMessage(quotaBlock)}
            </div>
            <button
              type="button"
              onClick={() => navigate(SETTINGS_LLM_LINK)}
              className="mt-2 rounded bg-amber-400 px-2.5 py-1 text-xs font-medium text-black hover:bg-amber-300"
            >
              切换自己的 API
            </button>
          </div>
        )}

        {(() => {
          // Visually disable the submit buttons when no source is set,
          // but keep them clickable — clicking surfaces the inline
          // validation message in submit() (focuses input + red ring).
          // Don't use HTML `disabled` because that would swallow the
          // click and the user wouldn't see why the action didn't fire.
          const canSubmit = tab === "url" ? !!urlValue.trim() : !!filePath;
          const disabledCls = canSubmit
            ? ""
            : " opacity-50 cursor-not-allowed";
          return (
            <div className="flex justify-end items-center gap-2 mt-5">
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-300">
                取消
              </button>
              {/* 后台下载 — fire-and-forget. Modal closes immediately; Rust
                  uses a more patient pre-transfer budget. Once bytes have
                  started moving, foreground and background both keep
                  cancellably resuming transient failures from partial files. */}
              <button
                onClick={() => void submit({ background: true })}
                className={
                  "px-3 py-1.5 text-sm bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded" +
                  disabledCls
                }
                title={
                  canSubmit
                    ? tab === "url"
                      ? "放到后台继续下载，关闭弹窗。后台模式 yt-dlp 会重试更长时间"
                      : "放到后台解析，关闭弹窗，解析完成后自动入库"
                    : tab === "url"
                    ? "请先粘贴视频链接"
                    : "请先选择视频文件"
                }
              >
                {tab === "url" ? "后台下载" : "后台解析"}
              </button>
              <button
                data-tour="submit-button"
                onClick={() => void submit({ background: false })}
                className={
                  "px-4 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-sm rounded font-medium" +
                  disabledCls
                }
                title={
                  canSubmit
                    ? undefined
                    : tab === "url"
                    ? "请先粘贴视频链接"
                    : "请先选择视频文件"
                }
              >
                开始解析
              </button>
            </div>
          );
        })()}
      </div>
      {/* Same checklist dialog as the progress view — defined once
          as `errorChecklistDialog` const at the top of the component. */}
      {errorChecklistDialog}
    </div>
  );
}

function phaseOrder(p: Phase): number {
  return {
    idle: -1,
    started: 0,
    waiting_download: 0,
    downloading: 1,
    extracting: 2,
    waiting_compute: 2,
    transcribing: 3,
    done: 4,
    error: 99,
  }[p];
}

/** One row in the import-failure troubleshooting checklist. Title +
 *  optional badge + body; the body is free-form ReactNode so each
 *  item can embed inline code samples, action buttons, links, etc. */
function ChecklistItem({
  index,
  title,
  badge,
  children,
}: {
  index: string;
  title: string;
  badge?: { text: string; color: "rose" | "amber" };
  children: React.ReactNode;
}) {
  const badgeClass =
    badge?.color === "rose"
      ? "bg-rose-500/20 text-rose-300"
      : "bg-amber-500/20 text-amber-300";
  return (
    <div className="border border-zinc-800 rounded px-3 py-2.5 bg-zinc-950/40">
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        <span className="text-amber-300 font-semibold text-sm shrink-0">
          {index}
        </span>
        <span className="text-sm text-zinc-100 font-medium">{title}</span>
        {badge && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badgeClass}`}
          >
            {badge.text}
          </span>
        )}
      </div>
      <div className="text-xs text-zinc-300 leading-relaxed">{children}</div>
    </div>
  );
}
