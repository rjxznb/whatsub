/**
 * License-side type contracts shared between the Rust invoke layer, the
 * Cloudflare Worker, and the React UI.
 */

/** Stored locally as `<app-data>/license.json` after successful activation. */
export interface LicenseState {
  key: string;
  fingerprint: string;
  deviceLabel: string;
  activatedAt: number;
}

/** What the Rust `license_get_device_info` command returns. */
export interface DeviceInfo {
  fingerprint: string;
  deviceLabel: string;
}

/** Server `/api/activate` response shape — keep in lockstep with the Worker
 *  in `license-server/src/routes/activate.ts`. */
export type ActivateResponse =
  | { status: 'active' }
  | {
      status: 'device_limit';
      maxDevices: number;
      devices: { deviceLabel: string; activatedAt: number; fingerprintTail: string }[];
    }
  | { status: 'invalid_key' }
  | { status: 'bad_request'; detail: string };

/** Two-state machine: NEEDS_KEY → ACTIVE. No revocation in v1. */
export type LicenseMode = 'NEEDS_KEY' | 'ACTIVE';

/** Hard-coded URL of the deployed Cloudflare Worker. Embedded at build
 *  time so the user can't redirect to a fake activation server via
 *  settings. To rotate this URL we'd need to ship a new version. */
export const ACTIVATE_ENDPOINT =
  'https://whatsub-license.2216681472.workers.dev/api/activate';
