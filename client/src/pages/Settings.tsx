import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettings } from "../store/settings";
import type { Settings, WhisperModelSize, LlmProvider } from "../types/settings";
import { SCENE_LABELS, type Scene, type Country } from "../llm/types";

const WHISPER_SIZES: WhisperModelSize[] = ["tiny", "base", "small", "medium", "large-v3"];

export function Settings() {
  const { settings, load, save } = useSettings();
  const [draft, setDraft] = useState<Settings>(settings);
  const [modelDownloaded, setModelDownloaded] = useState<Record<string, boolean>>({});
  const [downloading, setDownloading] = useState<WhisperModelSize | null>(null);
  const [downloadPct, setDownloadPct] = useState(0);
  const [testStatus, setTestStatus] = useState<string | null>(null);

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
              <Field
                label="API Key"
                type="password"
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
              <Field
                label="API Key"
                type="password"
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
              <Field
                label="API Key"
                type="password"
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

        <section>
          <h2 className="font-semibold mb-3">默认值</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              默认场景
              <select
                value={draft.defaultScene}
                onChange={(e) => setDraft({ ...draft, defaultScene: e.target.value as Scene })}
                className="w-full mt-1 px-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded"
              >
                {Object.entries(SCENE_LABELS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              默认国家
              <select
                value={draft.defaultCountry}
                onChange={(e) =>
                  setDraft({ ...draft, defaultCountry: e.target.value as Country })
                }
                className="w-full mt-1 px-2 py-1.5 bg-zinc-900 border border-zinc-800 rounded"
              >
                {(["US", "UK", "AU", "CA"] as const).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <button
          onClick={() => save(draft)}
          className="px-4 py-2 bg-blue-500 text-black font-medium rounded text-sm"
        >
          保存设置
        </button>
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
