import { useState } from 'react';
import { useAuth } from '../store/auth';

type Stage = 'email' | 'code';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: '邮箱格式不正确',
  wrong_code: '验证码错误',
  too_many_attempts: '尝试次数过多，请重新发送验证码',
  no_code: '验证码已过期，请重新发送',
};

export function AuthCard() {
  const { sendCode, verifyCode } = useAuth();
  const [stage, setStage] = useState<Stage>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submitEmail = async () => {
    if (!email.includes('@')) {
      setError('请输入有效邮箱');
      return;
    }
    setBusy(true);
    setError('');
    const r = await sendCode(email);
    setBusy(false);
    if (r.ok) {
      setStage('code');
    } else {
      setError(ERROR_MESSAGES[r.reason ?? ''] ?? '发送失败，请稍后再试');
    }
  };

  const submitCode = async () => {
    setBusy(true);
    setError('');
    const r = await verifyCode(email, code);
    setBusy(false);
    if (!r.ok) {
      setError(ERROR_MESSAGES[r.reason ?? ''] ?? '验证失败');
    }
    // On success, useAuth.refresh fires from inside verifyCode and the
    // AuthGate parent re-renders past us.
  };

  return (
    <div className="max-w-sm mx-auto p-6 space-y-4 bg-zinc-800 rounded-lg border border-zinc-700">
      <h2 className="text-base font-semibold">登录 whatSub</h2>
      <p className="text-xs text-zinc-400">使用邮箱接收验证码，无需密码</p>
      {stage === 'email' ? (
        <>
          <input
            type="email" placeholder="邮箱" value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm"
          />
          <button onClick={submitEmail} disabled={busy}
            className="w-full bg-blue-500 hover:bg-blue-400 text-black font-medium px-4 py-2 rounded text-sm disabled:opacity-50">
            {busy ? '发送中...' : '发送验证码'}
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-zinc-400">验证码已发送至 {email}</p>
          <input
            type="text" placeholder="6 位验证码" value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submitCode()}
            maxLength={6}
            className="w-full px-3 py-2 bg-zinc-900 border border-zinc-700 rounded text-sm tracking-widest text-center"
          />
          <button onClick={submitCode} disabled={busy || code.length !== 6}
            className="w-full bg-blue-500 hover:bg-blue-400 text-black font-medium px-4 py-2 rounded text-sm disabled:opacity-50">
            {busy ? '验证中...' : '验证'}
          </button>
          <button onClick={() => { setStage('email'); setCode(''); setError(''); }}
            className="w-full text-xs text-zinc-400 hover:text-zinc-200">
            换个邮箱
          </button>
        </>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
