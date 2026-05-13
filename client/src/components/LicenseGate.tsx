import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, ShieldAlert, Cloud, WifiOff } from 'lucide-react';
import { useLicense, type ActivateError } from '../store/license';
import { TrialBanner } from './TrialBanner';

/**
 * Wraps the app router. While `mode === 'INITIALIZING'` shows a loading
 * splash; while `mode === 'NEEDS_KEY'` shows the activation modal full-
 * screen, blocking access to all features. Only when `mode === 'ACTIVE'`
 * does it render `children` (the actual app).
 *
 * One-time activation per device: after the user enters a valid key, the
 * Rust side persists `license.json` and we never call /api/activate again
 * unless the user explicitly clicks "deactivate" in settings.
 */
export function LicenseGate({ children }: { children: ReactNode }) {
  const { mode, init } = useLicense();
  const [celebrating, setCelebrating] = useState(false);
  const prevModeRef = useRef(mode);

  useEffect(() => {
    void init();
  }, [init]);

  // Detect the NEEDS_KEY → ACTIVE transition (i.e. activation just succeeded)
  // and play a celebration overlay before letting `children` mount. This
  // delays the WelcomeIntro animation by ~2.5s so the user gets a clear
  // "you just unlocked the app" reward beat between their click and the
  // brand intro. Re-mounts (mode initializing → ACTIVE on app launch with
  // an existing license) skip the celebration — only first-time
  // activation triggers it.
  useEffect(() => {
    if (prevModeRef.current === 'NEEDS_KEY' && mode === 'ACTIVE') {
      setCelebrating(true);
    }
    prevModeRef.current = mode;
  }, [mode]);

  if (mode === 'INITIALIZING') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-950">
        <Loader2 className="w-6 h-6 text-zinc-400 animate-spin" />
      </div>
    );
  }

  if (mode === 'NEEDS_KEY') {
    return <ActivationScreen />;
  }

  // mode === 'ACTIVE' or 'TRIAL_ACTIVE' — children render in both cases.
  // Celebration only fires on the NEEDS_KEY → ACTIVE transition (real
  // license activation), not on trial start; the trial banner already
  // signals "you got access" implicitly.
  if (celebrating) {
    return <CelebrationOverlay onDone={() => setCelebrating(false)} />;
  }

  if (mode === 'TRIAL_ACTIVE') {
    return (
      <>
        <TrialBanner />
        {children}
      </>
    );
  }

  return <>{children}</>;
}

/**
 * Full-screen overlay that plays a restrained "seal of authenticity"
 * animation when license activation succeeds, then dissolves to black so
 * WelcomeIntro can take over with a clean handoff (no overlap, no visual
 * seam since both sides paint pure #000).
 *
 * The previous version fired multicolored confetti from both bottom
 * corners — visually loud, "casino" tone, didn't match the rest of the
 * app's understated aesthetic. The new version draws a thin warm-gold
 * ring + checkmark like a wax seal, with letter-spaced typography below
 * — reads as "your authenticity is verified" rather than "you won a
 * sweepstakes".
 *
 * Timeline (single pass, no overlap with WelcomeIntro — children
 * literally don't mount until onDone fires):
 *
 *   t=0       overlay mounts on pure black
 *   t=200    ring stroke starts drawing clockwise (800ms);
 *            activate.mp3 chime fires here (synced with the ring's
 *            visible onset rather than t=0 where the ring is still
 *            invisible — chime felt "ahead" of the visual otherwise)
 *   t=1000   ring complete, check stroke starts (450ms)
 *   t=1450   check complete
 *   t=1500   "已激活" text fades up (650ms)
 *   t=2150   settle/hold (full composition visible)
 *   t=2800   content begins fading out (750ms)
 *   t=3550   onDone() → overlay unmounts → WelcomeIntro mounts
 *
 * Total ~3.55s. Premium pacing — long enough for the user to register
 * "yes this worked", short enough that they don't drum fingers waiting.
 *
 * The 750ms content fade-out IS the transition the user asked for. The
 * overlay's bg stays #000 throughout, and WelcomeIntro's bg is also
 * #000, so the unmount/mount swap at t=3550ms is invisible — the user
 * sees a held black screen, then the cursor of the brand intro appears.
 */
function CelebrationOverlay({ onDone }: { onDone: () => void }) {
  // Two-stage local state: "in" (drawing + holding the seal) → "out"
  // (content opacity fading, bg still black). We toggle classes off this
  // so React's render is the only thing driving the transition; CSS
  // does the actual work.
  const [stage, setStage] = useState<'in' | 'out'>('in');

  useEffect(() => {
    // Background audio for the seal ceremony. Constructed at mount but
    // play() is delayed ~200ms so the chime starts at the same beat the
    // ring stroke visibly begins drawing (ring has a 200ms CSS delay too)
    // — firing immediately at t=0 made the chime feel "ahead" of the
    // visual since the ring is still invisible for the first ~200ms.
    // catch() swallows browser autoplay rejections (rare in Tauri's
    // WebView2 / WKWebView for local content; we'd see it in dev console
    // if it happened).
    const audio = new Audio('/audio/activate.mp3');
    audio.preload = 'auto';
    const tPlay = setTimeout(() => {
      void audio.play().catch((err) => {
        console.warn('CelebrationOverlay activate audio play blocked:', err);
      });
    }, 200);

    const tFade = setTimeout(() => setStage('out'), 2800);
    const tDone = setTimeout(onDone, 3550);
    return () => {
      // Stop the chime if the overlay unmounts mid-play (e.g. dev-mode
      // remount under StrictMode), otherwise it'd keep ringing as an
      // orphaned element.
      clearTimeout(tPlay);
      audio.pause();
      audio.currentTime = 0;
      clearTimeout(tFade);
      clearTimeout(tDone);
    };
  }, [onDone]);

  // Brand accent blue — same hex WelcomeIntro uses for "Sub", so the
  // activated-seal feels like a continuation of the brand identity
  // rather than an unrelated celebration palette. Reads as trust /
  // verification on a black background.
  const SEAL_BLUE = '#3B9BFF';

  return (
    <div className="fixed inset-0 z-[1000] bg-black flex items-center justify-center overflow-hidden">
      <div
        className={
          'text-center transition-opacity duration-[750ms] ease-out ' +
          (stage === 'out' ? 'opacity-0' : 'opacity-100')
        }
      >
        {/* Seal: thin gold ring + checkmark, drawn with stroke-dashoffset.
            96px is large enough to read as a "stamp" without feeling
            theatrical. The radial halo behind it is intentionally subtle
            (15% alpha gold) so the eye registers warmth rather than
            "glowing element". */}
        <svg
          className="mx-auto mb-7"
          width="112"
          height="112"
          viewBox="0 0 112 112"
        >
          <defs>
            <radialGradient id="seal-halo" cx="50%" cy="50%" r="50%">
              {/* Halo rgb matches SEAL_BLUE (#3B9BFF = 59, 155, 255).
                  Alpha steps unchanged from the original gold version
                  — same falloff curve, different hue. */}
              <stop offset="0%" stopColor="rgba(59, 155, 255, 0.18)" />
              <stop offset="60%" stopColor="rgba(59, 155, 255, 0.05)" />
              <stop offset="100%" stopColor="rgba(59, 155, 255, 0)" />
            </radialGradient>
          </defs>
          <circle cx="56" cy="56" r="54" fill="url(#seal-halo)" />
          {/* Outer ring — circumference 2π·42 ≈ 263.9. We draw clockwise
              from top by rotating the element so the dashoffset animation
              starts at 12 o'clock (where the eye anchors). */}
          <circle
            cx="56"
            cy="56"
            r="42"
            fill="none"
            stroke={SEAL_BLUE}
            strokeWidth="1.25"
            strokeDasharray="263.9"
            strokeDashoffset="263.9"
            transform="rotate(-90 56 56)"
            className="seal-ring"
          />
          {/* Checkmark — three-point polyline, length ≈ 38. Drawn after
              ring finishes. strokeLinecap=round so the tips look hand-
              engraved rather than blocky. */}
          <path
            d="M 38 57 L 51 70 L 76 43"
            fill="none"
            stroke={SEAL_BLUE}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="50"
            strokeDashoffset="50"
            className="seal-check"
          />
        </svg>

        {/* "已激活" — large, wide letter-spacing for "engraved plate"
            feel. font-medium (not bold) keeps it restrained. The opacity
            animation starts at 1500ms so the text appears AFTER the
            check completes — never compete for attention with the seal. */}
        <h1
          className="text-[26px] font-medium text-blue-300/90 seal-title"
          style={{ letterSpacing: '0.45em', paddingLeft: '0.45em' }}
        >
          已激活
        </h1>
      </div>

      {/* All keyframes inline — no Tailwind config thrash for a one-shot
          component. ease-out for the strokes (decelerates into place),
          ease-out for the text-fade so the translateY settles smoothly. */}
      <style>{`
        @keyframes seal-draw-ring {
          to { stroke-dashoffset: 0; }
        }
        @keyframes seal-draw-check {
          to { stroke-dashoffset: 0; }
        }
        @keyframes seal-fade-up {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .seal-ring {
          animation: seal-draw-ring 800ms 200ms cubic-bezier(0.32, 0.72, 0.32, 1) forwards;
        }
        .seal-check {
          animation: seal-draw-check 450ms 1000ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
        }
        .seal-title {
          opacity: 0;
          animation: seal-fade-up 650ms 1500ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
    </div>
  );
}

function ActivationScreen() {
  const { activate, activating, error, clearError, trial, trialFetchError } =
    useLicense();
  const [key, setKey] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await activate(key);
  }

  // Branch the header copy based on how the user got here:
  //   - trial exists AND expired → "试用已结束" pitch
  //   - trialFetchError set      → "首次需联网领取试用" hint
  //   - else (cold first launch w/ no trial yet) → original welcome
  const trialExpired =
    !!trial && trial.expiresAt > 0 && Date.now() >= trial.expiresAt;
  const trialNetworkError = !!trialFetchError && !trial;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          {trialExpired ? (
            <p className="text-zinc-400 text-sm mb-1">24 小时试用已结束</p>
          ) : (
            <p className="text-zinc-400 text-sm mb-1">嘿～欢迎来到</p>
          )}
          {/* Brand name in Caveat handwriting font (same as the welcome
              animation) — "what" white, "Sub" blue, matching the intro's
              two-tone styling so the activation screen feels like the
              opening page of the same book. */}
          <div className="font-handwrite font-bold text-5xl leading-none mb-3">
            <span className="text-white">what</span>
            <span className="text-blue-400">Sub</span>
          </div>
          {trialExpired ? (
            <p className="text-sm text-zinc-400">
              输入授权码即可继续使用，所有数据都还在 💝
            </p>
          ) : (
            <p className="text-sm text-zinc-400">
              贴一下你的授权码，就可以使用啦 ~
            </p>
          )}
        </div>

        {trialNetworkError && (
          <div className="mb-4 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200 flex gap-2">
            <WifiOff className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">
              <div className="font-medium">
                没有连上服务器，暂时没法领取免费试用
              </div>
              <div className="text-amber-300/70 mt-0.5">
                请检查网络后重启 whatsub —— 系统会自动赠送你 24 小时试用。
                如果你已经有授权码也可以直接输入下方激活。
              </div>
            </div>
          </div>
        )}

        <form
          onSubmit={onSubmit}
          className="bg-zinc-900 rounded-lg p-5 border border-zinc-800"
        >
          <label className="block text-xs text-zinc-400 mb-1.5">授权码</label>
          <input
            type="text"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (error) clearError();
            }}
            placeholder="WHATSUB-XXXX-XXXX-XXXX-XXXX"
            spellCheck={false}
            autoComplete="off"
            disabled={activating}
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-sm font-mono uppercase tracking-wide focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />

          {error && <ErrorDisplay error={error} />}

          <button
            type="submit"
            disabled={activating || !key.trim()}
            className="mt-4 w-full bg-blue-500 hover:bg-blue-400 disabled:opacity-50 disabled:hover:bg-blue-500 text-black font-medium px-4 py-2 rounded text-sm flex items-center justify-center gap-2"
          >
            {activating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                马上就好～第一次见面可能要 10-15 秒
              </>
            ) : (
              '走起 →'
            )}
          </button>
        </form>

        <p className="text-[11px] text-zinc-500 mt-4 leading-relaxed text-center">
          支持 <span className="text-zinc-300 font-medium">3 台设备</span>同时陪你使用，永久有效 💝
          <br />
          换电脑想转移？私信客服免费帮你挪一下设备槽位～
        </p>
      </div>
    </div>
  );
}

function ErrorDisplay({ error }: { error: ActivateError }) {
  if (error.kind === 'invalid_key') {
    return (
      <div className="mt-3 px-3 py-2 bg-rose-500/10 border border-rose-500/30 rounded text-xs text-rose-200 flex gap-2">
        <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
        <div>
          <div className="font-medium">授权码无效</div>
          <div className="text-rose-300/70 mt-0.5">
            请检查是否输错（不区分大小写，连字符可省略）
          </div>
        </div>
      </div>
    );
  }

  if (error.kind === 'device_limit') {
    return (
      <div className="mt-3 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200">
        <div className="flex gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">
              该授权码已激活 {error.devices.length} 台设备（上限 {error.maxDevices}）
            </div>
            <div className="mt-1.5 space-y-0.5 font-mono">
              {error.devices.map((d, i) => (
                <div key={i} className="flex justify-between text-amber-300/80">
                  <span>{d.deviceLabel}</span>
                  <span className="text-amber-400/50">…{d.fingerprintTail}</span>
                </div>
              ))}
            </div>
            <div className="text-amber-300/70 mt-2">
              请联系客服释放一台后再激活，或购买额外授权
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error.kind === 'network') {
    // Network kind is almost always GFW-induced TCP throttling on the
    // Cloudflare edge — RST-on-SYN until a reachable POP responds. Re-
    // hitting the button literally retries through a different path and
    // usually succeeds within 2-3 tries. Friendlier amber styling instead
    // of rose so the user reads this as "try again" not "something is
    // broken" — the technical stderr stays available but de-emphasised.
    return (
      <div className="mt-3 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200 flex gap-2">
        <Cloud className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium">这次没连上 —— 再点一次「走起」试试 👉</div>
          <div className="text-amber-300/80 mt-1 leading-relaxed">
            激活服务器在 Cloudflare，国内首次握手经常会被「卡一下」，
            <span className="text-amber-200 font-medium">多试 2-3 次通常就能成功</span>。
            如果反复失败，请检查网络是否畅通后再来～
          </div>
          <div className="text-amber-300/40 mt-1 text-[10px] font-mono break-all">
            {error.message}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 px-3 py-2 bg-rose-500/10 border border-rose-500/30 rounded text-xs text-rose-200">
      {('message' in error && error.message) || '未知错误，请重试'}
    </div>
  );
}
