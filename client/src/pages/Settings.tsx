import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSettings } from "../store/settings";
import type { Settings, WhisperModelSize, LlmProvider } from "../types/settings";

const WHISPER_SIZES: WhisperModelSize[] = ["tiny", "base", "small", "medium", "large-v3"];

export function Settings() {
  const { settings, load, save } = useSettings();
  const [draft, setDraft] = useState<Settings>(settings);
  const [modelDownloaded, setModelDownloaded] = useState<Record<string, boolean>>({});
  const [downloading, setDownloading] = useState<WhisperModelSize | null>(null);
  const [downloadPct, setDownloadPct] = useState(0);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    Promise.all(
      WHISPER_SIZES.map(
        async (s) =>
          [s, await invoke<boolean>("whisper_model_status", { size: s })] as const
      )
    ).then((results) => {
      const map: Record<string, boolean> = {};
      for (const [s, ok] of results) map[s] = ok;
      setModelDownloaded(map);
    });
  }, [downloading]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ stage: string; progress?: number }>("pipeline-event", (e) => {
      if (e.payload.stage === "ModelDownload" && typeof e.payload.progress === "number") {
        setDownloadPct(e.payload.progress);
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  async function downloadModel(size: WhisperModelSize) {
    setDownloading(size);
    setDownloadPct(0);
    try {
      await invoke("whisper_model_download", { size });
    } catch (e) {
      // Reset model state so a partial file doesn't show as "downloaded"
      console.error("model download failed", e);
      alert(`下载失败：${e}`);
    } finally {
      setDownloading(null);
    }
  }

  async function testConnection() {
    setTestStatus("测试中...");
    try {
      const { getProvider } = await import("../llm/providers");
      const p = getProvider(draft);
      let ok = false;
      for await (const _ of p.stream({
        systemPrompt: "Reply with 'ok'.",
        userPrompt: "ok",
      })) {
        ok = true;
        break;
      }
      setTestStatus(ok ? "✓ 连接成功" : "✗ 无响应");
    } catch (e) {
      setTestStatus(`✗ ${e}`);
    }
  }

  async function handleSave() {
    setSaveStatus({ ok: true, msg: "保存中..." });
    try {
      // If libraryDir is changing, freeze the path of any existing entries that
      // don't yet have a videoDir set. This must happen BEFORE save_settings,
      // so the freeze uses the OLD library_dir() value — old videos stay where
      // they are, new imports use the new path.
      if (settings.libraryDir !== draft.libraryDir) {
        const frozen = await invoke<number>("library_freeze_paths");
        if (frozen > 0) {
          console.log(`Froze ${frozen} legacy entries to old library dir`);
        }
      }
      await save(draft);
      setSaveStatus({ ok: true, msg: "✓ 已保存" });
      setTimeout(() => setSaveStatus(null), 2500);
    } catch (e) {
      console.error("save failed", e);
      setSaveStatus({ ok: false, msg: `✗ 保存失败：${e}` });
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-zinc-800">
        <Link to="/" className="text-zinc-400 hover:text-zinc-100">
          ◀ Back
        </Link>
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <section>
          <h2 className="font-semibold mb-3">LLM Provider</h2>
          <select
            value={draft.llmProvider}
            onChange={(e) => setDraft({ ...draft, llmProvider: e.target.value as LlmProvider })}
            className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm"
          >
            <option value="openai-compatible">OpenAI 兼容协议</option>
            <option value="claude">Claude (Anthropic)</option>
            <option value="gemini">Gemini (Google)</option>
          </select>

          {draft.llmProvider === "openai-compatible" && (
            <div className="grid grid-cols-1 gap-3 mt-3">
              <Field
                label="Base URL"
                value={draft.openaiCompatible.baseUrl}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    openaiCompatible: { ...draft.openaiCompatible, baseUrl: v },
                  })
                }
              />
              <SecretField
                label="API Key"
                value={draft.openaiCompatible.apiKey}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    openaiCompatible: { ...draft.openaiCompatible, apiKey: v },
                  })
                }
              />
              <Field
                label="Model"
                value={draft.openaiCompatible.model}
                onChange={(v) =>
                  setDraft({
                    ...draft,
                    openaiCompatible: { ...draft.openaiCompatible, model: v },
                  })
                }
              />
            </div>
          )}

          {draft.llmProvider === "claude" && (
            <div className="grid grid-cols-1 gap-3 mt-3">
              <SecretField
                label="API Key"
                value={draft.claude.apiKey}
                onChange={(v) => setDraft({ ...draft, claude: { ...draft.claude, apiKey: v } })}
              />
              <Field
                label="Model"
                value={draft.claude.model}
                onChange={(v) => setDraft({ ...draft, claude: { ...draft.claude, model: v } })}
              />
            </div>
          )}

          {draft.llmProvider === "gemini" && (
            <div className="grid grid-cols-1 gap-3 mt-3">
              <SecretField
                label="API Key"
                value={draft.gemini.apiKey}
                onChange={(v) => setDraft({ ...draft, gemini: { ...draft.gemini, apiKey: v } })}
              />
              <Field
                label="Model"
                value={draft.gemini.model}
                onChange={(v) => setDraft({ ...draft, gemini: { ...draft.gemini, model: v } })}
              />
            </div>
          )}

          <div className="flex items-center gap-3 mt-3">
            <button
              onClick={testConnection}
              className="px-3 py-1.5 bg-zinc-800 text-sm rounded"
            >
              测试连接
            </button>
            {testStatus && <span className="text-sm text-zinc-400">{testStatus}</span>}
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-3">存储路径</h2>
          <div className="space-y-3">
            <DirField
              label="视频/字幕/分析文件目录"
              value={draft.libraryDir}
              defaultHint="默认：%APPDATA%/Get_Video/library"
              onChange={(v) => setDraft({ ...draft, libraryDir: v })}
            />
            <DirField
              label="Whisper 模型目录"
              value={draft.modelsDir}
              defaultHint="默认：%APPDATA%/Get_Video/models"
              onChange={(v) => setDraft({ ...draft, modelsDir: v })}
            />
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              ⚠ 修改路径不会自动迁移已有文件。如需保留历史视频/模型，请先手动把它们移到新路径下。否则旧条目会显示为找不到。
            </p>
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-3">Whisper 模型</h2>
          <select
            value={draft.whisperModel}
            onChange={(e) =>
              setDraft({ ...draft, whisperModel: e.target.value as WhisperModelSize })
            }
            className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm"
          >
            {WHISPER_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} {modelDownloaded[s] ? "(已下载)" : "(未下载)"}
              </option>
            ))}
          </select>
          {!modelDownloaded[draft.whisperModel] && (
            <button
              onClick={() => downloadModel(draft.whisperModel)}
              disabled={downloading !== null}
              className="ml-3 px-3 py-1.5 bg-blue-500 text-black text-sm rounded disabled:opacity-50"
            >
              {downloading === draft.whisperModel ? `下载中 ${downloadPct}%` : "下载"}
            </button>
          )}
        </section>

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-500 text-black font-medium rounded text-sm"
          >
            保存设置
          </button>
          {saveStatus && (
            <span
              className={
                "text-sm " + (saveStatus.ok ? "text-green-400" : "text-red-400")
              }
            >
              {saveStatus.msg}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="text-sm text-zinc-300">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full mt-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100"
      />
    </label>
  );
}

function DirField({
  label,
  value,
  defaultHint,
  onChange,
}: {
  label: string;
  value: string;
  defaultHint: string;
  onChange: (v: string) => void;
}) {
  async function pickDir() {
    const result = await openDialog({ directory: true, multiple: false });
    if (typeof result === "string") onChange(result);
  }
  return (
    <label className="text-sm text-zinc-300 block">
      {label}
      <div className="mt-1 flex gap-2">
        <input
          type="text"
          value={value}
          readOnly
          placeholder={defaultHint}
          className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 placeholder:text-zinc-600"
        />
        <button
          type="button"
          onClick={pickDir}
          className="px-3 py-1.5 bg-zinc-700 text-zinc-100 rounded text-sm hover:bg-zinc-600"
        >
          选择...
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="重置为默认"
            className="px-3 py-1.5 bg-zinc-800 text-zinc-300 rounded text-sm hover:bg-zinc-700"
          >
            重置
          </button>
        )}
      </div>
    </label>
  );
}

/**
 * Password input with a toggle eye button to reveal the value.
 */
function SecretField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <label className="text-sm text-zinc-300">
      {label}
      <div className="mt-1 flex items-stretch border border-zinc-800 rounded bg-zinc-900 focus-within:border-zinc-600">
        <input
          type={reveal ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 px-3 py-1.5 bg-transparent text-zinc-100 outline-none"
          placeholder={value ? "" : "未设置"}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          title={reveal ? "隐藏" : "显示"}
          className="px-3 text-zinc-400 hover:text-zinc-100 select-none"
        >
          {reveal ? "🙈" : "👁"}
        </button>
      </div>
      {value && !reveal && (
        <div className="text-[10px] text-zinc-500 mt-1">已保存（{value.length} 字符）</div>
      )}
    </label>
  );
}
