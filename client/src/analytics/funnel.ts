import { invoke } from "@tauri-apps/api/core";

export type FunnelEventName =
  | "app_opened" | "video_selected" | "video_import_started" | "video_import_failed"
  | "transcript_started" | "transcript_ready" | "analysis_submitted" | "analysis_started"
  | "analysis_completed" | "analysis_failed" | "result_viewed" | "paywall_shown"
  | "checkout_started" | "purchase_success";

export function trackFunnel(eventName: FunnelEventName, metadata: Record<string, string | number | boolean> = {}): void {
  void invoke("analytics_event_http", {
    args: { eventName, occurredAt: Date.now(), metadata },
  }).catch(() => {});
}
