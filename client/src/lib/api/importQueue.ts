/**
 * Import-queue API client for the whatSub backend.
 *
 * Mirrors the auth pattern from librarySync.ts:
 *  - The session token lives in the Tauri plugin store (Rust side only).
 *  - We obtain it via `invoke("get_session_token")` → `string | null`.
 *  - Every fetch attaches `Authorization: Bearer <token>`.
 *
 * Endpoints:
 *  POST   /api/library/import-queue          { url } → { id }
 *  GET    /api/library/import-queue?status=  → { items: ImportQueueItem[] }
 *  POST   /api/library/import-queue/:id/status { status, error? } → { ok }
 */

import { invoke } from "@tauri-apps/api/core";

const BASE = "https://whatsub.eversay.cc/api/library/import-queue";
const TIMEOUT_MS = 30_000;

export interface ImportQueueItem {
  id: string;
  url: string;
  status: "pending" | "processing" | "done" | "failed";
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Obtain the Bearer token or throw if not authenticated. */
async function getToken(): Promise<string> {
  const token = await invoke<string | null>("get_session_token");
  if (!token) throw new Error("auth_required");
  return token;
}

/** Shared fetch wrapper with timeout + Bearer auth. */
async function apiFetch(
  input: string,
  init: RequestInit & { token: string },
): Promise<Response> {
  const { token, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(input, {
      ...rest,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(rest.headers ?? {}),
      },
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enqueue a URL for import.
 * Idempotent: if the same owner+url already has a pending/processing entry
 * the backend returns the existing id.
 */
export async function enqueueImport(url: string): Promise<{ id: string }> {
  const token = await getToken();
  const resp = await apiFetch(BASE, {
    method: "POST",
    token,
    body: JSON.stringify({ url }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`enqueueImport http ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<{ id: string }>;
}

/**
 * List items filtered by status. Defaults to "pending".
 */
export async function listPending(): Promise<ImportQueueItem[]> {
  const token = await getToken();
  const resp = await apiFetch(`${BASE}?status=pending`, {
    method: "GET",
    token,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`listPending http ${resp.status}: ${text}`);
  }
  const body = (await resp.json()) as { items: ImportQueueItem[] };
  return body.items;
}

/**
 * Atomically claim a pending item. Returns true if THIS desktop won the claim,
 * false if another instance already took it (or the backend doesn't yet expose
 * the route — treated as "not won" so we never double-process; see caller).
 */
export async function claimItem(id: string): Promise<boolean> {
  const token = await getToken();
  const resp = await apiFetch(`${BASE}/${id}/claim`, { method: "POST", token });
  if (resp.status === 404) return false; // route not deployed yet → don't process
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`claimItem http ${resp.status}: ${text}`);
  }
  const body = (await resp.json()) as { claimed: boolean };
  return body.claimed;
}

/**
 * Update the status of a queue item. `error` is optional and only relevant
 * for the "failed" status.
 */
export async function setStatus(
  id: string,
  status: "pending" | "processing" | "done" | "failed",
  error?: string,
): Promise<void> {
  const token = await getToken();
  const body: Record<string, string> = { status };
  if (error !== undefined) body.error = error;
  const resp = await apiFetch(`${BASE}/${id}/status`, {
    method: "POST",
    token,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`setStatus http ${resp.status}: ${text}`);
  }
}
