import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SubLoginForm } from './LicenseGate';

const invokeMock = vi.hoisted(() => vi.fn());
const license = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('../store/license', () => ({
  useLicense: () => license,
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

async function moveToCodeForm() {
  fireEvent.change(screen.getByPlaceholderText('订阅时使用的邮箱'), {
    target: { value: 'pro@example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: '获取邮箱验证码' }));
  await screen.findByText(/已发送到/);
}

describe('LicenseGate subscription OTP recovery', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    license.init.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('restores the code form after an uncertain verification result', async () => {
    // Removing the verify catch's setPhase('code') would strand the OTP in a
    // disabled verifying state, so this test protects that visible recovery.
    const verification = deferred<{ ok: boolean }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'auth_send_code') return Promise.resolve({ ok: true });
      if (command === 'auth_verify_code') return verification.promise;
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<SubLoginForm />);
    await moveToCodeForm();
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: '登录解锁' }));

    expect(screen.getByText('正在验证…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '正在验证…' })).toBeDisabled();

    verification.reject('auth_result_uncertain');

    await screen.findByText('登录结果未确认，请再次尝试；如果验证码已失效，请重新获取。');

    expect(screen.getByText('pro@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('000000')).toHaveValue('654321');
    expect(screen.queryByText('正在验证…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录解锁' })).toBeEnabled();
  });

  it('keeps send-code retryable after a transport failure without retrying it', async () => {
    // Removing sendCode's finally would keep the button in its loading state;
    // retrying this command in the UI would send duplicate OTP emails.
    const send = deferred<{ ok: boolean }>();
    invokeMock.mockReturnValueOnce(send.promise);

    render(<SubLoginForm />);
    fireEvent.change(screen.getByPlaceholderText('订阅时使用的邮箱'), {
      target: { value: 'pro@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '获取邮箱验证码' }));

    expect(screen.getByText('正在发送验证码…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '正在发送验证码…' })).toBeDisabled();

    send.reject('error sending request for url (https://private.example)');

    await screen.findByText('发送验证码失败，请稍后重试。');

    expect(screen.queryByText('正在发送验证码…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '获取邮箱验证码' })).toBeEnabled();
    expect(screen.queryByText(/error sending request for url/)).not.toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
