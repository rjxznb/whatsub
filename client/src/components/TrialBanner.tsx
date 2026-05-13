import { useEffect, useState } from 'react';
import { Clock, ChevronRight } from 'lucide-react';
import { useLicense } from '../store/license';

/**
 * Slim top-of-app banner shown while `mode === 'TRIAL_ACTIVE'`. Renders
 * a live countdown to the trial expiry timestamp on the store, plus an
 * "激活完整版" button that flips the gate to NEEDS_KEY immediately so
 * the user can enter a key without waiting for the countdown to hit
 * zero.
 *
 * Ticks every second. When `now >= expiresAt` it calls
 * `markTrialExpired()` so the parent LicenseGate flips back to
 * NEEDS_KEY mid-session (no need to restart the app).
 *
 * Color states:
 *   - blue (default)      → > 1h remaining; gentle reminder
 *   - amber (warning)     → ≤ 1h remaining; "即将到期"
 */
export function TrialBanner() {
  const trial = useLicense((s) => s.trial);
  const markTrialExpired = useLicense((s) => s.markTrialExpired);
  // `now` ticks every second; pulling it from state lets React re-render
  // the countdown without us reaching directly into the DOM.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!trial) return null;

  const remainingMs = trial.expiresAt - now;
  if (remainingMs <= 0) {
    // Defensive: schedule the flip via setTimeout(0) so we don't call
    // setState during another component's render in dev StrictMode.
    setTimeout(markTrialExpired, 0);
    return null;
  }

  const isWarning = remainingMs <= 60 * 60 * 1000;
  const countdown = formatRemaining(remainingMs);

  // Color palette: blue is the brand accent (same as activation screen
  // checkmark), amber warns without being alarming. We deliberately
  // don't go red — trial expiry isn't an error, just a milestone.
  const colorClasses = isWarning
    ? 'bg-amber-500/15 border-amber-500/40 text-amber-100'
    : 'bg-blue-500/10 border-blue-500/30 text-blue-100';

  return (
    <div
      className={
        'flex items-center justify-center gap-3 px-4 py-1.5 text-xs border-b ' +
        colorClasses
      }
    >
      <Clock className="w-3.5 h-3.5 shrink-0" />
      <span className="font-medium">
        {isWarning ? '试用即将到期' : '试用版'} · 剩余
        <span className="tabular-nums ml-1.5">{countdown}</span>
      </span>
      <button
        type="button"
        onClick={markTrialExpired}
        className={
          'inline-flex items-center gap-0.5 ml-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors ' +
          (isWarning
            ? 'bg-amber-500 text-black hover:bg-amber-400'
            : 'bg-blue-500 text-black hover:bg-blue-400')
        }
      >
        激活完整版
        <ChevronRight className="w-3 h-3" />
      </button>
    </div>
  );
}

/** Format remaining ms as `HH:MM:SS`. For shorter periods we still
 *  pad the hours field so the layout doesn't jitter as digits drop. */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
