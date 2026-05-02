import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Sparkles,
  Download,
  ExternalLink,
  Check,
  Eye,
  EyeOff,
  Loader2,
  Pause,
  Play,
} from "lucide-react";
import { useSettings } from "../store/settings";
import { VENDORS, getVendor } from "../llm/vendors";
import { MODEL_TIERS, formatModelSize } from "../llm/modelTiers";
import type { Settings, WhisperModelSize } from "../types/settings";

interface Props {
  children: ReactNode;
}

// First-run welcome with two side-by-side onboarding cards. Replaces the
// previous "click into Settings" flow — non-technical users were getting
// dropped into a dense settings page and bouncing. Cards inline only what's
// needed to start the app:
//   ① pick a translation service + paste API key + verify
//   ② download the subtitle-recognition model (~466 MB)
// Auto-passes through to children as soon as both are complete (the same
// hasLlmKey + modelOk gate logic as before, just with friendlier UI).
export function FirstRunGate({ children }: Props) {
  const { settings, load, loaded, save } = useSettings();
  const [modelOk, setModelOk] = useState<boolean | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!loaded) return;
    invoke<boolean>("whisper_model_status", { size: settings.whisperModel }).then(setModelOk);
  }, [loaded, settings.whisperModel]);

  if (!loaded || modelOk === null) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-500 flex items-center justify-center text-sm">
        加载中...
      </div>
    );
  }

  const hasLlmKey = (() => {
    if (settings.llmProvider === "openai-compatible")
      return Boolean(settings.openaiCompatible.apiKey);
    if (settings.llmProvider === "claude") return Boolean(settings.claude.apiKey);
    return Boolean(settings.gemini.apiKey);
  })();

  if (hasLlmKey && modelOk) return <>{children}</>;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-8">
      <div className="w-full max-w-4xl">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-semibold mb-3">欢迎使用 whatsub</h1>
          <p className="text-zinc-400 text-base leading-relaxed">
            完成下面两小步，就可以开始用啦。两步可以同时进行 ——
            模型在下载的时候你可以先去填密钥。
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <TranslationServiceCard
            settings={settings}
            save={save}
            done={hasLlmKey}
          />
          <ModelDownloadCard
            done={modelOk}
            onModelReady={() => setModelOk(true)}
          />
        </div>

        <p className="text-center text-sm text-zinc-600 mt-8">
          两步都完成后会自动进入主界面。设置里之后还能改。
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Card 1: Translation service
// ─────────────────────────────────────────────────────────────────

function TranslationServiceCard({
  settings,
  save,
  done,
}: {
  settings: Settings;
  save: (s: Settings) => Promise<void>;
  done: boolean;
}) {
  const [vendorId, setVendorId] = useState(settings.vendorId ?? "deepseek");
  const vendor = getVendor(vendorId) ?? VENDORS[0];

  const initialKey = (() => {
    if (vendor.protocol === "openai-compatible") return settings.openaiCompatible.apiKey;
    if (vendor.protocol === "claude") return settings.claude.apiKey;
    return settings.gemini.apiKey;
  })();
  const [apiKey, setApiKey] = useState(initialKey);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // When the user picks a different vendor, prefill the key from whichever
  // protocol slot stores it (so switching between presets preserves keys).
  function pickVendor(id: string) {
    setVendorId(id);
    const v = getVendor(id);
    if (!v) return;
    if (v.protocol === "openai-compatible") setApiKey(settings.openaiCompatible.apiKey);
    else if (v.protocol === "claude") setApiKey(settings.claude.apiKey);
    else setApiKey(settings.gemini.apiKey);
    setResult(null);
  }

  async function saveAndTest() {
    if (!apiKey.trim() && vendor.id !== "ollama") {
      setResult({ ok: false, msg: "请先粘贴密钥" });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      // Build a candidate settings object — we test against it but only
      // commit it via save() once the test passes. This way an invalid
      // key never gets persisted, so the gate's hasLlmKey check stays
      // truthful (no false ✓ followed by a broken main app).
      const candidate: Settings = {
        ...settings,
        vendorId: vendor.id,
        llmProvider: vendor.protocol,
      };
      if (vendor.protocol === "openai-compatible") {
        candidate.openaiCompatible = {
          baseUrl: vendor.baseUrl || settings.openaiCompatible.baseUrl,
          apiKey,
          model: vendor.models[0] || settings.openaiCompatible.model,
        };
      } else if (vendor.protocol === "claude") {
        candidate.claude = { apiKey, model: vendor.models[0] || settings.claude.model };
      } else {
        candidate.gemini = { apiKey, model: vendor.models[0] || settings.gemini.model };
      }

      const { getProvider } = await import("../llm/providers");
      const p = getProvider(candidate);
      let ok = false;
      for await (const _ of p.stream({
        systemPrompt: "Reply with 'ok'.",
        userPrompt: "ok",
      })) {
        ok = true;
        break;
      }
      if (!ok) {
        setResult({ ok: false, msg: "✗ 服务无响应，请检查密钥或网络" });
        return;
      }
      await save(candidate);
      setResult({ ok: true, msg: "✓ 连接成功，已保存" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult({ ok: false, msg: `✗ ${msg}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card stepNum={1} icon={<Sparkles className="h-5 w-5" />} title="选择翻译服务" done={done}>
      <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
        请选择一个为你工作的人工智能吧 ✨
      </p>

      <label className="text-sm text-zinc-400 block mb-1.5">服务商</label>
      <select
        value={vendor.id}
        onChange={(e) => pickVendor(e.target.value)}
        className="w-full mb-1.5 px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded text-base"
      >
        {VENDORS.filter((v) => v.id !== "custom").map((v) => (
          <option key={v.id} value={v.id}>
            {v.id === "deepseek" ? `${v.name}（推荐）` : v.name}
          </option>
        ))}
      </select>
      {vendor.note && (
        <p className="text-xs text-zinc-500 mb-3 leading-relaxed">{vendor.note}</p>
      )}

      {vendor.id !== "ollama" && (
        <>
          <div className="flex items-center justify-between mb-1.5 mt-2">
            <label className="text-sm text-zinc-400">密钥（API Key）</label>
            {vendor.keyConsoleUrl && (
              <a
                href={vendor.keyConsoleUrl}
                target="_blank"
                rel="noreferrer"
                title={`点击前往 ${vendor.name} 控制台创建密钥`}
                className="group inline-flex items-center gap-1 text-sm text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline transition-colors"
              >
                快速获取密钥 🔑
                <ExternalLink className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
              </a>
            )}
          </div>
          <div className="relative mb-3">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="粘贴密钥"
              className="w-full px-3 py-2.5 pr-10 bg-zinc-950 border border-zinc-800 rounded text-base font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              aria-label={showKey ? "隐藏密钥" : "显示密钥"}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </>
      )}

      <button
        onClick={saveAndTest}
        disabled={busy}
        className="w-full px-4 py-2.5 bg-blue-500 hover:bg-blue-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-black font-medium rounded text-base flex items-center justify-center gap-2"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {busy ? "正在验证..." : "保存并验证"}
      </button>
      {result && (
        <p
          className={
            "text-sm mt-2 leading-relaxed " +
            (result.ok ? "text-green-400" : "text-rose-400")
          }
        >
          {result.msg}
        </p>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// Card 2: Subtitle-recognition model
// ─────────────────────────────────────────────────────────────────

type DlPhase = "idle" | "downloading" | "paused";

function ModelDownloadCard({ done, onModelReady }: { done: boolean; onModelReady: () => void }) {
  const { settings, save } = useSettings();
  const [selectedSize, setSelectedSize] = useState<WhisperModelSize>(settings.whisperModel);
  // Per-tier "downloaded" + "partial download %" maps. Refreshed on mount,
  // after pause, and after a download finishes.
  const [downloaded, setDownloaded] = useState<Record<string, boolean>>({});
  const [partialPct, setPartialPct] = useState<Record<string, number>>({});
  const [phase, setPhase] = useState<DlPhase>("idle");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function refreshTierStatuses() {
    const results = await Promise.all(
      MODEL_TIERS.map(async (t) => {
        const [ok, partialBytes] = await Promise.all([
          invoke<boolean>("whisper_model_status", { size: t.size }),
          invoke<number>("whisper_model_partial_size", { size: t.size }),
        ]);
        const totalBytes = t.sizeMB * 1024 * 1024;
        const p = totalBytes > 0 ? Math.floor((partialBytes / totalBytes) * 100) : 0;
        return [t.size, ok, p] as const;
      })
    );
    const dl: Record<string, boolean> = {};
    const pp: Record<string, number> = {};
    for (const [size, ok, p] of results) {
      dl[size] = ok;
      pp[size] = p;
    }
    setDownloaded(dl);
    setPartialPct(pp);
  }

  useEffect(() => {
    refreshTierStatuses();
  }, []);

  // Subscribe to backend progress events.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ stage: string; progress?: number }>("pipeline-event", (e) => {
      if (e.payload.stage === "ModelDownload" && typeof e.payload.progress === "number") {
        setPct(e.payload.progress);
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  // When the selected tier (or its on-disk state) changes while we're not
  // actively downloading, snap the phase + visible pct to whatever's true
  // for the new selection. Lets the user click between tiers and see each
  // one's resume state.
  useEffect(() => {
    if (phase === "downloading") return;
    if (downloaded[selectedSize]) {
      setPhase("idle");
      setPct(100);
    } else if ((partialPct[selectedSize] ?? 0) > 0) {
      setPhase("paused");
      setPct(partialPct[selectedSize]);
    } else {
      setPhase("idle");
      setPct(0);
    }
  }, [selectedSize, downloaded, partialPct]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickTier(size: WhisperModelSize) {
    if (phase === "downloading") return;
    setSelectedSize(size);
    setError(null);
    if (settings.whisperModel !== size) {
      await save({ ...settings, whisperModel: size });
    }
  }

  async function startDownload() {
    setPhase("downloading");
    setError(null);
    try {
      await invoke("whisper_model_download", { size: selectedSize });
      setPct(100);
      setPhase("idle");
      await refreshTierStatuses();
      onModelReady();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Rust returns AppError::Other("cancelled") on user pause — treat it
      // as a paused state so the UI offers "继续" rather than a red error.
      if (msg.toLowerCase().includes("cancelled")) {
        await refreshTierStatuses();
        setPhase("paused");
      } else {
        setPhase("idle");
        setError(msg);
      }
    }
  }

  async function pauseDownload() {
    // The startDownload() promise will reject shortly after; its catch
    // branch flips phase to "paused". We don't await here because the
    // cancel command is synchronous and the rejection comes via the other
    // in-flight promise.
    await invoke("whisper_model_download_cancel");
  }

  return (
    <Card stepNum={2} icon={<Download className="h-5 w-5" />} title="下载字幕识别引擎" done={done}>
      <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
        从视频里识别出英文字幕。下面挑一个版本下载 ——{" "}
        <strong className="text-zinc-300">质量越高、文件越大</strong>。只需下载一次，以后所有视频都用它。
      </p>

      <div className="space-y-2 mb-4">
        {MODEL_TIERS.map((t) => {
          const isSelected = t.size === selectedSize;
          const isDownloaded = downloaded[t.size];
          const partial = partialPct[t.size] ?? 0;
          const lockedDuringDownload = phase === "downloading" && t.size !== selectedSize;
          return (
            <label
              key={t.size}
              className={
                "flex items-start gap-3 p-3 rounded border text-left transition " +
                (isSelected
                  ? "border-blue-500 bg-blue-500/10"
                  : "border-zinc-800 hover:border-zinc-700") +
                (lockedDuringDownload ? " opacity-40 cursor-not-allowed" : " cursor-pointer")
              }
            >
              <input
                type="radio"
                name="model-tier"
                checked={isSelected}
                disabled={lockedDuringDownload}
                onChange={() => pickTier(t.size)}
                className="mt-1 accent-blue-500"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-base">{t.name}</span>
                  <span className="text-xs text-zinc-500">{formatModelSize(t.sizeMB)}</span>
                  {t.recommended && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                      推荐
                    </span>
                  )}
                  {isDownloaded ? (
                    <span className="ml-auto text-xs text-green-400 inline-flex items-center gap-1">
                      <Check className="h-3.5 w-3.5" /> 已下载
                    </span>
                  ) : partial > 0 ? (
                    <span className="ml-auto text-xs text-amber-400">
                      已下载 {partial}%
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                  {t.description}
                </p>
              </div>
            </label>
          );
        })}
      </div>

      {/* Action area */}
      {downloaded[selectedSize] ? (
        <div className="px-4 py-3 bg-green-500/10 border border-green-500/30 rounded text-sm text-green-300 flex items-center gap-2">
          <Check className="h-4 w-4" /> 已下载完成，可以开始用了
        </div>
      ) : phase === "downloading" ? (
        <div>
          <div className="h-2 bg-zinc-800 rounded overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-2 gap-3">
            <p className="text-xs text-zinc-400 truncate">下载中 {pct}%</p>
            <button
              onClick={pauseDownload}
              className="shrink-0 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm rounded inline-flex items-center gap-1"
            >
              <Pause className="h-3.5 w-3.5" /> 暂停
            </button>
          </div>
        </div>
      ) : phase === "paused" ? (
        <div>
          <div className="h-2 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-amber-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between mt-2 gap-3">
            <p className="text-xs text-amber-400 truncate">已暂停（{pct}%）</p>
            <button
              onClick={startDownload}
              className="shrink-0 px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-sm font-medium rounded inline-flex items-center gap-1"
            >
              <Play className="h-3.5 w-3.5" /> 继续
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={startDownload}
          className="w-full px-4 py-2.5 bg-blue-500 hover:bg-blue-400 text-black font-medium rounded text-base flex items-center justify-center gap-2"
        >
          <Download className="h-4 w-4" /> 开始下载
        </button>
      )}
      {error && (
        <p className="text-sm text-rose-400 mt-2 leading-relaxed">下载失败：{error}</p>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// Shared card chrome — number badge, icon, title, ✓ when done
// ─────────────────────────────────────────────────────────────────

function Card({
  stepNum,
  icon,
  title,
  done,
  children,
}: {
  stepNum: number;
  icon: ReactNode;
  title: string;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={
        "rounded-lg p-6 border bg-zinc-900 transition-colors " +
        (done ? "border-green-500/40" : "border-zinc-800")
      }
    >
      <div className="flex items-start gap-3 mb-4">
        <div
          className={
            "w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-base font-semibold " +
            (done
              ? "bg-green-500/20 text-green-400"
              : "bg-blue-500/20 text-blue-300")
          }
        >
          {done ? <Check className="h-5 w-5" /> : stepNum}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">{icon}</span>
            <h2 className="text-lg font-medium">{title}</h2>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}
