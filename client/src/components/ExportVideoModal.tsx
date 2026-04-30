import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Subtitle } from "../llm/types";
import { subtitlesToAss } from "../utils/ass";
import { sanitizeFilename } from "../utils/srt";

interface Props {
  videoId: string;
  videoTitle: string;
  subtitles: Subtitle[];
  durationSec: number;
  onClose: () => void;
}

type ExportingEvent =
  | { stage: "Exporting"; video_id: string; percent: number }
  | { stage: "Exported"; video_id: string; output_path: string }
  | { stage: "Log"; video_id: string; source: string; line: string };

type Phase = "config" | "running" | "done" | "failed";

export function ExportVideoModal({
  videoId,
  videoTitle,
  subtitles,
  durationSec,
  onClose,
}: Props) {
  const [includeEnglish, setIncludeEnglish] = useState(true);
  const [includeChinese, setIncludeChinese] = useState(true);
  const [highlight, setHighlight] = useState(true);
  const [phase, setPhase] = useState<Phase>("config");
  const [percent, setPercent] = useState(0);
  const [outputPath, setOutputPath] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const cancelRef = useRef(false);

  // Subscribe to backend progress events. Mounted lazily once we kick off.
  useEffect(() => {
    if (phase !== "running") return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<ExportingEvent>("pipeline-event", (e) => {
      if (e.payload.video_id !== videoId) return;
      if (e.payload.stage === "Exporting") {
        setPercent(e.payload.percent);
      } else if (e.payload.stage === "Log") {
        const line = e.payload.line;
        setLogLines((prev) => {
          const next = prev.length >= 40 ? prev.slice(prev.length - 39) : prev.slice();
          next.push(line);
          return next;
        });
      }
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [phase, videoId]);

  const baseName = sanitizeFilename(videoTitle || videoId);
  const canRun = subtitles.length > 0 && (includeEnglish || includeChinese);

  async function start() {
    if (!canRun) return;
    const target = await save({
      defaultPath: `${baseName}.subtitled.mp4`,
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    });
    if (!target) return;

    const ass = subtitlesToAss(subtitles, {
      includeEnglish,
      includeChinese,
      highlightKeyPhrases: highlight,
    });

    cancelRef.current = false;
    setOutputPath(target);
    setPercent(0);
    setErrorMsg("");
    setLogLines([]);
    setPhase("running");

    try {
      await invoke("export_burned_video", {
        videoId,
        assContent: ass,
        outputPath: target,
        durationSec,
      });
      if (!cancelRef.current) {
        setPercent(100);
        setPhase("done");
      } else {
        // Cancelled — close silently.
        onClose();
      }
    } catch (e) {
      if (cancelRef.current) {
        onClose();
        return;
      }
      setErrorMsg(String(e));
      setPhase("failed");
    }
  }

  async function cancel() {
    cancelRef.current = true;
    try {
      await invoke("cancel_export");
    } catch {
      // ignore
    }
  }

  async function revealAndClose() {
    try {
      // Best-effort: open the parent folder. opener plugin handles cross-platform.
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(outputPath);
    } catch {
      // ignore — user can find it themselves
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[100]">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 w-[460px]">
        <h2 className="text-base font-semibold text-zinc-100 mb-4">
          导出带字幕视频
        </h2>

        {phase === "config" && (
          <>
            <div className="space-y-2 text-sm text-zinc-200">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeEnglish}
                  onChange={(e) => setIncludeEnglish(e.target.checked)}
                  className="accent-blue-500"
                />
                烧录英文字幕
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeChinese}
                  onChange={(e) => setIncludeChinese(e.target.checked)}
                  className="accent-blue-500"
                />
                烧录中文字幕
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={highlight}
                  onChange={(e) => setHighlight(e.target.checked)}
                  className="accent-blue-500"
                />
                高亮重点短语（黄色）
              </label>
            </div>
            <div className="mt-3 text-[11px] leading-relaxed text-zinc-500">
              视频会重新编码（H.264 + AAC，192 kbps 立体声），耗时大约为视频长度的 1-2 倍。
              鼠标悬浮在重点上的解析框不会烧录到视频里。
            </div>
            {!canRun && subtitles.length === 0 && (
              <div className="mt-2 text-xs text-amber-300">
                字幕未生成完毕，无法导出
              </div>
            )}
            {!canRun && subtitles.length > 0 && (
              <div className="mt-2 text-xs text-amber-300">
                请至少选择一种字幕语言
              </div>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-zinc-300"
              >
                取消
              </button>
              <button
                onClick={start}
                disabled={!canRun}
                className="px-4 py-1.5 bg-blue-500 text-black text-sm rounded font-medium disabled:opacity-50"
              >
                开始导出
              </button>
            </div>
          </>
        )}

        {phase === "running" && (
          <div>
            <div className="text-sm text-zinc-200 mb-2">
              {percent === 0 && logLines.length === 0
                ? "正在启动 ffmpeg…"
                : `正在导出… ${percent}%`}
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-zinc-500 truncate" title={outputPath}>
              输出：{outputPath}
            </div>
            {logLines.length > 0 && (
              <pre className="mt-2 text-[10px] leading-tight text-zinc-500 bg-zinc-950 border border-zinc-800 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
                {logLines.slice(-12).join("\n")}
              </pre>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={cancel}
                className="px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-800 rounded"
              >
                取消导出
              </button>
            </div>
          </div>
        )}

        {phase === "done" && (
          <div>
            <div className="text-sm text-zinc-100 mb-2">✓ 导出完成</div>
            <div className="text-[11px] text-zinc-500 truncate" title={outputPath}>
              {outputPath}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-zinc-300"
              >
                关闭
              </button>
              <button
                onClick={revealAndClose}
                className="px-4 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
              >
                在文件夹中显示
              </button>
            </div>
          </div>
        )}

        {phase === "failed" && (
          <div>
            <div className="text-sm text-red-400 mb-2">导出失败</div>
            <pre className="text-[11px] text-zinc-400 bg-zinc-950 border border-zinc-800 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">
              {errorMsg}
            </pre>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-zinc-300"
              >
                关闭
              </button>
              <button
                onClick={() => {
                  setPhase("config");
                  setErrorMsg("");
                }}
                className="px-4 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
              >
                重试
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
