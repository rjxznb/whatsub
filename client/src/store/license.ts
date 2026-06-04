import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  ActivateResponse,
  DeviceInfo,
  LicenseMode,
  LicenseState,
  TrialState,
  TrialStartResponse,
} from '../types/license';
/**
 * Map a Rust-side reqwest error string (as returned by the
 * license_activate_http / license_trial_start_http commands) to a
 * user-friendly Chinese message + technical footer. The Rust side
 * tags errors with stable prefixes: timeout / connect / request /
 * decode / network / http <N> / parse. Anything not matching falls
 * through to a generic "network error" message with the raw string
 * appended so power users can still diagnose.
 */
function friendlyNetworkMessage(raw: string): string {
  if (/^timeout/i.test(raw)) {
    return '请求超时（30 秒）—— 网络太慢或服务器无响应。\n详情:' + raw;
  }
  if (/^connect/i.test(raw)) {
    return '无法连接到激活服务器 —— DNS 解析失败或网络阻断。\n常见原因:① 没联网 ② 系统时间不对导致 TLS 握手失败 ③ 杀软或代理拦截了 whatsub.eversay.cc。\n详情:' + raw;
  }
  if (/^http /i.test(raw)) {
    return '服务器返回异常 —— 可能是后端维护中,稍后再试。\n详情:' + raw;
  }
  if (/tls|certificate|ssl/i.test(raw)) {
    return 'TLS 握手失败 —— 系统时间不正确,或杀软 / 防火墙正在做 SSL 注入。请校准系统时间后重试。\n详情:' + raw;
  }
  return '网络错误:' + raw;
}

/**
 * License gate state. Mounted once at app root via `<LicenseGate>`. The
 * gate blocks the entire app until `mode === 'ACTIVE'`.
 *
 * Lifecycle:
 *   1. App mount: call `init()` → reads local license.json + device info.
 *      If license.json exists → mode = ACTIVE, app renders normally.
 *      Else → mode = NEEDS_KEY, gate renders activation modal.
 *
 *   2. User submits key: `activate(key)` → POST to /api/activate with
 *      key + fingerprint + deviceLabel. On success → save state via Rust
 *      → mode = ACTIVE.
 *
 *   3. (Optional) User wants to deactivate this device: `deactivate()` →
 *      clear local state, mode = NEEDS_KEY. (Server-side slot release
 *      requires admin; this just frees the local file.)
 */

interface LicenseStore {
  mode: LicenseMode | 'INITIALIZING';
  /** Current license state (only set when mode === 'ACTIVE'). */
  state: LicenseState | null;
  /** Current trial state. Set when mode === 'TRIAL_ACTIVE'; may also
   *  be set (with a past expiresAt) when mode === 'NEEDS_KEY' for an
   *  already-expired trial — UI uses that to show "试用已结束" copy. */
  trial: TrialState | null;
  /** Cached device info; populated on init() and reused for activation. */
  device: DeviceInfo | null;
  /** True while an /activate request is in flight. */
  activating: boolean;
  /** Last error payload from a failed activation attempt. */
  error: ActivateError | null;
  /** Non-null when init()'s `/trial/start` call failed (offline first
   *  launch). UI shows it as "首次需联网领取试用，请检查网络后重启" so
   *  the user knows why they're stuck on NEEDS_KEY despite never having
   *  used the app before. */
  trialFetchError: string | null;

  init(): Promise<void>;
  activate(key: string): Promise<boolean>;
  /** Called by the trial banner when its countdown reaches zero, or by
   *  any code path that wants to force the gate to re-check (e.g., to
   *  surface NEEDS_KEY as soon as trial expires mid-session). */
  markTrialExpired(): void;
  /** User opened the activation screen voluntarily (via "激活完整版"
   *  banner button) but changed their mind. Flip back to TRIAL_ACTIVE
   *  so they can keep using the trial. No-op if the trial has actually
   *  expired or doesn't exist — in that case there's nothing to go
   *  back to. */
  resumeTrial(): void;
  clearError(): void;
}

export type ActivateError =
  | { kind: 'invalid_key' }
  | { kind: 'device_limit'; maxDevices: number; devices: DeviceList }
  | { kind: 'network'; message: string }
  | { kind: 'bad_request'; message: string }
  | { kind: 'unknown'; message: string };

type DeviceList = {
  deviceLabel: string;
  activatedAt: number;
  fingerprintTail: string;
}[];

export const useLicense = create<LicenseStore>((set, get) => ({
  mode: 'INITIALIZING',
  state: null,
  trial: null,
  device: null,
  activating: false,
  error: null,
  trialFetchError: null,

  async init() {
    try {
      const [device, state] = await Promise.all([
        invoke<DeviceInfo>('license_get_device_info'),
        invoke<LicenseState | null>('license_read_state'),
      ]);

      // License is the strongest auth — short-circuit before touching
      // trial state. ACTIVE means trial code paths are completely
      // bypassed (no banner, no expiry watcher).
      if (state) {
        set({ device, state, mode: 'ACTIVE' });
        return;
      }

      // No license → fall through to trial flow. Read local trial.json:
      //   - present + not expired   → TRIAL_ACTIVE
      //   - present + expired       → NEEDS_KEY (banner-less; standard
      //                                activation screen with extra copy)
      //   - missing                 → POST /api/trial/start to register.
      //                                Server is authoritative on expiry.
      const localTrial = await invoke<TrialState | null>('trial_read_state');
      if (localTrial) {
        const expired = Date.now() >= localTrial.expiresAt;
        set({
          device,
          trial: localTrial,
          mode: expired ? 'NEEDS_KEY' : 'TRIAL_ACTIVE',
        });
        return;
      }

      // First launch (or trial.json was wiped). Fetch from server.
      // Server returns the same expiresAt for repeat calls with the
      // same fingerprint — that's the anti-bypass guarantee.
      const trial = await fetchTrialFromServer(device.fingerprint, device.deviceLabel);
      if (trial.ok) {
        // Persist whatever server returned so the next launch is offline-
        // friendly. mode depends on whether the server-returned trial is
        // still active (status: granted) or already expired
        // (status: already_used, expiresAt in the past).
        try {
          await invoke('trial_save_state', { state: trial.state });
        } catch (e) {
          console.warn('trial_save_state failed (non-fatal)', e);
        }
        const expired = Date.now() >= trial.state.expiresAt;
        set({
          device,
          trial: trial.state,
          mode: expired ? 'NEEDS_KEY' : 'TRIAL_ACTIVE',
        });
        return;
      }

      // Server unreachable on first launch. Stuck on NEEDS_KEY until
      // user is online OR enters a license key. trialFetchError tells
      // the activation screen to show extra copy explaining why.
      set({
        device,
        mode: 'NEEDS_KEY',
        trialFetchError: trial.error,
      });
    } catch (e) {
      // If we can't even read local state, fall through to NEEDS_KEY so
      // the user gets a chance to (re-)activate. The error surfaces in
      // the modal if they then try to submit.
      console.error('license init failed', e);
      set({
        mode: 'NEEDS_KEY',
        error: { kind: 'unknown', message: String(e) },
      });
    }
  },

  markTrialExpired() {
    // Only flip if we're currently in trial. Called from TrialBanner's
    // tick when countdown reaches zero — must be a no-op when an already-
    // active license is on file (shouldn't happen, but be defensive).
    const cur = get();
    if (cur.mode === 'TRIAL_ACTIVE') {
      set({ mode: 'NEEDS_KEY' });
    }
  },

  resumeTrial() {
    const cur = get();
    // 仅在「试用还活着」时才能回退 —— 真正过期 / 没有试用记录的情况
    // 不应该出现返回按钮(UI 已经做了门控),这里再守一道防止误调。
    if (cur.mode !== 'NEEDS_KEY') return;
    if (!cur.trial) return;
    if (Date.now() >= cur.trial.expiresAt) return;
    set({ mode: 'TRIAL_ACTIVE', error: null });
  },

  async activate(rawKey: string) {
    const key = rawKey.trim().toUpperCase();
    if (!key) {
      set({ error: { kind: 'bad_request', message: '请输入授权码' } });
      return false;
    }

    const device = get().device;
    if (!device) {
      set({ error: { kind: 'unknown', message: '设备信息未就绪，请重启应用' } });
      return false;
    }

    set({ activating: true, error: null });

    // POST goes through Rust (reqwest) instead of WebView fetch — bypasses
    // WebView2 quirks (CSP/CORS/cert chain/AV-injected MITM/etc.) that
    // surface to JS as a useless "TypeError: Failed to fetch". Rust gives
    // us categorised errors (timeout / connect / tls / etc.) we can map
    // to actionable copy. 30s timeout enforced inside the Rust command.
    let data: ActivateResponse;
    try {
      data = await invoke<ActivateResponse>('license_activate_http', {
        args: {
          key,
          fingerprint: device.fingerprint,
          deviceLabel: device.deviceLabel,
        },
      });
    } catch (e) {
      const msg = String(e);
      set({
        activating: false,
        error: { kind: 'network', message: friendlyNetworkMessage(msg) },
      });
      return false;
    }

    if (data.status === 'active') {
      const state: LicenseState = {
        key,
        fingerprint: device.fingerprint,
        deviceLabel: device.deviceLabel,
        activatedAt: Date.now(),
      };
      try {
        await invoke('license_save_state', { state });
      } catch (e) {
        set({
          activating: false,
          error: { kind: 'unknown', message: '激活成功但本地保存失败：' + String(e) },
        });
        return false;
      }
      set({
        activating: false,
        state,
        mode: 'ACTIVE',
        error: null,
      });
      return true;
    }

    if (data.status === 'invalid_key') {
      set({ activating: false, error: { kind: 'invalid_key' } });
      return false;
    }

    if (data.status === 'device_limit') {
      set({
        activating: false,
        error: {
          kind: 'device_limit',
          maxDevices: data.maxDevices,
          devices: data.devices,
        },
      });
      return false;
    }

    if (data.status === 'bad_request') {
      set({
        activating: false,
        error: { kind: 'bad_request', message: data.detail },
      });
      return false;
    }

    set({
      activating: false,
      error: { kind: 'unknown', message: 'unexpected response' },
    });
    return false;
  },

  clearError() {
    set({ error: null });
  },
}));

// ─── Trial: server fetch helper ────────────────────────────────────────

type FetchTrialResult =
  | { ok: true; state: TrialState }
  | { ok: false; error: string };

/** POST /api/trial/start. Idempotent on fingerprint — repeated calls
 *  return the SAME expiresAt the server first issued (anti-bypass).
 *  See docs/whatsub-trial-server-snippet.md for the server contract.
 *
 *  Same Rust-side reqwest path as activate() — see comment there for
 *  why we don't use WebView fetch. */
async function fetchTrialFromServer(
  fingerprint: string,
  deviceLabel: string,
): Promise<FetchTrialResult> {
  let data: TrialStartResponse;
  try {
    data = await invoke<TrialStartResponse>('license_trial_start_http', {
      args: { fingerprint, deviceLabel },
    });
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  if (data.status === 'granted' || data.status === 'already_used') {
    return {
      ok: true,
      state: {
        fingerprint,
        startedAt: data.startedAt,
        expiresAt: data.expiresAt,
        // trialToken added 2026-06-04 — server returns it on every /start
        // call (idempotent on fingerprint). Older servers (pre-relay)
        // omit it; the openai-compatible relay provider falls back to
        // session token in that case, which gracefully degrades.
        trialToken: (data as { trialToken?: string }).trialToken,
      },
    };
  }

  return { ok: false, error: data.detail || 'unexpected trial response' };
}
