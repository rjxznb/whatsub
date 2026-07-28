import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import { useAuth } from '../store/auth';
import { useLicense } from '../store/license';
import { authCommandErrorToChinese, authReasonToChinese } from '../utils/authError';

/** In-app email-OTP login, usable anywhere (Settings 账号区 / Corpus gate).
 *
 *  Purpose: obtain a cloud *identity* (session = email) decoupled from the
 *  app-unlock mode. A trial/free user logs into their mobile account here so
 *  云同步/语料库 work under that email (synced items show up on their phone); a
 *  买断 user can switch the active account to whichever email holds their Pro
 *  subscription. Identity is always the single logged-in email — entitlement is
 *  never summed across emails (that would let one subscription be shared by many
 *  accounts), so the same login that grants access here can't be farmed.
 *
 *  On success we re-run `useLicense.init()` so that if the email turns out to
 *  hold a subscription the gate flips to SUB_ACTIVE; for a plain trial login it
 *  stays TRIAL_ACTIVE with a session now attached. */
export function AccountLoginDialog({
  open,
  onClose,
  title = '登录账号',
  hint,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  hint?: string;
}) {
  const sendCode = useAuth((s) => s.sendCode);
  const verifyCode = useAuth((s) => s.verifyCode);
  const initLicense = useLicense((s) => s.init);

  const [phase, setPhase] = useState<'email' | 'code' | 'verifying'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!open) return null;

  function reset() {
    setPhase('email');
    setEmail('');
    setCode('');
    setError(null);
    setSending(false);
  }

  // Preserve the typed email/code on close — an accidental backdrop/✕ click
  // mid-flow shouldn't wipe an in-progress login (which then reaches verify
  // with an empty email → backend `invalid_input`). State is reset only after
  // a successful login.
  function close() {
    onClose();
  }

  async function submitEmail(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('邮箱格式不对');
      return;
    }
    setSending(true);
    try {
      const res = await sendCode(trimmed);
      if (!res.ok) setError(authReasonToChinese(res.reason));
      else setPhase('code');
    } catch (err) {
      setError(authCommandErrorToChinese(err, 'send'));
    } finally {
      setSending(false);
    }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      // Defensive: if the email state was somehow lost, go back to step 1
      // rather than POSTing an empty email (which the backend 400s as
      // `invalid_input`).
      setError('邮箱信息丢失了，请重新输入邮箱获取验证码');
      setPhase('email');
      return;
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError('验证码应为 6 位数字');
      return;
    }
    setPhase('verifying');
    try {
      const res = await verifyCode(email.trim(), code.trim());
      if (!res.ok) {
        setError(authReasonToChinese(res.reason));
        setPhase('code');
        return;
      }
      // Re-evaluate app-unlock mode (a subscriber → SUB_ACTIVE). Best-effort.
      await initLicense().catch(() => {});
      reset();
      onClose();
    } catch (err) {
      setError(authCommandErrorToChinese(err, 'verify'));
      setPhase('code');
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          <button
            type="button"
            onClick={close}
            className="text-zinc-500 hover:text-zinc-300 -mr-1 -mt-1 p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {hint && (
          <p className="text-[11px] text-zinc-400 leading-relaxed mb-3">{hint}</p>
        )}

        {phase === 'email' && (
          <form onSubmit={submitEmail} className="space-y-2">
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(null);
              }}
              placeholder="手机端 / 订阅时使用的邮箱"
              autoComplete="email"
              disabled={sending}
              autoFocus
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
          <form onSubmit={submitCode} className="space-y-2">
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
              autoFocus
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
                '登录'
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
      </div>
    </div>,
    document.body,
  );
}
