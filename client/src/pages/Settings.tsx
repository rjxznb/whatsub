import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ExternalLink, Check, Pause, Play, Download } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSettings } from "../store/settings";
import type { Settings, WhisperModelSize } from "../types/settings";
import { VENDORS, getVendor, inferVendorId } from "../llm/vendors";
import { MODEL_TIERS, formatModelSize } from "../llm/modelTiers";
import { useUpdater } from "../hooks/useUpdater";
import { getVersion } from "@tauri-apps/api/app";

export function Settings() {
  const { settings, load, save } = useSettings();
  const [draft, setDraft] = useState<Settings>(settings);
  const [modelDownloaded, setModelDownloaded] = useState<Record<string, boolean>>({});
  const [modelPartialPct, setModelPartialPct] = useState<Record<string, number>>({});
  const [downloading, setDownloading] = useState<WhisperModelSize | null>(null);
  const [downloadPct, setDownloadPct] = useState(0);
  const [downloadPaused, setDownloadPaused] = useState<WhisperModelSize | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    Promise.all(
      MODEL_TIERS.map(async (t) => {
        const [ok, partialBytes] = await Promise.all([
          invoke<boolean>("whisper_model_status", { size: t.size }),
          invoke<number>("whisper_model_partial_size", { size: t.size }),
        ]);
        const totalBytes = t.sizeMB * 1024 * 1024;
        const p = totalBytes > 0 ? Math.floor((partialBytes / totalBytes) * 100) : 0;
        return [t.size, ok, p] as const;
      })
    ).then((results) => {
      const dl: Record<string, boolean> = {};
      const pp: Record<string, number> = {};
      for (const [s, ok, p] of results) {
        dl[s] = ok;
        pp[s] = p;
      }
      setModelDownloaded(dl);
      setModelPartialPct(pp);
    });
  }, [downloading, downloadPaused]);

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
    setDownloadPaused(null);
    // If resuming a paused tier, the % already reflects the partial; otherwise
    // reset to 0 and let the first event update it.
    if (downloadPaused !== size) setDownloadPct(0);
    try {
      await invoke("whisper_model_download", { size });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Rust returns AppError::Other("cancelled") on user pause — treat as
      // a paused state instead of a hard error so 继续 can resume from .partial.
      if (msg.toLowerCase().includes("cancelled")) {
        setDownloadPaused(size);
      } else {
        console.error("model download failed", e);
        alert(`下载失败：${msg}`);
      }
    } finally {
      setDownloading(null);
    }
  }

  async function pauseDownload() {
    await invoke("whisper_model_download_cancel");
    // The downloadModel() promise will reject shortly; its catch sets paused.
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
        <Link
          to="/"
          title="返回 Library"
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
        >
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold">设置</h1>
      </header>

      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <section>
          <h2 className="font-semibold mb-3">LLM Provider</h2>
          <VendorSection draft={draft} setDraft={setDraft} />

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
              defaultHint="默认：%APPDATA%/whatsub/library"
              onChange={(v) => setDraft({ ...draft, libraryDir: v })}
            />
            <DirField
              label="Whisper 模型目录"
              value={draft.modelsDir}
              defaultHint="默认：%APPDATA%/whatsub/models"
              onChange={(v) => setDraft({ ...draft, modelsDir: v })}
            />
            <FileField
              label="yt-dlp cookies 文件（可选）"
              value={draft.cookiesFile}
              defaultHint="未设置（YouTube 偶尔需要 cookies 才能下载）"
              filterName="cookies.txt"
              filterExt={["txt"]}
              onChange={(v) => setDraft({ ...draft, cookiesFile: v })}
            />
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              ⚠ 修改视频/模型目录不会自动迁移已有文件，但已存在条目会保留原位（不会丢失）。如需集中管理，请手动把它们移到新路径并相应修改 library.json。
            </p>
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-1">字幕识别引擎</h2>
          <p className="text-[11px] text-zinc-500 mb-3 leading-relaxed">
            从视频里识别出英文字幕。质量越高、文件越大、占的硬盘越多。可以下载多个版本随时切换。
          </p>
          <div className="space-y-1.5">
            {MODEL_TIERS.map((t) => {
              const isActive = t.size === draft.whisperModel;
              const isDownloaded = modelDownloaded[t.size];
              const partial = modelPartialPct[t.size] ?? 0;
              const isCurrentDownload = downloading === t.size;
              const isPausedHere = downloadPaused === t.size;
              const lockedDuringDownload = downloading !== null && downloading !== t.size;
              return (
                <label
                  key={t.size}
                  className={
                    "flex items-start gap-3 p-3 rounded border text-left transition " +
                    (isActive
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-zinc-800 hover:border-zinc-700") +
                    (lockedDuringDownload ? " opacity-40 cursor-not-allowed" : " cursor-pointer")
                  }
                >
                  <input
                    type="radio"
                    name="whisper-tier"
                    checked={isActive}
                    disabled={lockedDuringDownload}
                    onChange={() =>
                      setDraft({ ...draft, whisperModel: t.size })
                    }
                    className="mt-1 accent-blue-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{t.name}</span>
                      <span className="text-[11px] text-zinc-500">
                        {formatModelSize(t.sizeMB)}
                      </span>
                      {t.recommended && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                          推荐
                        </span>
                      )}
                      {isDownloaded ? (
                        <span className="ml-auto text-[11px] text-green-400 inline-flex items-center gap-1">
                          <Check className="h-3.5 w-3.5" /> 已下载
                        </span>
                      ) : isPausedHere || (partial > 0 && !isCurrentDownload) ? (
                        <span className="ml-auto text-[11px] text-amber-400">
                          已下载 {isPausedHere ? downloadPct : partial}%
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">
                      {t.description}
                    </p>

                    {/* Action row for THIS tier when it's selected as the
                        active draft and either not yet downloaded, or being
                        actively downloaded / paused. */}
                    {isActive && !isDownloaded && (
                      <div className="mt-2.5">
                        {isCurrentDownload ? (
                          <div>
                            <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
                              <div
                                className="h-full bg-blue-500 transition-all duration-200"
                                style={{ width: `${downloadPct}%` }}
                              />
                            </div>
                            <div className="flex items-center justify-between mt-1.5 gap-2">
                              <span className="text-[11px] text-zinc-400">
                                下载中 {downloadPct}%
                              </span>
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  pauseDownload();
                                }}
                                className="text-[11px] px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 rounded inline-flex items-center gap-1"
                              >
                                <Pause className="h-3 w-3" /> 暂停
                              </button>
                            </div>
                          </div>
                        ) : isPausedHere ? (
                          <div>
                            <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
                              <div
                                className="h-full bg-amber-500"
                                style={{ width: `${downloadPct}%` }}
                              />
                            </div>
                            <div className="flex items-center justify-between mt-1.5 gap-2">
                              <span className="text-[11px] text-amber-400">
                                已暂停（{downloadPct}%）
                              </span>
                              <button
                                onClick={(e) => {
                                  e.preventDefault();
                                  downloadModel(t.size);
                                }}
                                className="text-[11px] px-2.5 py-1 bg-blue-500 hover:bg-blue-400 text-black rounded inline-flex items-center gap-1"
                              >
                                <Play className="h-3 w-3" /> 继续
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              downloadModel(t.size);
                            }}
                            disabled={downloading !== null}
                            className="text-[11px] px-2.5 py-1 bg-blue-500 hover:bg-blue-400 text-black rounded inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <Download className="h-3 w-3" />
                            {partial > 0 ? `继续下载（已 ${partial}%）` : "下载"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          <div className="mt-3 text-xs">
            <span className="text-zinc-500">GPU 加速：</span>
            {draft.whisperBackend ? (
              <span
                className={
                  draft.whisperBackend.startsWith("CPU")
                    ? "text-zinc-300"
                    : "text-emerald-400 font-medium"
                }
              >
                {draft.whisperBackend.startsWith("CPU") ? "❌ 仅 CPU" : `✅ ${draft.whisperBackend}`}
              </span>
            ) : (
              <span className="text-zinc-500 italic">
                未检测（首次解析视频后自动识别）
              </span>
            )}
          </div>
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

        <UpdateSection />
      </div>
    </div>
  );
}

function UpdateSection() {
  const { status, checkNow, downloadAndInstall } = useUpdater();
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);
  return (
    <section className="border-t border-zinc-800 pt-6">
      <h2 className="font-semibold mb-3">应用版本</h2>
      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-400 tabular-nums">
          v{appVersion || "0.0.0"}
        </span>
        <button
          onClick={() => void checkNow()}
          disabled={status.type === "checking" || status.type === "downloading"}
          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-sm rounded disabled:opacity-50"
        >
          {status.type === "checking" ? "检查中..." : "检查更新"}
        </button>
        {status.type === "available" && (
          <button
            onClick={() => void downloadAndInstall()}
            className="px-3 py-1.5 bg-blue-500 text-black text-sm rounded font-medium"
          >
            更新到 v{status.update.version}
          </button>
        )}
        {status.type === "none" && (
          <span className="text-sm text-green-400">✓ 已是最新版本</span>
        )}
        {status.type === "error" && (
          <span className="text-xs text-red-400" title={status.message}>
            ✗ 检查失败
          </span>
        )}
        {status.type === "downloading" && (
          <span className="text-xs text-blue-300 tabular-nums">
            下载中 {status.percent.toFixed(0)}%
          </span>
        )}
        {status.type === "installing" && (
          <span className="text-xs text-blue-300">安装中，即将重启...</span>
        )}
      </div>
    </section>
  );
}

/**
 * Vendor preset dropdown + auto-filled fields.
 * The user picks a vendor (DeepSeek / OpenAI / Claude / etc.); we derive
 * `llmProvider` (protocol) and `baseUrl` from the preset. API key and model
 * are stored under the matching protocol slot in Settings (so switching among
 * protocols preserves keys; switching between OpenAI-compatible vendors shares
 * the same slot — that's a known UX limitation we may revisit later).
 */
function VendorSection({
  draft,
  setDraft,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
}) {
  const vendorId =
    draft.vendorId ?? inferVendorId(draft.llmProvider, draft.openaiCompatible.baseUrl);
  const vendor = getVendor(vendorId) ?? VENDORS[0];

  function pickVendor(id: string) {
    const v = getVendor(id);
    if (!v) return;
    const next: Settings = {
      ...draft,
      vendorId: v.id,
      llmProvider: v.protocol,
    };
    if (v.protocol === "openai-compatible") {
      // Auto-fill baseUrl for known vendors; leave editable for "custom".
      next.openaiCompatible = {
        ...draft.openaiCompatible,
        baseUrl: v.baseUrl || draft.openaiCompatible.baseUrl,
      };
    }
    setDraft(next);
  }

  // Read/write the active key+model regardless of which protocol slot stores it.
  const activeKey =
    vendor.protocol === "claude"
      ? draft.claude.apiKey
      : vendor.protocol === "gemini"
      ? draft.gemini.apiKey
      : draft.openaiCompatible.apiKey;
  const activeModel =
    vendor.protocol === "claude"
      ? draft.claude.model
      : vendor.protocol === "gemini"
      ? draft.gemini.model
      : draft.openaiCompatible.model;

  function setActiveKey(v: string) {
    if (vendor.protocol === "claude") {
      setDraft({ ...draft, claude: { ...draft.claude, apiKey: v } });
    } else if (vendor.protocol === "gemini") {
      setDraft({ ...draft, gemini: { ...draft.gemini, apiKey: v } });
    } else {
      setDraft({
        ...draft,
        openaiCompatible: { ...draft.openaiCompatible, apiKey: v },
      });
    }
  }
  function setActiveModel(v: string) {
    if (vendor.protocol === "claude") {
      setDraft({ ...draft, claude: { ...draft.claude, model: v } });
    } else if (vendor.protocol === "gemini") {
      setDraft({ ...draft, gemini: { ...draft.gemini, model: v } });
    } else {
      setDraft({
        ...draft,
        openaiCompatible: { ...draft.openaiCompatible, model: v },
      });
    }
  }

  const isCustom = vendor.id === "custom";
  const showBaseUrl = vendor.protocol === "openai-compatible";

  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm text-zinc-300 block">
          模型厂商
          <select
            value={vendor.id}
            onChange={(e) => pickVendor(e.target.value)}
            className="w-full mt-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-sm text-zinc-100"
          >
            {VENDORS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {showBaseUrl && (
        <div>
          <label className="text-sm text-zinc-300 block">
            Base URL
            <input
              type="text"
              value={
                isCustom
                  ? draft.openaiCompatible.baseUrl
                  : vendor.baseUrl
              }
              readOnly={!isCustom}
              onChange={(e) =>
                isCustom &&
                setDraft({
                  ...draft,
                  openaiCompatible: {
                    ...draft.openaiCompatible,
                    baseUrl: e.target.value,
                  },
                })
              }
              placeholder={isCustom ? "https://your-proxy.example.com/v1" : ""}
              className={
                "w-full mt-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 " +
                (isCustom ? "" : "cursor-default")
              }
            />
          </label>
        </div>
      )}

      <SecretField
        label="API Key"
        value={activeKey}
        onChange={setActiveKey}
      />
      {vendor.keyConsoleUrl && (
        <a
          href={vendor.keyConsoleUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300"
        >
          获取 / 管理 API Key <ExternalLink className="h-3 w-3" />
        </a>
      )}

      <div>
        <label className="text-sm text-zinc-300 block">
          Model
          <input
            type="text"
            value={activeModel}
            list={`models-${vendor.id}`}
            onChange={(e) => setActiveModel(e.target.value)}
            placeholder={vendor.models[0] ?? "model name"}
            className="w-full mt-1 px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100"
          />
          {vendor.models.length > 0 && (
            <datalist id={`models-${vendor.id}`}>
              {vendor.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          )}
        </label>
        {vendor.models.length > 0 && (
          <div className="text-[10px] text-zinc-500 mt-1">
            可点输入框右侧 ▾ 选预设模型，或手动输入其它模型名
          </div>
        )}
      </div>

      {vendor.note && (
        <div className="text-[11px] text-zinc-400 italic bg-zinc-900/40 border-l-2 border-zinc-700 px-3 py-1.5 rounded-r">
          {vendor.note}
        </div>
      )}
    </div>
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
            清除
          </button>
        )}
      </div>
    </label>
  );
}

function FileField({
  label,
  value,
  defaultHint,
  filterName,
  filterExt,
  onChange,
}: {
  label: string;
  value: string;
  defaultHint: string;
  filterName: string;
  filterExt: string[];
  onChange: (v: string) => void;
}) {
  async function pickFile() {
    const result = await openDialog({
      directory: false,
      multiple: false,
      filters: [{ name: filterName, extensions: filterExt }],
    });
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
          onClick={pickFile}
          className="px-3 py-1.5 bg-zinc-700 text-zinc-100 rounded text-sm hover:bg-zinc-600"
        >
          选择...
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="清除"
            className="px-3 py-1.5 bg-zinc-800 text-zinc-300 rounded text-sm hover:bg-zinc-700"
          >
            清除
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
