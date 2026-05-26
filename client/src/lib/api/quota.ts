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
