import { invoke } from "@tauri-apps/api/core";

/**
 * Destructive boundaries are owned and confirmed by Rust. The frontend keeps
 * no generation cache and refreshes UI state only after these promises settle.
 */
export function deleteVideoAndInvalidateAnalysis(videoId: string): Promise<void> {
  return invoke<void>("library_delete", { id: videoId });
}

/** Cancellation resolves only after the child process exits and cleanup ends. */
export function cancelImportAndInvalidateAnalysis(videoId: string): Promise<void> {
  return invoke<void>("cancel_import", { videoId });
}
