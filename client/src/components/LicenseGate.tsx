import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, ShieldAlert, Cloud, WifiOff, ArrowLeft, Mail, ChevronDown, KeyRound } from 'lucide-react';
import { useLicense, type ActivateError } from '../store/license';
import { MONTHLY_PRICE_TEXT, YEARLY_PRICE_TEXT } from '../config/subscriptionPricing';
import { TrialBanner } from './TrialBanner';
import { authCommandErrorToChinese, authReasonToChinese } from '../utils/authError';

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

  // While the activation screen is up the BrowserRouter (children) is
  // UNMOUNTED, but window.location still holds whatever route the user was on
  // before the gate flipped to NEEDS_KEY — e.g. /settings, if they hit "激活
  // 完整版" from the TrialBanner while on the Settings page. React Router reads
  // window.location on mount, so when the user unlocks (license → ACTIVE, or
  // email OTP → SUB_ACTIVE) the router would remount on that stale /settings
  // path and drop them on Settings instead of /library — skipping the welcome
  // intro entirely (FirstRunGate only wraps /library). Reset the URL to root
  // NOW, while the router is unmounted, so any unlock path remounts on
  // /library and the welcome animation plays.
  useEffect(() => {
    if (mode === 'NEEDS_KEY') {
      try {
        window.history.replaceState(null, '', '/');
      } catch {
        /* ignore — non-browser env or locked-down history API */
      }
    }
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

  // mode === 'ACTIVE' / 'SUB_ACTIVE' / 'TRIAL_ACTIVE' — children render
  // in all three cases. Celebration only fires on the
  // NEEDS_KEY → ACTIVE transition (real license activation), not on
  // trial start; the trial banner already signals "you got access".
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

  // SUB_ACTIVE (pure Pro subscriber) renders the app just like ACTIVE. The
  // former fixed top-right "★ Pro 订阅中" pill was removed 2026-06-05 — it
  // overlapped the top-right settings button. Subscription status now lives
  // in Settings → 账户 (see AccountSection) instead.
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
          {/* Checkmark — three-point polyline. Actual path length is ≈55.2
              (18.4 + 36.8), NOT the ~38 an earlier comment claimed: the
              dash/offset MUST be ≥ that or the draw animation stops short and
              the long-stroke tip is clipped ("对勾显示不全"). 60 gives margin.
              Drawn after the ring finishes; strokeLinecap=round so the tips
              look hand-engraved rather than blocky. */}
          <path
            d="M 38 57 L 51 70 L 76 43"
            fill="none"
            stroke={SEAL_BLUE}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="60"
            strokeDashoffset="60"
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
  const { activate, activating, error, clearError, trial, trialFetchError, resumeTrial } =
    useLicense();
  const [key, setKey] = useState('');
  // Which unlock method is expanded. Both start collapsed (just a button);
  // clicking one animates it open and collapses the other (accordion).
  const [expanded, setExpanded] = useState<'none' | 'buyout' | 'sub'>('none');

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
  // 只有「试用还活着」时才显示返回按钮 —— 用户是从 TrialBanner 主动点
  // 「激活完整版」过来的,改主意了应该能回到试用模式继续用。试用真过期
  // 或根本没领到试用(首次离线启动)时,没地方可退,不显示按钮。
  const canResumeTrial = !!trial && !trialExpired;

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center px-4 py-8">
      {canResumeTrial && (
        <button
          type="button"
          onClick={resumeTrial}
          className="absolute top-4 left-4 flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 px-2 py-1 rounded transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          继续试用
        </button>
      )}
      <div className="w-full max-w-2xl">
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
          <p className="text-sm text-zinc-400">
            {trialExpired
              ? '选择一种方式继续使用，数据都还在 💝'
              : '选择一种方式解锁完整版 ~'}
          </p>
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
                如果你已经有授权码或订阅，也可以用下方任一方式解锁。
              </div>
            </div>
          </div>
        )}

        {/* Two unlock methods side by side, each a collapsed button that
            animates open on click (accordion — opening one closes the other). */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
          <CollapseCard
            icon={KeyRound}
            title="输入授权码"
            subtitle="买断 · 永久有效 · 3 台设备"
            open={expanded === 'buyout'}
            onToggle={() => setExpanded((e) => (e === 'buyout' ? 'none' : 'buyout'))}
          >
            <form onSubmit={onSubmit} className="space-y-3">
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
                className="w-full bg-blue-500 hover:bg-blue-400 disabled:opacity-50 disabled:hover:bg-blue-500 text-black font-medium px-4 py-2 rounded text-sm flex items-center justify-center gap-2"
              >
                {activating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    正在验证授权码...
                  </>
                ) : (
                  '走起 →'
                )}
              </button>
              <p className="text-[11px] text-zinc-500 leading-relaxed">
                换电脑想转移？私信客服免费帮你挪一下设备槽位～
              </p>
            </form>
          </CollapseCard>

          <CollapseCard
            icon={Mail}
            title="邮箱登录"
            subtitle="已订阅 Pro · 用邮箱解锁"
            open={expanded === 'sub'}
            onToggle={() => setExpanded((e) => (e === 'sub' ? 'none' : 'sub'))}
          >
            <SubLoginForm />
          </CollapseCard>
        </div>
      </div>
    </div>
  );
}

/** Collapsible method card: an always-visible header button (icon + title +
 *  subtitle + chevron) and a body that expands via a grid-rows 0fr↔1fr
 *  transition. Used by ActivationScreen for the two unlock methods. */
function CollapseCard({
  icon: Icon,
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  icon: typeof KeyRound;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={
        'rounded-lg border bg-zinc-900 transition-colors ' +
        (open ? 'border-blue-500/50' : 'border-zinc-800')
      }
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <span
          className={
            'shrink-0 grid place-items-center w-8 h-8 rounded-full transition-colors ' +
            (open ? 'bg-blue-500/20 text-blue-300' : 'bg-zinc-800 text-zinc-400')
          }
        >
          <Icon className="w-4 h-4" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-zinc-100">{title}</span>
          <span className="block text-[11px] text-zinc-500 truncate">{subtitle}</span>
        </span>
        <ChevronDown
          className={'w-4 h-4 text-zinc-500 transition-transform duration-300 ' + (open ? 'rotate-180' : '')}
        />
      </button>
      <div
        className={
          'grid transition-all duration-300 ease-in-out ' +
          (open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')
        }
      >
        <div className="overflow-hidden min-h-0">
          <div className="px-4 pb-4 pt-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** Email-OTP login for pure Pro subscribers (no buyout license). 3 phases:
 *  'email' → send code · 'code' → enter 6-digit code · 'verifying' → POSTing.
 *  On success re-inits the license store; if that email holds a subscription
 *  init() walks the SUB_ACTIVE branch → the gate dissolves and this form
 *  unmounts. Rendered inside a CollapseCard, which owns the expand/collapse.
 *
 *  2026-07-13 — the success path MUST still reset `phase`. It used to rely on
 *  "init() flips the mode → we get unmounted, so no reset needed". That holds
 *  only for a subscriber. Log in with an email that has NO subscription and
 *  init() lands back on NEEDS_KEY, the gate does NOT unmount, and `phase`
 *  stays 'verifying' forever = an infinite spinner with no error. Auth had in
 *  fact succeeded. Always reset, and tell the user their email has no active
 *  subscription instead of silently spinning. */
export function SubLoginForm() {
  const { init } = useLicense();
  const [phase, setPhase] = useState<'email' | 'code' | 'verifying'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('邮箱格式不对');
      return;
    }
    setSending(true);
    try {
      const res = await invoke<{ ok: boolean; reason?: string }>(
        'auth_send_code',
        { email: trimmed },
      );
      if (!res.ok) {
        setError(authReasonToChinese(res.reason));
      } else {
        setPhase('code');
      }
    } catch (e) {
      setError(authCommandErrorToChinese(e, 'send'));
    } finally {
      setSending(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError('验证码应为 6 位数字');
      return;
    }
    setPhase('verifying');
    try {
      const res = await invoke<{ ok: boolean; reason?: string }>(
        'auth_verify_code',
        { email: email.trim(), code: code.trim() },
      );
      if (!res.ok) {
        setError(authReasonToChinese(res.reason));
        setPhase('code');
        return;
      }
      // Auth succeeded (session persisted). Re-evaluate the unlock mode: a
      // subscriber flips to SUB_ACTIVE and this component unmounts mid-await.
      await init();
      // Still mounted ⇒ init() did NOT unlock (email has no active
      // subscription). Reset out of 'verifying' — never leave the spinner
      // running — and say why.
      setPhase('code');
      setError(
        '该邮箱没有有效订阅，无法解锁。请输入授权码，或用持有订阅的邮箱登录。',
      );
    } catch (e) {
      setError(authCommandErrorToChinese(e, 'verify'));
      setPhase('code');
    }
  }

  return (
    <div className="space-y-2">
      {phase === 'email' && (
        <form onSubmit={sendCode} className="space-y-2">
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder="订阅时使用的邮箱"
            autoComplete="email"
            disabled={sending}
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={sending || !email.trim()}
            className="w-full bg-blue-500 hover:bg-blue-400 disabled:opacity-50 disabled:hover:bg-blue-500 text-black font-medium px-4 py-2 rounded text-sm flex items-center justify-center gap-2"
          >
            {sending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                正在发送验证码…
              </>
            ) : (
              '获取邮箱验证码'
            )}
          </button>
        </form>
      )}

      {(phase === 'code' || phase === 'verifying') && (
        <form onSubmit={verify} className="space-y-2">
          <div className="text-[11px] text-zinc-500 leading-relaxed">
            已发送到 <span className="text-zinc-300 font-mono">{email}</span>，请填入收到的 6 位验证码。
          </div>
          <input
            type="text"
            value={code}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(v);
              if (error) setError(null);
            }}
            placeholder="000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            disabled={phase === 'verifying'}
            className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-base text-center font-mono tracking-[0.4em] focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={phase === 'verifying' || code.length !== 6}
            className="w-full bg-blue-500 hover:bg-blue-400 disabled:opacity-50 disabled:hover:bg-blue-500 text-black font-medium px-4 py-2 rounded text-sm flex items-center justify-center gap-2"
          >
            {phase === 'verifying' ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                正在验证…
              </>
            ) : (
              '登录解锁'
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setPhase('email');
              setCode('');
              setError(null);
            }}
            className="w-full text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            改用其他邮箱
          </button>
        </form>
      )}

      {error && <p className="mt-1 text-[11px] text-rose-300">{error}</p>}

      <p className="mt-2 text-[10px] text-zinc-600 leading-relaxed">
        订阅了 whatSub Pro（月度 {MONTHLY_PRICE_TEXT} / 年度 {YEARLY_PRICE_TEXT}）？用同一邮箱登录即可解锁，无需买断授权码。
      </p>
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
    // Network errors post-migration (2026-05-09) hit our Aliyun ECS at
    // whatsub.eversay.cc — usual latency is <200ms from mainland. A
    // failure here almost always means: no network, DNS hiccup, or the
    // ECS itself is down. The old "Cloudflare GFW handshake" copy was
    // misleading and survived past the migration; killed in v0.1.45.
    return (
      <div className="mt-3 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-200 flex gap-2">
        <Cloud className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium">这次没连上激活服务器</div>
          <div className="text-amber-300/80 mt-1 leading-relaxed">
            请检查
            <span className="text-amber-200 font-medium">网络是否畅通</span>
            (能否打开其他网站),然后再点一次「走起」重试。
            如果反复失败可能是服务器维护中,稍后再试。
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
