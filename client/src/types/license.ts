/**
 * License-side type contracts shared between the Rust invoke layer, the
 * activation server (Hono on Aliyun, behind `whatsub.eversay.cc`), and
 * the React UI.
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

/** Server `/api/license/activate` response shape — keep in lockstep with
 *  the Hono route in `whatsub-license/src/routes/activate.ts`. */
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

/** Hard-coded URL of the deployed activation server. Embedded at build
 *  time so the user can't redirect to a fake activation server via
 *  settings. To rotate this URL we'd need to ship a new version.
 *
 *  As of v0.2.0, this points at the self-hosted Hono backend on the
 *  existing Eversay Aliyun ECS (eversay.cc). The previous Cloudflare
 *  Worker URL (`whatsub-license.2216681472.workers.dev`) is retired —
 *  no users were on it (product hadn't launched yet). The Aliyun
 *  endpoint gives <200ms activation latency in mainland China, vs.
 *  5-10s first-handshake delay on Cloudflare's GFW-throttled edge. */
export const ACTIVATE_ENDPOINT =
  'https://whatsub.eversay.cc/api/license/activate';
