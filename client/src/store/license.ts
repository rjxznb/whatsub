import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type {
  ActivateResponse,
  DeviceInfo,
  LicenseMode,
  LicenseState,
} from '../types/license';
import { ACTIVATE_ENDPOINT } from '../types/license';

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
  /** Cached device info; populated on init() and reused for activation. */
  device: DeviceInfo | null;
  /** True while an /activate request is in flight. */
  activating: boolean;
  /** Last error payload from a failed activation attempt. */
  error: ActivateError | null;

  init(): Promise<void>;
  activate(key: string): Promise<boolean>;
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
  device: null,
  activating: false,
  error: null,

  async init() {
    try {
      const [device, state] = await Promise.all([
        invoke<DeviceInfo>('license_get_device_info'),
        invoke<LicenseState | null>('license_read_state'),
      ]);
      set({
        device,
        state,
        mode: state ? 'ACTIVE' : 'NEEDS_KEY',
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

    let resp: Response;
    try {
      // 30s timeout: first activation from a Chinese network can take
      // 5-10s for the TCP handshake to settle through GFW throttling.
      // Defaulting fetch's timeout (typically 0/no-timeout in browsers,
      // ~120s in Tauri) is fine but we guard explicitly anyway.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        resp = await fetch(ACTIVATE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key,
            fingerprint: device.fingerprint,
            deviceLabel: device.deviceLabel,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        activating: false,
        error: {
          kind: 'network',
          message: /aborted/i.test(msg)
            ? '请求超时（30 秒），可能是网络太慢，请检查网络后重试'
            : '网络错误：' + msg,
        },
      });
      return false;
    }

    let data: ActivateResponse;
    try {
      data = (await resp.json()) as ActivateResponse;
    } catch {
      set({
        activating: false,
        error: { kind: 'unknown', message: `服务器返回异常 (HTTP ${resp.status})` },
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
