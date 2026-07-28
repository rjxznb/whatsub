import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AccountLoginDialog } from './AccountLoginDialog';

const auth = vi.hoisted(() => ({
  sendCode: vi.fn(),
  verifyCode: vi.fn(),
}));
const license = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock('../store/auth', () => ({
  useAuth: (selector: (state: typeof auth) => unknown) => selector(auth),
}));
vi.mock('../store/license', () => ({
  useLicense: (selector: (state: typeof license) => unknown) => selector(license),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AccountLoginDialog OTP recovery', () => {
  beforeEach(() => {
    auth.sendCode.mockResolvedValue({ ok: true });
    auth.verifyCode.mockReset();
    license.init.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('restores the code form after a connection failure', async () => {
    // Removing the verify catch's setPhase('code') would leave the submitted
    // OTP disabled behind the spinner, so this test must fail for that break.
    const verification = deferred<{ ok: boolean }>();
    auth.verifyCode.mockReturnValueOnce(verification.promise);

    render(<AccountLoginDialog open onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText('手机端 / 订阅时使用的邮箱'), {
      target: { value: 'member@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取邮箱验证码' }));

    await screen.findByText(/已发送到/);
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(screen.getByText('正在验证…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '正在验证…' })).toBeDisabled();

    verification.reject('auth_connect_failed');

    await screen.findByText('无法连接登录服务器，请检查网络或代理后重试。');

    expect(screen.getByText('member@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('000000')).toHaveValue('123456');
    expect(screen.queryByText('正在验证…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
    expect(screen.queryByText(/error sending request for url/)).not.toBeInTheDocument();
  });
});
