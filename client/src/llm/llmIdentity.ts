// src/llm/llmIdentity.ts
//
// Lightweight helpers that read the configured LLM identity (model name,
// vendor key, vendor label) out of `Settings`. Pure functions — no React
// hooks, no I/O — so they're safe to call from anywhere (agent context
// builder, prompt builders, pricing lookups, etc.).
//
// Salvaged from feat/tutor-mvp's `llm/tutor.ts`; the tutor module mixed these
// helpers with streaming/run-action machinery that we don't want to drag onto
// feat/ai-agent. Keeping them in their own module makes them easy to import
// without pulling in unrelated Tutor dependencies.

import { VENDORS, inferVendorId } from "./vendors";
import type { Settings } from "../types/settings";

/**
 * Get the model name from settings based on the configured LLM provider.
 */
export function getModelName(settings: Settings): string {
  switch (settings.llmProvider) {
    case "openai-compatible":
      return settings.openaiCompatible.model;
    case "claude":
      return settings.claude.model;
    case "gemini":
      return settings.gemini.model;
  }
}

/**
 * Get the vendor key (lowercase, for pricing table lookup) from settings.
 *
 * For `openai-compatible` providers the key comes from `settings.vendorId`
 * when available; otherwise it is inferred from the baseUrl.
 */
export function getVendorKey(settings: Settings): string {
  if (settings.llmProvider === "claude") return "claude";
  if (settings.llmProvider === "gemini") return "gemini";
  if (settings.vendorId) return settings.vendorId;
  return inferVendorId(settings.llmProvider, settings.openaiCompatible.baseUrl);
}

/**
 * Get a human-readable vendor label for display ("DeepSeek" / "Claude" / etc.).
 * Looks up the vendorId in VENDORS; falls back to a Title-Cased version of the
 * raw key for completely unknown ids.
 */
export function getVendorLabel(settings: Settings): string {
  const key = getVendorKey(settings);
  const preset = VENDORS.find((v) => v.id === key);
  if (preset) return preset.name;
  return key.charAt(0).toUpperCase() + key.slice(1);
}
