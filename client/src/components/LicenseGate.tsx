import { useEffect, useRef, useState, type ReactNode } from 'react';
import confetti from 'canvas-confetti';
import { Loader2, HandHeart, ShieldAlert, Cloud } from 'lucide-react';
import { useLicense, type ActivateError } from '../store/license';

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

  // mode === 'ACTIVE'
  if (celebrating) {
    return <CelebrationOverlay onDone={() => setCelebrating(false)} />;
  }

  return <>{children}</>;
}

/**
 * Full-screen overlay that fires confetti from both bottom corners,
 * shows a brief "激活成功" message, then auto-dismisses. Inspired by
 * Typora's license-activation celebration.
 *
 * Timing:
 *   t=0ms     mount, fire first burst (left + right simultaneous)
 *   t=300ms   second burst (denser, more colors)
 *   t=900ms   third smaller burst (ride-out)
 *   t=2500ms  call onDone() → unmount, children render → WelcomeIntro
 *
 * Why three bursts: a single fire-and-forget burst peaks for ~1s then
 * dies. Three staggered bursts give a sustained 2-second cascade that
 * matches the visual weight of "this is a meaningful moment".
 */
function CelebrationOverlay({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    fireConfetti();
    const t1 = setTimeout(fireConfetti, 300);
    const t2 = setTimeout(() => fireConfetti(0.7), 900);
    const dismiss = setTimeout(onDone, 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(dismiss);
    };
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-[1000] bg-zinc-950 flex items-center justify-center overflow-hidden">
      <div className="text-center animate-fade-in-scale">
        <div className="text-6xl mb-4">🎉</div>
        <h1 className="text-2xl font-semibold text-emerald-400 tracking-wide">
          激活成功
        </h1>
        <p className="text-sm text-zinc-400 mt-3">
          欢迎使用 whatsub
        </p>
      </div>
      {/* tiny inline animation for the message — Tailwind doesn't ship
          a "scale-fade-in" by default and we don't want to thread a
          framer-motion dep just for one transition. */}
      <style>{`
        @keyframes fadeInScale {
          from { opacity: 0; transform: scale(0.85); }
          to   { opacity: 1; transform: scale(1); }
        }
        .animate-fade-in-scale {
          animation: fadeInScale 500ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
    </div>
  );
}

/**
 * Fire two confetti volleys, one from each bottom corner, shooting
 * upward + inward. The `intensity` arg scales particle count for the
 * tail bursts (so the third burst is smaller than the first two).
 *
 * Color palette is intentionally festive — blue / emerald / amber /
 * rose / violet — matching the app's accent colors with extra warm
 * shades thrown in for the "fireworks" feel.
 */
function fireConfetti(intensity = 1.0): void {
  const colors = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#ef4444', // rose
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#fbbf24', // gold
  ];

  // Left side: shooting up-right (angle 60° from horizontal)
  confetti({
    particleCount: Math.round(80 * intensity),
    angle: 60,
    spread: 70,
    origin: { x: 0, y: 0.7 },
    colors,
    startVelocity: 55,
    gravity: 1.0,
    ticks: 200,
  });

  // Right side: mirror — shooting up-left (angle 120°)
  confetti({
    particleCount: Math.round(80 * intensity),
    angle: 120,
    spread: 70,
    origin: { x: 1, y: 0.7 },
    colors,
    startVelocity: 55,
    gravity: 1.0,
    ticks: 200,
  });
}

function ActivationScreen() {
  const { activate, activating, error, clearError } = useLicense();
  const [key, setKey] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await activate(key);
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          {/* HandHeart icon — a hand offering a heart, more serve-the-user-
              warmly than the original lock-and-key glyph. Warm amber→rose
              gradient bubble with a soft glow shadow, contrasting the rest
              of the dark UI. */}
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-amber-300/30 via-rose-400/20 to-pink-400/15 text-amber-300 mb-4 shadow-[0_0_30px_rgba(251,191,36,0.2)]">
            <HandHeart className="w-7 h-7" />
          </div>
          <p className="text-zinc-400 text-sm mb-1">嘿～欢迎来到</p>
          {/* Brand name in Caveat handwriting font (same as the welcome
              animation) — "what" white, "Sub" blue, matching the intro's
              two-tone styling so the activation screen feels like the
              opening page of the same book. */}
          <div className="font-handwrite font-bold text-5xl leading-none mb-3">
            <span className="text-white">what</span>
            <span className="text-blue-400">Sub</span>
          </div>
          <p className="text-sm text-zinc-400">
            贴一下你的授权码，咱们就正式认识啦 ✨
          </p>
        </div>

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
