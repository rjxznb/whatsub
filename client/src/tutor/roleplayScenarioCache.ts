// src/tutor/roleplayScenarioCache.ts
//
// Session-lived cache of generated roleplay scenarios, keyed by the source
// video. Without it, every time the user closes the scenario picker and
// reopens it the scenarios are re-derived (an LLM call) — wasteful and
// jarring (a fresh, different batch each time). Cached in module memory so it
// survives picker open/close within a session; cleared on app restart (a fresh
// batch per launch is fine) or explicitly via the 换一批 refresh button.

import type { RoleplayScenario } from "./types";

const cache = new Map<string, RoleplayScenario[]>();

const keyOf = (videoId: string | null): string => videoId ?? "__novideo__";

export function getCachedScenarios(videoId: string | null): RoleplayScenario[] | null {
  const v = cache.get(keyOf(videoId));
  return v && v.length ? v : null;
}

export function setCachedScenarios(
  videoId: string | null,
  scenarios: RoleplayScenario[],
): void {
  if (scenarios.length) cache.set(keyOf(videoId), scenarios);
}

export function clearCachedScenarios(videoId: string | null): void {
  cache.delete(keyOf(videoId));
}
