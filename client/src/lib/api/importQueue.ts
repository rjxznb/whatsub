/**
 * Import-queue API client for the whatSub backend.
 *
 * Thin invoke shim around the Rust commands in
 * `commands/import_queue_http.rs`. The HTTP calls used to live here as
 * direct WebView `fetch()` — that surfaces TLS / cert / AV-SSL-inspection
 * failures as a useless `TypeError: Failed to fetch` and the background
 * poll loop in `store/importQueue.ts` spammed the console every 30s.
 *
 * Moved to Rust (reqwest) so errors come back with stable prefixes
 * (`timeout:` / `connect:` / `tls:` / `http <N>:` / `auth:` / `body:`)
 * and the WebView2 cert-chain quirks are bypassed entirely.
 *
 * Endpoints (Rust side):
 *  POST   /api/library/import-queue          { url } → { id }
 *  GET    /api/library/import-queue?status=&supportedModes=import,replace
 *                                            → { items: ImportQueueItem[] }
 *  POST   /api/library/import-queue/:id/claim → { claimed }
 *  POST   /api/library/import-queue/:id/status { status, error? } → { ok }
 */

import { invoke } from "@tauri-apps/api/core";

export interface ImportQueueItem {
  id: string;
  url: string;
  /** Missing on legacy responses and therefore treated as `import`. */
  mode?: "import" | "replace";
  targetLibraryEntryId?: string | null;
  status: "pending" | "processing" | "done" | "failed";
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ClaimResult {
  claimed: boolean;
  attemptToken: string | null;
}

/**
 * Enqueue a URL for import.
 * Idempotent: if the same owner+url already has a pending/processing entry
 * the backend returns the existing id.
 */
export async function enqueueImport(url: string): Promise<{ id: string }> {
  const id = await invoke<string>("import_queue_enqueue_http", { url });
  return { id };
}

/**
 * List items filtered by status "pending".
 */
export async function listPending(): Promise<ImportQueueItem[]> {
  return await invoke<ImportQueueItem[]>("import_queue_list_pending_http");
}

/**
 * Atomically claim a pending item. Replacement claims also return a generation
 * token that must bind every later mutation from this processor attempt.
 */
export async function claimItem(id: string): Promise<ClaimResult> {
  return await invoke<ClaimResult>("import_queue_claim_http", { id });
}

/**
 * Update the status of a queue item. `error` is optional and only relevant
 * for the "failed" status.
 */
export async function setStatus(
  id: string,
  status: "pending" | "processing" | "done" | "failed",
  error?: string,
  attemptToken?: string | null,
): Promise<void> {
  await invoke("import_queue_set_status_http", {
    id,
    status,
    error: error ?? null,
    attemptToken: attemptToken ?? null,
  });
}
