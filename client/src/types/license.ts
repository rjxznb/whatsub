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

/** Gate states (priority high → low):
 *   - ACTIVE      永久授权 license 已激活(license.json 在盘)
 *   - SUB_ACTIVE  纯订阅用户(无 license,但 /api/auth/me 报
 *                 hasActiveSubscription=true 来自 iOS 订阅 / 支付宝
 *                 时段会员 / 网站 ¥22 月订阅)。功能上等同 ACTIVE,
 *                 但 LicenseGate 在角落显示「订阅中」徽标。
 *                 2026-06-04 added —— spec §1.2 隐含的假设是「桌面入口
 *                 = 买断 OR 试用」,但 LLM 中转上线后 Pro 订阅必须
 *                 解锁完整三端访问。
 *   - TRIAL_ACTIVE 24h 试用期内,banner 倒计时,到期 → NEEDS_KEY
 *   - NEEDS_KEY    付费墙(可输入授权码 / 启动试用 / 邮箱登录解锁订阅) */
export type LicenseMode =
  | 'NEEDS_KEY'
  | 'TRIAL_ACTIVE'
  | 'SUB_ACTIVE'
  | 'ACTIVE';

/** Stored locally as `<app-data>/trial.json` after the first /trial/start.
 *  Subsequent launches read this directly without hitting the server, so
 *  the trial works fully offline once registered.
 *  `expiresAt` is unix ms — once Date.now() crosses it, mode → NEEDS_KEY.
 *
 *  `trialToken` (added 2026-06-04, managed-LLM relay): opaque bearer
 *  minted by the server on /api/trial/start. Trial-mode users hit the
 *  managed-LLM relay (`POST /api/llm/v1/chat/completions`) with this
 *  as Authorization, skipping BYOK config. Optional for back-compat
 *  with cached pre-relay trial.json — the TS layer re-calls /start
 *  to backfill, which is idempotent on fingerprint AND returns the
 *  same token even on re-call. */
export interface TrialState {
  fingerprint: string;
  startedAt: number;
  expiresAt: number;
  trialToken?: string;
}

/** Server `/api/trial/start` response. Keep in lockstep with the route
 *  in `whatsub-license/src/routes/trial.ts` (see docs/
 *  whatsub-trial-server-snippet.md for the reference impl). */
export type TrialStartResponse =
  | { status: 'granted'; startedAt: number; expiresAt: number; trialToken: string }
  | { status: 'already_used'; startedAt: number; expiresAt: number; trialToken: string }
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
