import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../store/settings";
import { useLibrary } from "../store/library";
import { useAnalysis } from "../store/analysis";
import { SCENE_LABELS, type Scene, type Country } from "../llm/types";

interface Props {
  onClose: () => void;
}

export function ImportModal({ onClose }: Props) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { reload } = useLibrary();
  const { startFor } = useAnalysis();

  const [tab, setTab] = useState<"local" | "url">("url");
  const [urlValue, setUrlValue] = useState("");
  const [filePath, setFilePath] = useState("");
  const [scene, setScene] = useState<Scene>(settings.defaultScene);
  const [country, setCountry] = useState<Country>(settings.defaultCountry);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickFile() {
    const result = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "webm", "avi"] }],
    });
    if (typeof result === "string") setFilePath(result);
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const sourceKind = tab;
      const sourceValue = tab === "url" ? urlValue : filePath;
      if (!sourceValue) throw new Error(tab === "url" ? "请输入 URL" : "请选择文件");

      onClose();
      const result = await invoke<{ videoId: string; srtPath: string; durationSec: number }>(
        "import_video",
        {
          req: {
            sourceKind,
            sourceValue,
            scene,
            country,
            whisperModel: settings.whisperModel,
          },
        }
      );
      startFor(result.videoId);
      await reload();
      navigate(`/player/${result.videoId}?srt=${encodeURIComponent(result.srtPath)}`);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  }

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
          <input
            type="text"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            className="w-full px-3 py-2 bg-zinc-800 text-zinc-100 rounded text-sm border border-zinc-700"
          />
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

        <div className="grid grid-cols-2 gap-3 mt-4">
          <label className="text-sm text-zinc-300">
            场景
            <select
              value={scene}
              onChange={(e) => setScene(e.target.value as Scene)}
              className="w-full mt-1 px-2 py-1.5 bg-zinc-800 text-zinc-100 rounded border border-zinc-700"
            >
              {Object.entries(SCENE_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-zinc-300">
            国家
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value as Country)}
              className="w-full mt-1 px-2 py-1.5 bg-zinc-800 text-zinc-100 rounded border border-zinc-700"
            >
              {(["US", "UK", "AU", "CA"] as const).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <div className="mt-3 text-sm text-red-400">{error}</div>}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-300">
            取消
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-4 py-1.5 bg-blue-500 text-black text-sm rounded font-medium disabled:opacity-50"
          >
            {submitting ? "处理中..." : "开始解析"}
          </button>
        </div>
      </div>
    </div>
  );
}
