/**
 * Quota API client for the whatSub backend.
 *
 * Mirrors the auth pattern from importQueue.ts:
 *  - The session token lives in the Tauri plugin store (Rust side only).
 *  - We obtain it via `invoke("get_session_token")` → `string | null`.
 *  - Each fetch attaches `Authorization: Bearer <token>`.
 *
 * Both limits are server-authoritative (computed from hasActiveSubscription,
 * which covers cross-platform — Alipay/web — subscriptions, not just iOS),
 * so the desktop shows the same caps the backend actually enforces.
 *
 * Endpoints:
 *  GET /api/library/quota  → { used, limit }   (cloud-synced videos; sub ? 50 : 3)
 *  GET /api/corpus/quota   → { used, limit }   (personal corpus phrases; sub ? 1000 : 50)
 */

import { invoke } from "@tauri-apps/api/core";

const BASE = "https://whatsub.eversay.cc/api";
const TIMEOUT_MS = 15_000;

export interface Quota {
  used: number;
  limit: number;
}

/** Obtain the Bearer token or throw if not authenticated. */
async function getToken(): Promise<string> {
  const token = await invoke<string | null>("get_session_token");
  if (!token) throw new Error("auth_required");
  return token;
}

async function fetchQuota(path: string): Promise<Quota> {
  const token = await getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`quota http ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<Quota>;
  } finally {
    clearTimeout(timer);
  }
}

/** Cloud-synced video quota (used/limit). limit = hasActiveSubscription ? 50 : 3. */
export function libraryQuota(): Promise<Quota> {
  return fetchQuota("/library/quota");
}

/** Personal-corpus phrase quota (used/limit). limit = hasActiveSubscription ? 1000 : 50. */
export function corpusQuota(): Promise<Quota> {
  return fetchQuota("/corpus/quota");
}

/** Managed-LLM relay quota — extends the base shape with tier + reset
 *  info so the Settings page can render "本月剩余 ≈N 次解析" or
 *  "免费体验包 LIFETIME". `tier`:
 *    - 'pro'   monthly bucket, resets on `periodResetAt` (epoch ms)
 *    - 'trial' lifetime per-fingerprint (24h window also caps it)
 *    - 'free'  per-email lifetime (200K), `periodResetAt` is 0
 *  Added 2026-06-04 (managed-LLM relay phase 3). */
export interface LlmQuota extends Quota {
  requestCount: number;
  tier: "pro" | "trial" | "free";
  /** 0 for free tier (no reset until upgrade). */
  periodResetAt: number;
}

/** Accepts an optional explicit bearer so trial-mode callers can pass
 *  their trialToken (the relay-issued bearer from /api/trial/start)
 *  rather than the per-account session token. Pro / free tiers use the
 *  default (get_session_token). */
export async function llmQuota(bearerOverride?: string): Promise<LlmQuota> {
  const token = bearerOverride ?? (await getToken());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/llm/quota`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`llm quota http ${resp.status}: ${text}`);
    }
    return resp.json() as Promise<LlmQuota>;
  } finally {
    clearTimeout(timer);
  }
}
