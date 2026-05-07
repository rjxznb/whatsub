import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ExternalLink, Check, Pause, Play, Download, Eye, EyeOff, ChevronDown } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useSettings } from "../store/settings";
import type { Settings, WhisperModelSize } from "../types/settings";
import { VENDORS, getVendor, inferVendorId } from "../llm/vendors";
import { MODEL_TIERS, formatModelSize } from "../llm/modelTiers";
import { useModelDownload } from "../store/modelDownload";
import { useUpdater } from "../hooks/useUpdater";
import { getVersion } from "@tauri-apps/api/app";

export function Settings() {
  const { settings, load, save } = useSettings();
  const [draft, setDraft] = useState<Settings>(settings);
  const [modelDownloaded, setModelDownloaded] = useState<Record<string, boolean>>({});
  const [modelPartialPct, setModelPartialPct] = useState<Record<string, number>>({});
  // Whisper download state lives in a global Zustand store so navigating
  // away from Settings (e.g. back to Library) doesn't drop the in-flight
  // invoke / progress listener. Component unmount = no UI; download keeps
  // running; come back, store still has the live phase + pct.
  const {
    phase: dlPhase,
    activeSize: dlActive,
    pct: downloadPct,
    start: startDownload,
    pause: pauseDownload,
  } = useModelDownload();
  const downloading = dlPhase === "downloading" ? dlActive : null;
  const downloadPaused = dlPhase === "paused" ? dlActive : null;
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

  // The pipeline-event listener for ModelDownload progress is set up once
  // inside the modelDownload store on first start() — no per-component
  // listen needed here.

  function downloadModel(size: WhisperModelSize) {
    // Fire-and-forget: the store keeps the in-flight invoke alive across
    // navigation. We don't await here so the click handler returns
    // immediately; phase/pct updates flow through the store subscription.
    void startDownload(size);
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
          <h2 className="font-semibold mb-3">翻译服务</h2>
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
              label="视频和字幕保存位置"
              value={draft.libraryDir}
              defaultHint="默认：%APPDATA%/whatsub/library"
              onChange={(v) => setDraft({ ...draft, libraryDir: v })}
            />
            <FileField
              label="YouTube cookies.txt 路径（可选）"
              value={draft.cookiesFile}
              defaultHint="未设置（YouTube 偶尔要求登录验证；按导入页的「?」按钮里的教程导出 cookies.txt 后选到这里）"
              filterName="cookies.txt"
              filterExt={["txt"]}
              onChange={(v) => setDraft({ ...draft, cookiesFile: v })}
            />
            <p className="text-[10px] text-zinc-500 leading-relaxed">
              ⚠ 改了保存位置不会自动搬已有的视频文件，但已经在的视频不会丢，会留在原来的位置正常使用。要集中管理的话请手动把文件移到新路径。
            </p>
          </div>
        </section>

        <section>
          <h2 className="font-semibold mb-3">字幕识别引擎</h2>
          {(() => {
            // Single-row dropdown + action, then description + (optional)
            // progress bar underneath. Replaces the previous stacked tier
            // cards which ate ~200 lines of vertical space when the user
            // mostly just wants to swap which model's active.
            //
            // Lock the dropdown while a download is in flight — switching
            // the draft mid-download would hide the in-progress tier from
            // its own progress bar (we render the bar based on the active
            // draft tier matching `downloading`).
            const current = MODEL_TIERS.find((t) => t.size === draft.whisperModel);
            if (!current) return null;
            const isCurrentDownloaded = modelDownloaded[current.size];
            const isCurrentDownload = downloading === current.size;
            const isPausedHere = downloadPaused === current.size;
            const currentPartial = modelPartialPct[current.size] ?? 0;
            const downloadInFlight = downloading !== null;

            // Compact suffix shown next to each option in the dropdown so
            // the user can see download status without first selecting.
            function statusSuffix(t: (typeof MODEL_TIERS)[number]): string {
              if (modelDownloaded[t.size]) return "✓ 已下载";
              const p = modelPartialPct[t.size] ?? 0;
              if (p > 0) return `已下载 ${p}%`;
              return formatModelSize(t.sizeMB);
            }

            return (
              <>
                <div className="flex items-center gap-2">
                  <select
                    value={draft.whisperModel}
                    disabled={downloadInFlight}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        whisperModel: e.target.value as WhisperModelSize,
                      })
                    }
                    className="flex-1 px-3 py-2 bg-zinc-950 border border-zinc-800 rounded text-sm disabled:opacity-50"
                  >
                    {MODEL_TIERS.map((t) => (
                      <option key={t.size} value={t.size}>
                        {t.name}
                        {t.recommended ? "（推荐）" : ""} · {statusSuffix(t)}
                      </option>
                    ))}
                  </select>

                  {/* Right-side action: the dropdown handles selection, this
                      slot just shows the verb for the active tier (download /
                      pause / resume / done). */}
                  {isCurrentDownloaded ? (
                    <span className="text-[11px] text-green-400 inline-flex items-center gap-1 px-2 shrink-0">
                      <Check className="h-3.5 w-3.5" /> 已下载
                    </span>
                  ) : isCurrentDownload ? (
                    <button
                      onClick={pauseDownload}
                      className="text-[11px] px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded inline-flex items-center gap-1 shrink-0"
                    >
                      <Pause className="h-3 w-3" /> 暂停
                    </button>
                  ) : isPausedHere ? (
                    <button
                      onClick={() => downloadModel(current.size)}
                      className="text-[11px] px-3 py-2 bg-blue-500 hover:bg-blue-400 text-black rounded inline-flex items-center gap-1 shrink-0"
                    >
                      <Play className="h-3 w-3" /> 继续
                    </button>
                  ) : (
                    <button
                      onClick={() => downloadModel(current.size)}
                      disabled={downloadInFlight}
                      className="text-[11px] px-3 py-2 bg-blue-500 hover:bg-blue-400 text-black rounded inline-flex items-center gap-1 shrink-0 disabled:opacity-50"
                    >
                      <Download className="h-3 w-3" />
                      {currentPartial > 0 ? `继续 (${currentPartial}%)` : "下载"}
                    </button>
                  )}
                </div>

                {/* Progress bar — only when the active tier is the one
                    actually being transferred or paused. */}
                {(isCurrentDownload || isPausedHere) && (
                  <div className="mt-2">
                    <div className="h-1.5 bg-zinc-800 rounded overflow-hidden">
                      <div
                        className={
                          "h-full transition-all duration-200 " +
                          (isPausedHere ? "bg-amber-500" : "bg-blue-500")
                        }
                        style={{ width: `${downloadPct}%` }}
                      />
                    </div>
                    <p
                      className={
                        "text-[11px] mt-1 " +
                        (isPausedHere ? "text-amber-400" : "text-zinc-400")
                      }
                    >
                      {isPausedHere ? `已暂停（${downloadPct}%）` : `下载中 ${downloadPct}%`}
                    </p>
                  </div>
                )}

                <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">
                  {current.description}
                </p>
              </>
            );
          })()}
          <div className="mt-3 text-xs">
            <span className="text-zinc-500">显卡加速：</span>
            {draft.whisperBackend ? (
              <span
                className={
                  draft.whisperBackend.startsWith("CPU")
                    ? "text-zinc-300"
                    : "text-emerald-400 font-medium"
                }
              >
                {draft.whisperBackend.startsWith("CPU")
                  ? "❌ 没用上，靠 CPU 跑（识别会慢一些）"
                  : `✅ ${draft.whisperBackend}`}
              </span>
            ) : (
              <span className="text-zinc-500 italic">
                还没检测（导入第一个视频后会自动识别）
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

  // Read the active key+model from whichever protocol slot the current
  // vendor uses. The protocol slots remain runtime source of truth; the
  // vendorKeys map is just per-vendor archive (see types/settings.ts).
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

  function pickVendor(id: string) {
    const v = getVendor(id);
    if (!v) return;
    if (v.id === vendor.id) return;

    // 1) Stash the OUTGOING vendor's current key+model under its own slot.
    //    First-time switch from a fresh-install settings → seeds the stash
    //    with whatever the user had typed before this feature existed.
    const stash: Record<string, { apiKey: string; model: string }> = {
      ...(draft.vendorKeys ?? {}),
      [vendor.id]: { apiKey: activeKey, model: activeModel },
    };

    // 2) Load the INCOMING vendor's saved credentials, or blank+default model.
    const restored = stash[v.id];
    const newKey = restored?.apiKey ?? "";
    const newModel = restored?.model ?? (v.models[0] ?? "");

    const next: Settings = {
      ...draft,
      vendorId: v.id,
      llmProvider: v.protocol,
      vendorKeys: stash,
    };
    if (v.protocol === "openai-compatible") {
      next.openaiCompatible = {
        ...draft.openaiCompatible,
        baseUrl: v.baseUrl || draft.openaiCompatible.baseUrl,
        apiKey: newKey,
        model: newModel,
      };
    } else if (v.protocol === "claude") {
      next.claude = { apiKey: newKey, model: newModel };
    } else if (v.protocol === "gemini") {
      next.gemini = { apiKey: newKey, model: newModel };
    }
    setDraft(next);
  }

  // setActiveKey / setActiveModel write to BOTH the live protocol slot
  // AND the per-vendor stash so user edits persist regardless of whether
  // they save before switching vendors.
  function setActiveKey(v: string) {
    const stash = {
      ...(draft.vendorKeys ?? {}),
      [vendor.id]: { apiKey: v, model: activeModel },
    };
    if (vendor.protocol === "claude") {
      setDraft({ ...draft, vendorKeys: stash, claude: { ...draft.claude, apiKey: v } });
    } else if (vendor.protocol === "gemini") {
      setDraft({ ...draft, vendorKeys: stash, gemini: { ...draft.gemini, apiKey: v } });
    } else {
      setDraft({
        ...draft,
        vendorKeys: stash,
        openaiCompatible: { ...draft.openaiCompatible, apiKey: v },
      });
    }
  }
  function setActiveModel(v: string) {
    const stash = {
      ...(draft.vendorKeys ?? {}),
      [vendor.id]: { apiKey: activeKey, model: v },
    };
    if (vendor.protocol === "claude") {
      setDraft({ ...draft, vendorKeys: stash, claude: { ...draft.claude, model: v } });
    } else if (vendor.protocol === "gemini") {
      setDraft({ ...draft, vendorKeys: stash, gemini: { ...draft.gemini, model: v } });
    } else {
      setDraft({
        ...draft,
        vendorKeys: stash,
        openaiCompatible: { ...draft.openaiCompatible, model: v },
      });
    }
  }

  const isCustom = vendor.id === "custom";
  // Only show the API 地址 field for "自定义" vendor — every preset has its
  // URL hard-coded in vendors.ts and the input would just be a read-only
  // display the user can't change. Hiding it on presets cleans the UI without
  // affecting routing (getProvider still resolves the URL from the vendor
  // preset internally).
  const showBaseUrl = isCustom;

  return (
    <div className="space-y-4">
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
            API 地址
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

      <ModelField
        models={vendor.models}
        value={activeModel}
        onChange={setActiveModel}
      />
      {vendor.models.length > 0 && (
        <div className="-mt-2 text-[10px] text-zinc-500">
          点输入框右侧的图标看推荐模型列表，也可以手动输入其它模型名
        </div>
      )}

      {vendor.note && (
        <div className="text-[11px] text-zinc-400 italic bg-zinc-900/40 border-l-2 border-zinc-700 px-3 py-1.5 rounded-r">
          {vendor.note}
        </div>
      )}
    </div>
  );
}

/**
 * Model name input with a click-to-open dropdown listing the vendor's
 * recommended models. Replaces the previous `<input list=...>` + `<datalist>`
 * pair, where the browser's native datalist filtered the list to entries
 * matching the current input value — meaning once the user had a model name
 * in the field they could no longer browse the full preset list. This custom
 * version always shows everything; user can still type any name freely.
 */
function ModelField({
  models,
  value,
  onChange,
}: {
  models: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click. Pointerdown on document so we beat any handlers
  // that re-render the input during the same event.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const showButton = models.length > 0;

  return (
    <div>
      <label className="text-sm text-zinc-300 block">
        使用的模型
        <div ref={containerRef} className="relative mt-1">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={models[0] ?? "model name"}
            className={
              "w-full px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-zinc-100 " +
              (showButton ? "pr-8" : "")
            }
          />
          {showButton && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label="展开模型列表"
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 flex items-center text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded"
            >
              <ChevronDown
                className={"h-4 w-4 transition-transform " + (open ? "rotate-180" : "")}
              />
            </button>
          )}
          {open && showButton && (
            <div className="absolute z-10 left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded shadow-lg max-h-60 overflow-y-auto">
              {models.map((m) => {
                const active = m === value;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      onChange(m);
                      setOpen(false);
                    }}
                    className={
                      "w-full text-left px-3 py-1.5 text-sm transition-colors " +
                      (active
                        ? "bg-blue-500/20 text-blue-300"
                        : "text-zinc-200 hover:bg-zinc-800")
                    }
                  >
                    {m}
                    {active && <span className="ml-2 text-blue-400">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </label>
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
          className="px-3 flex items-center text-zinc-400 hover:text-zinc-100 select-none"
        >
          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {value && !reveal && (
        <div className="text-[10px] text-zinc-500 mt-1">已保存（{value.length} 字符）</div>
      )}
    </label>
  );
}
