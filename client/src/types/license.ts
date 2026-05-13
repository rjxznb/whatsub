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

/** Two-state machine: NEEDS_KEY → ACTIVE. No revocation in v1.
 *  TRIAL_ACTIVE is the new third mode — app fully usable but a banner
 *  shows the countdown, and at expiry the mode flips to NEEDS_KEY. */
export type LicenseMode = 'NEEDS_KEY' | 'TRIAL_ACTIVE' | 'ACTIVE';

/** Stored locally as `<app-data>/trial.json` after the first /trial/start.
 *  Subsequent launches read this directly without hitting the server, so
 *  the trial works fully offline once registered.
 *  `expiresAt` is unix ms — once Date.now() crosses it, mode → NEEDS_KEY. */
export interface TrialState {
  fingerprint: string;
  startedAt: number;
  expiresAt: number;
}

/** Server `/api/trial/start` response. Keep in lockstep with the route
 *  in `whatsub-license/src/routes/trial.ts` (see docs/
 *  whatsub-trial-server-snippet.md for the reference impl). */
export type TrialStartResponse =
  | { status: 'granted'; startedAt: number; expiresAt: number }
  | { status: 'already_used'; startedAt: number; expiresAt: number }
  | { status: 'bad_request'; detail: string };

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

/** Trial registration endpoint. Same backend as the activate endpoint
 *  + same `/api/license/*` namespace (nginx strips the `/license/`
 *  prefix when forwarding to the Hono container, so the backend route
 *  itself is mounted at `/api/trial`). See
 *  `docs/whatsub-trial-server-snippet.md` for the server side. */
export const TRIAL_START_ENDPOINT =
  'https://whatsub.eversay.cc/api/license/trial/start';

/** Trial length in milliseconds. The server is authoritative on
 *  expiresAt (returned in the response); this constant is only for
 *  UI display copy ("24 小时试用"). Keep in lockstep with the server. */
export const TRIAL_DURATION_MS = 24 * 60 * 60 * 1000;
