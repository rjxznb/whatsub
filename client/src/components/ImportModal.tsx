import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../store/settings";
import { useLibrary } from "../store/library";
import { useAnalysis } from "../store/analysis";

interface Props {
  onClose: () => void;
}

type PipelineEventPayload =
  | { stage: "Started"; video_id: string }
  | { stage: "Downloading"; video_id: string; percent: number }
  | { stage: "ExtractingAudio"; video_id: string }
  | { stage: "Transcribing"; video_id: string; percent: number }
  | { stage: "Transcribed"; video_id: string; srt_path: string; duration_sec: number }
  | { stage: "Failed"; video_id: string; error: string }
  | { stage: "ModelDownload"; progress: number; total_mb: number; downloaded_mb: number };

type Phase = "idle" | "started" | "downloading" | "extracting" | "transcribing" | "done" | "error";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  started: "准备中...",
  downloading: "下载视频",
  extracting: "抽取音频",
  transcribing: "本地转录",
  done: "完成，跳转到播放页...",
  error: "失败",
};

export function ImportModal({ onClose }: Props) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { reload } = useLibrary();
  const { startFor } = useAnalysis();

  const [tab, setTab] = useState<"local" | "url">("url");
  const [urlValue, setUrlValue] = useState("");
  const [filePath, setFilePath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState<number>(0);

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
    setError(null);
  }

  // ------- Progress view -------
  if (submitting) {
    const showBar = phase === "downloading" || phase === "transcribing";
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-[480px] max-w-full">
          <h2 className="text-lg font-semibold text-zinc-100 mb-4">解析进行中</h2>

          <div className="space-y-3">
            {(["started", "downloading", "extracting", "transcribing", "done"] as Phase[]).map(
              (p) => (
                <div
                  key={p}
                  className={
                    "flex items-center gap-3 text-sm " +
                    (phase === p
                      ? "text-blue-300"
                      : phaseOrder(p) < phaseOrder(phase)
                      ? "text-green-400"
                      : "text-zinc-500")
                  }
                >
                  <span className="w-5">
                    {phaseOrder(p) < phaseOrder(phase)
                      ? "✓"
                      : phase === p
                      ? "▸"
                      : "○"}
                  </span>
                  <span className="flex-1">{PHASE_LABEL[p]}</span>
                  {phase === p && showBar && (
                    <span className="text-xs text-zinc-400">{percent}%</span>
                  )}
                </div>
              )
            )}
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
            <div className="mt-4 p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-200">
              <div className="font-medium mb-1">解析失败</div>
              <div className="text-xs whitespace-pre-wrap break-all">{error}</div>
            </div>
          )}

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
                placeholder="https://www.youtube.com/watch?v=..."
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
            {showHelp && (
              <div className="mt-3 p-3 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-300 leading-relaxed space-y-2">
                <div className="text-zinc-100 font-medium">下载失败常见原因</div>

                <div>
                  <span className="text-amber-300">①  没有梯子（中国大陆）：</span>
                  YouTube / Bilibili 国际站等都需要梯子。yt-dlp 走系统代理，请确认你的系统已配置 HTTP/SOCKS 代理或全局 VPN，浏览器能正常访问对应站点。
                </div>

                <div>
                  <span className="text-amber-300">②  YouTube 偶尔需要 cookies：</span>
                  即使有梯子，YouTube 检测到流量来自代理时会要求登录验证（"Sign in to confirm you're not a bot"），需要 cookies 通过。
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
                  <span className="text-amber-300">④  视频本身限制：</span>
                  会员/付费/年龄限制/区域锁定的视频 yt-dlp 也下不了，跟代理无关。
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
