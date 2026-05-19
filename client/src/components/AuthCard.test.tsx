import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthCard } from './AuthCard';
import { useAuth } from '../store/auth';

vi.mock('../store/auth', () => {
  const state = {
    sendCode: vi.fn(),
    verifyCode: vi.fn(),
  };
  return {
    useAuth: Object.assign(() => state, {
      getState: () => state,
      setState: () => {},
    }),
  };
});

beforeEach(() => {
  const s = useAuth.getState();
  (s.sendCode as ReturnType<typeof vi.fn>).mockReset();
  (s.verifyCode as ReturnType<typeof vi.fn>).mockReset();
});

describe('AuthCard', () => {
  it('renders email input on mount', () => {
    render(<AuthCard />);
    expect(screen.getByPlaceholderText(/邮箱/)).toBeDefined();
  });

  it('submits email and shows code field on success', async () => {
    const s = useAuth.getState();
    (s.sendCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    render(<AuthCard />);
    fireEvent.change(screen.getByPlaceholderText(/邮箱/), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /发送验证码/ }));
    await waitFor(() => expect(screen.getByPlaceholderText(/验证码/)).toBeDefined());
  });

  it('shows wrong_code error', async () => {
    const s = useAuth.getState();
    (s.sendCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    (s.verifyCode as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, reason: 'wrong_code' });
    render(<AuthCard />);
    fireEvent.change(screen.getByPlaceholderText(/邮箱/), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /发送验证码/ }));
    await waitFor(() => screen.getByPlaceholderText(/验证码/));
    fireEvent.change(screen.getByPlaceholderText(/验证码/), { target: { value: '999999' } });
    fireEvent.click(screen.getByRole('button', { name: /^验证$/ }));
    await waitFor(() => expect(screen.getByText(/验证码错误/)).toBeDefined());
  });
});
