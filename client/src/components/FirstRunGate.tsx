import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
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
import { useLicense } from "../store/license";
import { VENDORS, getVendor, type VendorPreset } from "../llm/vendors";
import { MODEL_TIERS, formatModelSize } from "../llm/modelTiers";
import type { Settings, WhisperModelSize } from "../types/settings";
import { WelcomeIntro } from "./WelcomeIntro";

// localStorage marker: the trial user clicked "开始使用" on the zero-config
// ready screen at least once. Frontend-only (a re-show after a wipe is
// harmless), so it doesn't warrant a settings-schema field.
const TRIAL_ONBOARDED_KEY = "whatsub.trialOnboarded";

interface Props {
  children: ReactNode;
}

// Per-vendor "how to get an API key" steps. Shown in an inline help panel
// when the user clicks "密钥传送门🔑" — same UX pattern as the cookies
// tutorial in ImportModal so users don't get yanked to the vendor's site
// without knowing what to do once they're there.
//
// Each step's `screenshot` (optional) refers to a PNG under public/help/
// (e.g. "/help/api-key-deepseek-1.png"). When the file isn't present the
// img tag is skipped so the steps still render as plain text. Drop new
// screenshots in client/public/help/ to enrich any vendor's flow.
type KeyHelpStep = { text: string; screenshot?: string };
type KeyHelp = { prereq?: string; steps: KeyHelpStep[] };

const KEY_HELP: Record<string, KeyHelp> = {
  deepseek: {
    steps: [
      { text: "用手机号注册并登录 DeepSeek 开放平台（国内直连，无需梯子）" },
      { text: "左侧菜单点「API keys」→ 点「创建 API key」" },
      { text: "名字填「whatsub」→「创建」，复制弹窗里出现的密钥（仅显示一次！）" },
      { text: "粘贴回这里。如果余额为 0，需要先在「充值」页充至少 5 元才能调用" },
    ],
  },
  openai: {
    prereq: "🪜 需要梯子（系统级 / TUN 模式，不是浏览器扩展）",
    steps: [
      { text: "登录 platform.openai.com/api-keys（推荐 Google 账号登录）" },
      { text: "点「+ Create new secret key」" },
      { text: "名字填「whatsub」→「Create secret key」→ 复制 sk- 开头的密钥（仅显示一次）" },
      { text: "粘贴回这里。新账号需先在 Billing 绑定信用卡 + 充值至少 $5" },
    ],
  },
  kimi: {
    steps: [
      { text: "注册并登录 Moonshot 开放平台（国内直连）" },
      { text: "左侧「API Key 管理」→「新建」" },
      { text: "名字填「whatsub」→ 复制弹窗里出现的密钥（仅显示一次）" },
      { text: "粘贴回这里。新账号有免费体验额度" },
    ],
  },
  zhipu: {
    steps: [
      { text: "注册并登录智谱 AI 开放平台（国内直连）" },
      { text: "点头像 →「API keys」管理页" },
      { text: "点「添加新的 API Key」→ 名称填「whatsub」→ 复制密钥" },
      { text: "粘贴回这里。glm-4-flash 模型有大量免费额度可白嫖" },
    ],
  },
  qwen: {
    steps: [
      { text: "登录阿里云百炼控制台（需要阿里云账号）" },
      { text: "左侧「API-KEY」→「我的 API-KEY」→ 创建" },
      { text: "名称填「whatsub」→ 复制密钥（仅显示一次）" },
      { text: "粘贴回这里。turbo 模型几分钱就能跑完一个视频" },
    ],
  },
  siliconflow: {
    steps: [
      { text: "注册并登录 SiliconFlow 控制台（国内直连）" },
      { text: "左侧「API 密钥」→「新建 API 密钥」" },
      { text: "描述填「whatsub」→ 复制密钥" },
      { text: "粘贴回这里。注册即送 14 元体验额度" },
    ],
  },
  claude: {
    prereq: "🪜 需要梯子（系统级 / TUN 模式）",
    steps: [
      { text: "登录 console.anthropic.com，没账号先注册" },
      { text: "Settings → API Keys →「Create Key」" },
      { text: "名字填「whatsub」→ Create → 复制 sk-ant- 开头的密钥（仅显示一次）" },
      { text: "粘贴回这里。新账号需先在 Plans & Billing 充值至少 $5" },
    ],
  },
  gemini: {
    prereq: "🪜 需要梯子（且在某些受限地区如香港无法使用）",
    steps: [
      { text: "登录 aistudio.google.com/apikey（需 Google 账号）" },
      { text: "点「Create API key」→ 选一个 Google Cloud 项目（或新建一个）" },
      { text: "复制 AIza- 开头的密钥" },
      { text: "粘贴回这里。flash 模型有大量免费额度，pro 更聪明但收费" },
    ],
  },
};

// First-run welcome with two side-by-side onboarding cards. Replaces the
// previous "click into Settings" flow — non-technical users were getting
// dropped into a dense settings page and bouncing. Cards inline only what's
// needed to start the app:
//   ① pick a translation service + paste API key + verify
//   ② download the subtitle-recognition model (~466 MB)
// Auto-passes through to children as soon as both are complete (the same
// hasLlmKey + modelOk gate logic as before, just with friendlier UI).
//
// The animated headline + cards live in WelcomeIntro as a single composition
// so the transition from intro → onboarding has no DOM swap (and therefore
// no background/title snap). FirstRunGate just decides whether to render
// that composition or pass straight through to the app.
export function FirstRunGate({ children }: Props) {
  const { settings, load, loaded, save } = useSettings();
  const [modelOk, setModelOk] = useState<boolean | null>(null);

  // Trial users (trial token) AND pure Pro subscribers (SUB_ACTIVE — session
  // token from a prior email login) both get free managed-relay LLM, so they
  // need no BYOK key. `relayEligible` gates the zero-config "已就绪" path below.
  // (Licensed/买断 users are mode==='ACTIVE' and get license_blocked on the
  // relay, so they keep the BYOK onboarding.)
  const mode = useLicense((s) => s.mode);
  const relayEligible = mode === "TRIAL_ACTIVE" || mode === "SUB_ACTIVE";
  const [trialOnboarded, setTrialOnboarded] = useState(() => {
    try {
      return localStorage.getItem(TRIAL_ONBOARDED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    load();
  }, [load]);

  // Auto-detect ANY downloaded whisper model, not just the one
  // settings.whisperModel happens to point at — otherwise a fresh install
  // (or a settings reset) defaults whisperModel to "small" and forces the
  // user to re-download even when they already have ggml-tiny.bin or
  // ggml-medium.bin sitting on disk from a previous session.
  // If a non-selected tier is on disk, silently promote it to the active
  // setting (prefer the LARGEST already-downloaded tier — user paid for it).
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      if (await invoke<boolean>("whisper_model_status", { size: settings.whisperModel })) {
        setModelOk(true);
        return;
      }
      for (const t of [...MODEL_TIERS].reverse()) {
        if (t.size === settings.whisperModel) continue;
        if (await invoke<boolean>("whisper_model_status", { size: t.size })) {
          try {
            await save({ ...settings, whisperModel: t.size });
          } catch {
            /* save errors are non-fatal — modelOk stays true and the user
               can fix the persisted setting later in Settings */
          }
          setModelOk(true);
          return;
        }
      }
      setModelOk(false);
    })();
  }, [loaded, settings.whisperModel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default trial / Pro (relay-eligible) users to the whatsub-managed vendor
  // when they have no BYOK key — once, on load. The onboarding auto-enter also
  // sets it, but that path is skipped once trialOnboarded is set, so a settings
  // reset could otherwise leave the vendor on the default DeepSeek. One-shot
  // (ref) so it never snaps back if the user later picks another vendor.
  const ensuredManagedRef = useRef(false);
  useEffect(() => {
    if (!loaded || ensuredManagedRef.current) return;
    const relayEligible = mode === "TRIAL_ACTIVE" || mode === "SUB_ACTIVE";
    if (!relayEligible) return;
    ensuredManagedRef.current = true;
    const hasKey =
      settings.llmProvider === "openai-compatible"
        ? !!settings.openaiCompatible.apiKey
        : settings.llmProvider === "claude"
          ? !!settings.claude.apiKey
          : !!settings.gemini.apiKey;
    if (hasKey || settings.vendorId === "whatsub-managed") return;
    const v = getVendor("whatsub-managed");
    if (v) {
      void save({
        ...settings,
        vendorId: v.id,
        llmProvider: v.protocol,
        openaiCompatible: {
          ...settings.openaiCompatible,
          baseUrl: v.baseUrl,
          model: v.models[0] ?? settings.openaiCompatible.model,
        },
      });
    }
  }, [loaded, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Brief loading state while settings + model probe resolve. invoke() is
  // sub-100ms in real Tauri, so users barely register this; the long wait
  // (~7s) is the intro animation that follows when onboarding isn't done.
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

  // BYOK configured → straight to app (any mode).
  if (hasLlmKey && modelOk) return <>{children}</>;

  // Relay-eligible (trial / Pro subscriber): bundled model + free managed LLM
  // → NOTHING to configure. Play the welcome animation once, then auto-enter
  // (persist the managed vendor on the way in). Subsequent launches skip
  // straight in via the trialOnboarded marker.
  const relayReady = relayEligible && modelOk;
  if (relayReady && trialOnboarded) return <>{children}</>;

  async function enterManaged() {
    // Persist the managed vendor (no key — bearer resolved from the session /
    // trial token at request time) so every LLM feature routes to the relay.
    if (settings.vendorId !== "whatsub-managed") {
      const v = getVendor("whatsub-managed");
      if (v) {
        try {
          await save({
            ...settings,
            vendorId: v.id,
            llmProvider: v.protocol,
            openaiCompatible: {
              ...settings.openaiCompatible,
              baseUrl: v.baseUrl,
              model: v.models[0] ?? settings.openaiCompatible.model,
            },
          });
        } catch {
          /* best-effort — user can switch vendor in Settings if this fails */
        }
      }
    }
    try {
      localStorage.setItem(TRIAL_ONBOARDED_KEY, "1");
    } catch {
      /* ignore */
    }
    setTrialOnboarded(true);
  }

  if (relayReady) {
    return (
      <WelcomeIntro>
        <AutoEnterWelcome isPro={mode === "SUB_ACTIVE"} onEnter={enterManaged} />
      </WelcomeIntro>
    );
  }

  // Otherwise: a 买断/license user who needs BYOK, or (dev builds) no bundled
  // model. Show ONLY the step(s) that actually need the user — the model is
  // bundled in release, so a buyout user usually sees just the API-key card.
  const cards: ReactNode[] = [];
  if (!modelOk) {
    cards.push(
      <ModelDownloadCard
        key="model"
        stepNum={cards.length + 1}
        done={modelOk}
        onModelReady={() => setModelOk(true)}
      />,
    );
  }
  if (!hasLlmKey) {
    cards.push(
      <TranslationServiceCard
        key="llm"
        stepNum={cards.length + 1}
        settings={settings}
        save={save}
        done={hasLlmKey}
      />,
    );
  }
  return (
    <WelcomeIntro>
      <div
        className={
          cards.length > 1
            ? "grid grid-cols-1 md:grid-cols-2 gap-5 items-start"
            : "max-w-md mx-auto"
        }
      >
        {cards}
      </div>
    </WelcomeIntro>
  );
}

// ─────────────────────────────────────────────────────────────────
// Auto-enter welcome (trial / Pro — zero config). Shown inside WelcomeIntro;
// after the brand animation settles it auto-enters the app (no click). A short
// "已就绪" line gives the moment some meaning. `isPro` swaps trial vs Pro copy.
// ─────────────────────────────────────────────────────────────────

function AutoEnterWelcome({
  isPro,
  onEnter,
}: {
  isPro: boolean;
  onEnter: () => Promise<void> | void;
}) {
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;
  // One-shot timer from mount. Children mount at frame 0 (opacity 0) under the
  // ~9.8s WelcomeIntro animation; fire shortly after it settles so the line is
  // visible for a beat, then auto-enter.
  useEffect(() => {
    const t = setTimeout(() => void onEnterRef.current(), 10_500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="text-center">
      <div className="inline-flex items-center gap-2 text-sm text-zinc-200">
        <Check className="h-4 w-4 text-green-400 shrink-0" />
        {isPro ? "Pro 已就绪 · 开箱即用" : "试用已开始 · 免费 AI 已就绪"}
      </div>
      <div className="mt-3 text-xs text-zinc-500 inline-flex items-center gap-1.5">
        <Loader2 className="h-3 w-3 animate-spin" /> 正在进入…
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
  stepNum = 2,
}: {
  settings: Settings;
  save: (s: Settings) => Promise<void>;
  done: boolean;
  stepNum?: number;
}) {
  // Default to deepseek for users who haven't picked a vendor yet (new install
  // or settings.json missing vendorId), but respect any explicit choice carried
  // over from a previous session — if the user has been using e.g. Claude
  // before and just blanked out their key, snapping the dropdown back to
  // deepseek would override their preference unexpectedly.
  const [vendorId, setVendorId] = useState(settings.vendorId ?? "deepseek");
  const vendor = getVendor(vendorId) ?? VENDORS[0];

  const initialKey = (() => {
    if (vendor.protocol === "openai-compatible") return settings.openaiCompatible.apiKey;
    if (vendor.protocol === "claude") return settings.claude.apiKey;
    return settings.gemini.apiKey;
  })();
  const [apiKey, setApiKey] = useState(initialKey);
  const [showKey, setShowKey] = useState(false);
  const [showKeyHelp, setShowKeyHelp] = useState(false);
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
    <Card stepNum={stepNum} title="选择翻译服务" done={done}>
      <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
        请选择一个为你工作的人工智能吧 🪄
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
            <label className="text-sm text-zinc-400">密钥</label>
            {KEY_HELP[vendor.id] && (
              <button
                type="button"
                onClick={() => setShowKeyHelp((v) => !v)}
                title={`查看 ${vendor.name} 密钥获取步骤`}
                className={
                  "inline-flex items-center gap-1 text-sm transition-colors " +
                  (showKeyHelp
                    ? "text-blue-200"
                    : "text-blue-300 hover:text-blue-200 underline-offset-2 hover:underline")
                }
              >
                密钥传送门🔑
              </button>
            )}
          </div>
          <div className="relative mb-1">
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
          {showKeyHelp && KEY_HELP[vendor.id] && (
            <KeyHelpPanel
              vendor={vendor}
              help={KEY_HELP[vendor.id]}
              onClose={() => setShowKeyHelp(false)}
            />
          )}
          <div className="mb-3" />
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

function ModelDownloadCard({
  done,
  onModelReady,
  stepNum = 1,
}: {
  done: boolean;
  onModelReady: () => void;
  stepNum?: number;
}) {
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

  // While the model is actively downloading we collapse the card down to
  // just the progress bar — the tier list and the card header both fold up
  // (animated via a grid-template-rows 0fr ↔ 1fr transition). User pauses
  // → expands back to full so they can pick a different tier or just see
  // what's going on.
  const collapsed = phase === "downloading";

  return (
    <Card
      stepNum={stepNum}
      title="下载字幕识别引擎"
      done={done}
      compact={collapsed}
    >
      <div
        className={
          "grid transition-all duration-500 ease-in-out " +
          (collapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")
        }
      >
        <div className="overflow-hidden min-h-0">
          <div className="flex gap-3 pb-4">
            <div className="space-y-2 flex-1">
        {MODEL_TIERS.map((t, idx) => {
          const isSelected = t.size === selectedSize;
          const isDownloaded = downloaded[t.size];
          const partial = partialPct[t.size] ?? 0;
          const lockedDuringDownload = phase === "downloading" && t.size !== selectedSize;
          // Visual ladder for the 5 tiers — single-hue violet wash with
          // growing opacity, plus growing padding height. Violet is distinct
          // from blue (selection accent), green (done), and amber (paused),
          // so the gradient never clashes with status indicators:
          //   极速 (idx 0) → barely-tinted, tightest padding
          //   顶级 (idx 4) → strongest tint, roomiest padding
          // Selected state overrides bg with blue accent so the current
          // pick is unambiguous regardless of where it sits on the ladder.
          const tierBg = [
            "bg-violet-500/5",
            "bg-violet-500/10",
            "bg-violet-500/15",
            "bg-violet-500/20",
            "bg-violet-500/30",
          ][idx];
          const tierPad = ["py-2", "py-2.5", "py-3", "py-4", "py-5"][idx];
          return (
            <label
              key={t.size}
              className={
                "flex items-start gap-3 px-3 rounded border text-left transition-all duration-300 " +
                tierPad + " " +
                (isSelected
                  ? "border-blue-500 bg-blue-500/10"
                  : `border-zinc-800 hover:border-zinc-700 ${tierBg}`) +
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
                  ) : isSelected && phase === "downloading" ? (
                    // Live percent for the tier being actively downloaded.
                    // Avoids showing the stale paused-snapshot from
                    // partialPct (which only refreshes after the download
                    // ends or pauses, so it would otherwise sit frozen at
                    // e.g. "已下载 30%" while the bar at the bottom climbs
                    // past 30% in real time).
                    <span className="ml-auto text-xs text-blue-400">
                      下载中 {pct}%
                    </span>
                  ) : partial > 0 ? (
                    <span className="ml-auto text-xs text-amber-400">
                      已下载 {partial}%
                    </span>
                  ) : null}
                </div>
              </div>
            </label>
          );
        })}
            </div>

            {/* Trade-off axes — vertical "number-line" arrows showing how
                each metric changes as you go down the tier list. Accuracy
                GROWS, speed SHRINKS. Disk-usage axis was dropped because
                the per-tier "约 N MB" label on each row already conveys
                the same information; keeping it as a third axis just
                duplicated info the user reads inline. */}
            <div className="shrink-0 flex gap-2 text-[10px] text-zinc-400 self-stretch">
              <TradeoffAxis label="识别准确度" topText="低" bottomText="高" />
              <TradeoffAxis label="识别速度" topText="快" bottomText="慢" />
            </div>
          </div>
        </div>
      </div>

      {/* Action area */}
      {downloaded[selectedSize] ? (
        <div className="px-4 py-3 bg-green-500/10 border border-green-500/30 rounded text-sm text-green-300 flex items-center gap-2">
          <Check className="h-4 w-4" /> 下载完成，请尽情享用吧~
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
  title,
  done,
  children,
  compact = false,
}: {
  stepNum: number;
  title: string;
  done: boolean;
  children: ReactNode;
  /** Animated minimal mode — hides the step number / title to focus
   *  attention on the body (used by the model card while downloading so the
   *  progress bar is the only thing visible). */
  compact?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg transition-all duration-500 " +
        // When compact (downloading), drop the surrounding chrome — no
        // background, no border, no padding — so the progress bar floats
        // alone in the column instead of sitting in a giant empty box.
        (compact
          ? "bg-transparent border-0 p-0"
          : "border bg-zinc-900 p-6 " +
            (done ? "border-green-500/40" : "border-zinc-800"))
      }
    >
      <div
        className={
          "grid transition-all duration-500 ease-in-out " +
          (compact ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")
        }
      >
        <div className="overflow-hidden min-h-0">
          {/* items-baseline aligns the Caveat digit's text baseline with
              the title's baseline — using items-start with a tall (h-10)
              wrapper around the digit visually pushed the number lower
              than the title. The number's natural box now drives the
              header height. */}
          <div className="flex items-baseline gap-3 pb-4">
            <span
              className={"shrink-0 leading-none " + (done ? "text-green-400" : "text-blue-300")}
              style={{
                fontFamily: "Caveat, cursive",
                fontSize: 32,
                fontWeight: 700,
              }}
            >
              {done ? "✓" : stepNum}
            </span>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-medium">{title}</h2>
            </div>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

// Single vertical "number-line" with an arrowhead at the bottom and short
// labels at the top + bottom of the axis. Used by ModelDownloadCard's tier
// picker to communicate a metric's directional trade-off across the 5 tiers
// (memory grows top→bottom, accuracy grows top→bottom, speed shrinks).
function TradeoffAxis({
  label,
  topText,
  bottomText,
}: {
  label: string;
  topText: string;
  bottomText: string;
}) {
  return (
    <div className="flex flex-col items-center text-center min-w-[28px]">
      <span className="text-zinc-300 font-medium mb-1">{label}</span>
      <span className="text-zinc-500">{topText}</span>
      <div className="relative flex-1 my-1 w-0.5 bg-gradient-to-b from-zinc-600 to-violet-400/60 min-h-[64px] rounded-full">
        {/* Arrowhead at the bottom of the axis line, drawn as two CSS
            borders on a rotated square — no extra SVG dependency. Sized
            proportionally to the 2px line width so the tip stays visually
            anchored to the axis (a 1px-line arrowhead would look detached
            on a thicker line). */}
        <span
          className="absolute -bottom-px left-1/2 w-0 h-0"
          style={{
            transform: "translateX(-50%)",
            borderLeft: "4px solid transparent",
            borderRight: "4px solid transparent",
            borderTop: "6px solid rgb(167 139 250 / 0.6)",
          }}
        />
      </div>
      <span className="text-violet-300 mt-1">{bottomText}</span>
    </div>
  );
}

// Inline help panel that walks the user through getting an API key for the
// currently-selected vendor. Same expand-in-place pattern as ImportModal's
// "?" button (no modal overlay), so the input + verify button stay
// reachable while the help is open.
function KeyHelpPanel({
  vendor,
  help,
  onClose,
}: {
  vendor: VendorPreset;
  help: KeyHelp;
  onClose: () => void;
}) {
  return (
    <div className="mt-2 p-3 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-300 leading-relaxed space-y-3 max-h-[60vh] overflow-y-auto">
      <div className="flex items-start justify-between gap-2 sticky top-0 -mx-3 -mt-3 px-3 pt-3 pb-2 bg-zinc-800 border-b border-zinc-700">
        <div className="text-zinc-100 font-medium">{vendor.name} 密钥获取步骤</div>
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1"
          title="关闭"
        >
          ×
        </button>
      </div>

      {help.prereq && (
        <div className="px-2 py-1.5 rounded border border-amber-500/30 bg-amber-500/5 text-amber-200 text-[11px]">
          {help.prereq}
        </div>
      )}

      <ol className="list-decimal list-outside ml-4 space-y-2 text-zinc-300">
        {help.steps.map((s, i) => (
          <li key={i}>
            {s.text}
            {s.screenshot && (
              <img
                src={s.screenshot}
                alt={`步骤 ${i + 1}`}
                className="mt-1.5 rounded border border-zinc-700 w-full"
                onError={(e) => {
                  // Hide gracefully if the screenshot file isn't dropped
                  // in public/help/ yet — text steps still readable.
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
            )}
          </li>
        ))}
      </ol>

      {vendor.keyConsoleUrl && (
        <a
          href={vendor.keyConsoleUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 mt-1 px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-sm font-medium rounded"
        >
          前往 {vendor.name} 控制台
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}
