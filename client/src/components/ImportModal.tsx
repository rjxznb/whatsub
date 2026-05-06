import { useEffect, useState } from "react";
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
  /** Monotonic key for React lists; lines are immutable so timestamp suffices. */
  ts: number;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  // Error details open in a separate top-layer dialog so the long stderr
  // doesn't push the parent modal's scroll past 90vh and dominate the screen.
  const [showErrorDialog, setShowErrorDialog] = useState(false);

  // Esc dismisses overlays in priority order: error dialog → help panel →
  // close the whole modal. Each layer is internally scrollable, so we don't
  // want Esc to skip past the one the user is currently reading.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (showErrorDialog) {
        setShowErrorDialog(false);
      } else if (showHelp) {
        setShowHelp(false);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHelp, showErrorDialog, onClose]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState<number>(0);
  // Download-only metrics from yt-dlp's progress template; null when unknown
  // (e.g. before yt-dlp has resolved size, or during non-download phases).
  const [dlSpeed, setDlSpeed] = useState<string | null>(null);
  const [dlEta, setDlEta] = useState<string | null>(null);
  const [dlTotal, setDlTotal] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
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
              { source: ev.source, text: ev.line, ts: Date.now() },
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

          {error && (() => {
            const fe = friendlyError(error, phase);
            return (
              <button
                type="button"
                onClick={() => setShowErrorDialog(true)}
                title="点击查看详细错误"
                className="mt-4 w-full flex items-center gap-2 px-3 py-2 bg-red-900/30 border border-red-800 rounded text-sm text-red-200 hover:bg-red-900/50 transition-colors text-left"
              >
                <span className="shrink-0">⚠️</span>
                <span className="font-medium truncate flex-1">{fe.title}</span>
                <span className="shrink-0 text-[10px] text-red-300/70">点击查看详情 ▸</span>
              </button>
            );
          })()}

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
                    <div key={l.ts + l.text} className="text-zinc-400">
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

        {/* Error-detail dialog. Layered above the progress modal at z-60.
            The inner <pre> handles its own scroll so a 50+ line stderr
            stays bounded — the parent modal underneath never touches it. */}
        {showErrorDialog && error && (() => {
          const fe = friendlyError(error, phase);
          return (
            <div
              className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60]"
              onClick={() => setShowErrorDialog(false)}
            >
              <div
                className="bg-zinc-900 border border-red-800 rounded-lg w-[640px] max-w-[90vw] max-h-[80vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-zinc-800">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-red-300 mb-1">
                      ⚠️ {fe.title}
                    </div>
                    {fe.suggestion && (
                      <div className="text-xs leading-relaxed text-red-100/90">
                        {fe.suggestion}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowErrorDialog(false)}
                    className="shrink-0 text-zinc-500 hover:text-zinc-200 text-xl leading-none px-1"
                    title="关闭"
                  >
                    ×
                  </button>
                </div>

                {fe.details && (
                  <div className="px-5 py-3 flex-1 min-h-0 flex flex-col">
                    <div className="text-[11px] text-zinc-500 mb-1.5">
                      技术详情（提报 bug 时贴这段）
                    </div>
                    <pre className="flex-1 min-h-0 p-3 bg-red-950/40 rounded text-[11px] text-red-300/80 whitespace-pre-wrap break-all font-mono overflow-y-auto">
                      {fe.details}
                    </pre>
                  </div>
                )}

                <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800">
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(fe.details || error || "");
                    }}
                    className="px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 rounded"
                  >
                    复制详情
                  </button>
                  <button
                    onClick={() => setShowErrorDialog(false)}
                    className="px-4 py-1.5 bg-zinc-700 text-zinc-100 text-xs rounded font-medium"
                  >
                    关闭
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
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
            <div className="flex gap-2">
              <input
                type="text"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                placeholder="https://www.youtube.com/watch?v="
                className="flex-1 px-3 py-2 bg-zinc-800 text-zinc-100 rounded text-sm border border-zinc-700"
              />
              <button
                type="button"
                onClick={() => setShowHelp((v) => !v)}
                title="下载失败的常见原因"
                className={
                  "px-3 py-2 rounded text-sm font-bold w-10 " +
                  (showHelp
                    ? "bg-blue-500 text-black"
                    : "bg-zinc-700 text-zinc-100 hover:bg-zinc-600")
                }
              >
                ?
              </button>
            </div>
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
                <option value="best">原画（视频源最高画质）</option>
              </select>
            </div>
            {showHelp && (
              <div className="mt-3 p-3 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-300 leading-relaxed space-y-2 max-h-[60vh] overflow-y-auto">
                <div className="flex items-start justify-between gap-2 sticky top-0 -mx-3 -mt-3 px-3 pt-3 pb-2 bg-zinc-800 border-b border-zinc-700">
                  <div className="text-zinc-100 font-medium">下载失败常见原因</div>
                  <button
                    type="button"
                    onClick={() => setShowHelp(false)}
                    className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1"
                    title="关闭 (Esc)"
                  >
                    ×
                  </button>
                </div>

                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-amber-300">①  没有梯子（中国大陆）：</span>
                  </div>
                  <div className="mt-1">
                    YouTube / Bilibili 国际站等都需要梯子。yt-dlp 走系统代理（不是浏览器代理），请确认你的系统已配置 HTTP/SOCKS 代理或全局 VPN。
                  </div>
                  <div className="mt-1.5 px-2 py-1.5 rounded border border-rose-500/30 bg-rose-500/5 text-rose-200 text-[11px] leading-relaxed">
                    ⚠️ <span className="font-semibold">不要只开浏览器梯子</span>（比如 SwitchyOmega、Chrome / Edge 自带的代理扩展）——这种只在浏览器内生效，本软件读不到。必须用系统级代理 / 全局模式 / TUN 模式（Clash、v2rayN、Surge 等都有这个开关），让 <span className="font-semibold">本软件和浏览器走的是同一个梯子</span>。
                    <div className="mt-1 text-rose-300/80">
                      验证方法：浏览器关掉所有代理扩展后还能打开 youtube.com，就说明系统代理已生效，本软件也能用。
                    </div>
                  </div>
                  <div className="mt-1.5 text-zinc-500 text-[11px] leading-snug">
                    📋 报错示例：
                    <code className="bg-zinc-900 px-1 rounded text-zinc-400 break-all">
                      ERROR: Unable to download webpage: &lt;urlopen error [Errno 11001] getaddrinfo failed&gt;
                    </code>
                    {" "}/ <code className="bg-zinc-900 px-1 rounded text-zinc-400">connection timed out</code>
                    ，或长时间卡在「准备阶段」无进度。
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-amber-300">②  YouTube 需要 cookies：</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-medium">
                      🌟 最常见
                    </span>
                  </div>
                  <div className="mt-1">
                    即使有梯子，YouTube 检测到流量来自代理时会要求登录验证。这是绝大多数下载失败的原因——按下面 ③ 导出 cookies 后基本能解决。
                  </div>
                  <div className="mt-1.5 text-zinc-500 text-[11px] leading-snug">
                    📋 报错关键词：
                    <code className="bg-zinc-900 px-1 rounded text-rose-300">
                      Sign in to confirm you're not a bot
                    </code>
                    {" "}— 看到这条就 100% 是这个问题。
                  </div>
                </div>

                <div>
                  <span className="text-amber-300">③  导出 cookies.txt：</span>
                  <ol className="list-decimal list-inside mt-1 space-y-1 text-zinc-400">
                    <li>
                      Edge / Chrome 装扩展{" "}
                      <a
                        href="https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc"
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-300 underline"
                      >
                        Get cookies.txt LOCALLY
                      </a>
                    </li>
                    <li>登录 YouTube 网页</li>
                    <li>
                      点浏览器扩展按钮，再点 Get cookies.txt LOCALLY，弹窗里点
                      Export All Cookies 保存为 .txt 文件
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <img
                          src="/help/cookies-step3-extension.png"
                          alt="点扩展按钮"
                          className="rounded border border-zinc-700 w-full"
                        />
                        <img
                          src="/help/cookies-step3-export.png"
                          alt="Export All Cookies"
                          className="rounded border border-zinc-700 w-full"
                        />
                      </div>
                    </li>
                    <li>
                      回 app 设置页 → 「yt-dlp cookies 文件」选这个 .txt
                      <div className="mt-2">
                        <img
                          src="/help/cookies-step4-settings.png"
                          alt="设置页选 cookies 文件"
                          className="rounded border border-zinc-700 w-full"
                        />
                      </div>
                    </li>
                    <li>cookies 通常 1-2 周后过期，再失败时重新导出即可</li>
                  </ol>
                </div>

                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-amber-300">④  视频本身限制：</span>
                  </div>
                  <div className="mt-1">
                    会员/付费/年龄限制/区域锁定/已删除/私密视频 yt-dlp 也下不了，跟代理和 cookies 无关，只能换视频。
                  </div>
                  <div className="mt-1.5 text-zinc-500 text-[11px] leading-snug space-y-0.5">
                    <div>📋 报错关键词举例：</div>
                    <div>
                      <code className="bg-zinc-900 px-1 rounded text-zinc-400">Members-only video</code>
                      {" "}→ 频道会员专享
                    </div>
                    <div>
                      <code className="bg-zinc-900 px-1 rounded text-zinc-400">Sign in to confirm your age</code>
                      {" "}→ 18+ 年龄限制（需要已确认成年的账号 cookies）
                    </div>
                    <div>
                      <code className="bg-zinc-900 px-1 rounded text-zinc-400">not made this video available in your country</code>
                      {" "}→ 区域锁定
                    </div>
                    <div>
                      <code className="bg-zinc-900 px-1 rounded text-zinc-400">This video is private</code>
                      {" "}/{" "}
                      <code className="bg-zinc-900 px-1 rounded text-zinc-400">removed by the user</code>
                      {" "}→ 私密 / 已删除
                    </div>
                  </div>
                </div>

                <div className="text-zinc-500 text-[10px] pt-1">
                  当前 cookies 状态：
                  {settings.cookiesFile ? (
                    <span className="text-green-400 ml-1">已配置（{settings.cookiesFile.split(/[\\/]/).pop()}）</span>
                  ) : (
                    <span className="text-zinc-500 ml-1">未配置</span>
                  )}
                </div>
              </div>
            )}
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

        {error && <div className="mt-3 text-sm text-red-400">{error}</div>}

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
