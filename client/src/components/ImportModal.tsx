import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../store/settings";
import { useLibrary } from "../store/library";
import { useAnalysis } from "../store/analysis";
import { getTier } from "../llm/modelTiers";
import type { WhisperModelSize } from "../types/settings";
import { friendlyError } from "../utils/friendlyError";
import { TRANSLATION_STYLE_LABELS } from "../llm/prompts";
import type { TranslationStyle } from "../types/settings";

interface Props {
  onClose: () => void;
  /** Pre-fill the local-file path; switches the modal to the "本地文件" tab.
   *  Used when a file is dropped onto the window. */
  initialFilePath?: string;
}

type PipelineEventPayload =
  | { stage: "Started"; video_id: string }
  | { stage: "Downloading"; video_id: string; percent: number; total?: string; speed?: string; eta?: string }
  | { stage: "ExtractingAudio"; video_id: string }
  | { stage: "Transcribing"; video_id: string; percent: number }
  | { stage: "Transcribed"; video_id: string; srt_path: string; duration_sec: number }
  | { stage: "Failed"; video_id: string; error: string }
  | { stage: "ModelDownload"; progress: number; total_mb: number; downloaded_mb: number }
  | { stage: "Log"; video_id: string; source: string; line: string };

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

type Phase = "idle" | "started" | "downloading" | "extracting" | "transcribing" | "done" | "error";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  started: "准备中",
  downloading: "下载视频",
  extracting: "抽取音频",
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
    case "downloading":  return "随网速：几秒到几分钟";
    case "extracting":   return "约 1-5 秒";
    case "transcribing": return transcribeDuration(whisperModel);
    case "done":         return "立即";
    default:             return "";
  }
}

export function ImportModal({ onClose, initialFilePath }: Props) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { reload } = useLibrary();
  const { startFor } = useAnalysis();

  const [tab, setTab] = useState<"local" | "url">(initialFilePath ? "local" : "url");
  const [urlValue, setUrlValue] = useState("");
  const [filePath, setFilePath] = useState(initialFilePath ?? "");
  // yt-dlp quality preset: "low" (480p) / "standard" (720p) / "high" (1080p)
  // / "best" (no cap). 720p default — subtitle learning doesn't benefit from
  // 1080p+ and 720p downloads in 1/3 the time on most connections.
  const [quality, setQuality] = useState<"low" | "standard" | "high" | "best">("standard");
  // Translation register for AI analysis. Default 日常聊天; user picks per
  // import. Persists onto the library entry's analysisStyle so the Player
  // picks it up at analysis time.
  const [analysisStyle, setAnalysisStyle] = useState<TranslationStyle>("colloquial");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Error checklist dialog. Replaces the old "show raw stderr" pattern —
  // when an import fails we don't want to surface yt-dlp's cryptic
  // output at all; instead we auto-open a friendly help-style dialog
  // listing common causes (no VPN / missing cookies / bad URL / etc.)
  // with site-specific action buttons. Raw stderr stays available
  // but tucked behind a collapsible "技术详情" expander inside the
  // checklist so the cosmetic noise doesn't dominate the screen.
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  // Track the last error we auto-opened the dialog for so the dialog
  // doesn't re-pop every render — only when a NEW error appears. If
  // the user closes the dialog and the error hasn't changed, we
  // respect their dismiss.
  const lastShownErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== lastShownErrorRef.current) {
      lastShownErrorRef.current = error;
      setShowErrorDialog(true);
      // Always log raw error to console so developers / power users
      // can still pull the stderr via Ctrl+Shift+I in any build. The
      // checklist dialog itself stays clean: no walls of yt-dlp
      // output for non-technical users to navigate.
      console.error("[whatsub import error]", error);
    } else if (!error) {
      lastShownErrorRef.current = null;
    }
  }, [error]);

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

  // submit() is defined further down + captures form state via closure;
  // we ref it so the site-login-success listener (mounted once with
  // [] deps) always invokes the LATEST version, not a stale snapshot
  // from the first render.
  const submitRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    void Promise.all([
      listen("site-login-success", () => {
        setPendingLogin(null);
        setSavingLogin(false);
        setLoginError(null);
        setError(null);
        // Auto-retry the original import. Cookies are now in the jar
        // so yt-dlp will pick them up on the next invocation.
        void submitRef.current();
      }).then((un) => unlistens.push(un)),
      listen("site-login-cancelled", () => {
        setPendingLogin(null);
        setSavingLogin(false);
      }).then((un) => unlistens.push(un)),
    ]);
    return () => {
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
    try {
      await invoke("site_login_cancel");
    } catch {
      // ignore — even if cancel fails, we still want to clear UI state
    }
    setPendingLogin(null);
    setSavingLogin(false);
    setLoginError(null);
  }

  // Esc dismisses overlays in priority order: error dialog → help panel →
  // close the whole modal. Each layer is internally scrollable, so we don't
  // want Esc to skip past the one the user is currently reading.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showErrorDialog) {
        setShowErrorDialog(false);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showErrorDialog, onClose]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState<number>(0);
  // Download-only metrics from yt-dlp's progress template; null when unknown
  // (e.g. before yt-dlp has resolved size, or during non-download phases).
  const [dlSpeed, setDlSpeed] = useState<string | null>(null);
  const [dlEta, setDlEta] = useState<string | null>(null);
  const [dlTotal, setDlTotal] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  // Monotonic id source for log lines. Increments on every push so
  // simultaneous log events get distinct React keys.
  const logIdRef = useRef(0);
  const [showLog, setShowLog] = useState(false);

  // Subscribe to pipeline events while submitting so we can render live progress.
  useEffect(() => {
    if (!submitting) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<PipelineEventPayload>("pipeline-event", (e) => {
      const ev = e.payload;
      switch (ev.stage) {
        case "Started":
          setPhase("started");
          setPercent(0);
          break;
        case "Downloading":
          setPhase("downloading");
          setPercent(ev.percent);
          setDlSpeed(ev.speed ?? null);
          setDlEta(ev.eta ?? null);
          setDlTotal(ev.total ?? null);
          break;
        case "ExtractingAudio":
          setPhase("extracting");
          setPercent(0);
          break;
        case "Transcribing":
          setPhase("transcribing");
          setPercent(ev.percent);
          break;
        case "Transcribed":
          setPhase("done");
          setPercent(100);
          break;
        case "Failed":
          setPhase("error");
          setError(ev.error);
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
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [submitting]);

  async function pickFile() {
    const result = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "avi"] }],
    });
    if (typeof result === "string") setFilePath(result);
  }

  async function submit() {
    setError(null);
    const sourceKind = tab;
    const sourceValue = tab === "url" ? urlValue : filePath;
    if (!sourceValue) {
      setError(tab === "url" ? "请输入 URL" : "请选择文件");
      return;
    }
    if (!settings.whisperModel) {
      setError("Whisper 模型未配置（去设置页选一个并下载）");
      return;
    }

    setSubmitting(true);
    setPhase("started");
    setPercent(0);
    setDlSpeed(null);
    setDlEta(null);
    setDlTotal(null);
    setLogLines([]);

    try {
      const result = await invoke<{
        videoId: string;
        srtPath: string;
        durationSec: number;
      }>("import_video", {
        req: {
          sourceKind,
          sourceValue,
          whisperModel: settings.whisperModel,
          quality,
          analysisStyle,
        },
      });
      startFor(result.videoId);
      await reload();
      onClose();
      navigate(`/player/${result.videoId}?srt=${encodeURIComponent(result.srtPath)}`);
    } catch (e) {
      console.error("import_video failed", e);
      setPhase("error");
      setError(String(e));
      setSubmitting(false);
    }
  }
  // Keep submitRef pointed at the latest submit() so the in-modal
  // site-login flow's auto-retry (triggered from a `[]`-deps effect)
  // doesn't fire a stale closure with outdated form state.
  submitRef.current = submit;

  function reset() {
    setSubmitting(false);
    setPhase("idle");
    setPercent(0);
    setDlSpeed(null);
    setDlEta(null);
    setDlTotal(null);
    setError(null);
    setLogLines([]);
  }

  // Error-checklist dialog. Rendered in BOTH the progress view and
  // the form view (yt-dlp failures bounce submitting back to false,
  // so the user sees the failure on the form view). Defining once
  // here as a const keeps the JSX shared between the two return
  // branches without duplication.
  const errorChecklistDialog =
    showErrorDialog && error
      ? (() => {
          // friendlyError is still useful for ONE thing in the new
          // design: deciding which site's login button to surface
          // (action.siteKey + label + URL + harvestDomains). We
          // intentionally DON'T use its title/suggestion in the UI
          // — the checklist below is generic and covers more ground
          // than any single error pattern.
          const fe = friendlyError(
            error,
            phase,
            tab === "url" ? urlValue : undefined,
          );
          const act = fe.action;
          const startLogin = async () => {
            if (!act) return;
            try {
              await invoke("site_login_start", {
                args: {
                  key: act.siteKey,
                  label: act.siteLabel,
                  loginUrl: act.loginUrl,
                  harvestDomains: act.harvestDomains,
                },
              });
              // Switch the modal into the in-modal "waiting for save"
              // view — better UX than navigating off to Settings,
              // since the user keeps the import context AND we can
              // auto-retry the download once cookies land.
              setShowErrorDialog(false);
              setPendingLogin({ key: act.siteKey, label: act.siteLabel });
            } catch (e) {
              alert(`登录窗口启动失败：${e}`);
            }
          };
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
                      下载失败 — 排查清单
                    </div>
                    <div className="text-xs leading-relaxed text-zinc-400">
                      逐条对照检查，按相关性排序。多数情况是前两条之一。
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
                      里登一次就自动保存，下次直接用。
                    </div>
                    {act ? (
                      <button
                        type="button"
                        onClick={startLogin}
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
                    如果前两条都不是问题，那就重新点导入多试几次，或换个梯子节点试试。
                  </ChecklistItem>

                </div>

                <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800">
                  <button
                    onClick={() => setShowErrorDialog(false)}
                    className="px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-100 text-xs rounded font-medium"
                  >
                    关闭
                  </button>
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
    // Local-file imports skip the download phase (yt-dlp is not invoked).
    const visiblePhases: Phase[] =
      tab === "local"
        ? ["started", "extracting", "transcribing", "done"]
        : ["started", "downloading", "extracting", "transcribing", "done"];
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[520px] max-w-full max-h-[90vh] overflow-y-auto">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">解析进行中</h2>

          <div className="space-y-3">
            {visiblePhases.map((p) => {
              const isCurrent = phase === p;
              const isDone = phaseOrder(p) < phaseOrder(phase);
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
                  <span className="font-medium">{PHASE_LABEL[p]}</span>
                  <span className="flex-1 text-[10px] text-zinc-600 italic">
                    {phaseDuration(p, settings.whisperModel)}
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
              onClick={() => setTab(t)}
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
            <input
              type="text"
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              placeholder="https://www.youtube.com/watch?v="
              className="w-full px-3 py-2 bg-zinc-800 text-zinc-100 rounded text-sm border border-zinc-700"
            />
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
          <div className="flex gap-2">
            <input
              type="text"
              value={filePath}
              readOnly
              placeholder="未选择文件"
              className="flex-1 px-3 py-2 bg-zinc-800 text-zinc-300 rounded text-sm border border-zinc-700"
            />
            <button
              onClick={pickFile}
              className="px-3 py-2 bg-zinc-700 text-zinc-100 rounded text-sm"
            >
              选择...
            </button>
          </div>
        )}

        {/* Translation style — applies to both URL and local imports.
            Controls the LLM's translation register; saved on the library
            entry so the Player picks the matching prompt at analysis time. */}
        <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          <span className="shrink-0">翻译风格</span>
          <select
            value={analysisStyle}
            onChange={(e) => setAnalysisStyle(e.target.value as TranslationStyle)}
            className="flex-1 px-2 py-1.5 bg-zinc-800 text-zinc-100 rounded border border-zinc-700"
          >
            {(Object.keys(TRANSLATION_STYLE_LABELS) as TranslationStyle[]).map((s) => (
              <option key={s} value={s}>
                {TRANSLATION_STYLE_LABELS[s]}
              </option>
            ))}
          </select>
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

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-300">
            取消
          </button>
          <button
            onClick={submit}
            className="px-4 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
          >
            开始解析
          </button>
        </div>
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
    downloading: 1,
    extracting: 2,
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
