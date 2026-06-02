// src/agent/context.ts
//
// ContextBuilder for the AI Agent. Reads transient app state from the four
// zustand stores (player / library / vocab / settings) and produces:
//
//   1. `snapshot()`  → structured ContextSnapshot (used for tests, logging,
//                      pinning page-context-at-start onto a Conversation).
//   2. `render(s)`   → natural-language ⟨当前上下文⟩ block to inject into the
//                      system prompt before each turn.
//
// Per spec §7.2, the rendered output is prose — empirically LLMs attend to
// short, declarative Chinese lines better than nested JSON. Per locked
// privacy decision §1.2, only the top-5 most recently saved vocab
// expressions are surfaced; full vocab + cue text never leaves the device
// uninvited.

import { usePlayerState } from "../store/playerState";
import { useLibrary } from "../store/library";
import { useVocabulary } from "../store/vocab";
import { useSettings } from "../store/settings";
import { useLearnerProfile } from "../tutor/learnerProfile";
import { ERROR_PATTERN_LABELS, type ErrorPattern } from "../tutor/errorPatterns";
import { getVendorKey, getModelName } from "../llm/llmIdentity";
import type { PageSnapshot } from "../types/agent";

export interface LibrarySummary {
  total: number;
  /** Up to 3 most-populated scene buckets, sorted by count desc. */
  bySceneTop3: Array<[string, number]>;
  /** Sum of every scene bucket beyond the top 3. */
  otherCount: number;
  /** Count of entries with a non-null `syncedAt`. */
  syncedCount: number;
}

export interface VocabSummary {
  total: number;
  /** Most-recently-saved expressions (max 5). String list only — no usage,
   *  meaning, or video back-references. */
  recentTop5: string[];
}

export interface LearnerSummary {
  /** CEFR estimate (null when unknown / no data yet). */
  cefr: string | null;
  /** Up to 4 top weak patterns as [pattern, occurrences], sorted by the
   *  profile's own weakPatterns order (occurrences desc). */
  weakTop: Array<[ErrorPattern, number]>;
}

export interface ContextSnapshot {
  page: PageSnapshot;
  library: LibrarySummary;
  vocab: VocabSummary;
  /** Present only when the learner profile is hydrated AND has weak patterns —
   *  lets the agent proactively mention what the user struggles with. */
  learner?: LearnerSummary;
  llm: { vendor: string; model: string };
}

/**
 * Build a structured snapshot of the current app state. Pure function over
 * the global store state at call time — no subscriptions, no async work.
 */
export function snapshot(): ContextSnapshot {
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
  const playerState = usePlayerState.getState();
  const library = useLibrary.getState().library;
  const vocab = useVocabulary.getState().entries;
  const settings = useSettings.getState().settings;

  // Page block: enrich with player info only when actually on the player route.
  const page: PageSnapshot = { pathname };
  if (pathname.startsWith("/player/") && playerState.videoId) {
    page.videoId = playerState.videoId;
    if (playerState.videoTitle) {
      page.videoTitle = playerState.videoTitle;
    }
    if (typeof playerState.currentIdx === "number") {
      page.cueIdx = playerState.currentIdx;
    }
  }

  // Library summary: scene distribution + synced count. `scene` is not on
  // the LibraryEntry type yet (it lives on analysis.json today), so cast to
  // `any` and fall back to "unknown" when missing. This mirrors how the
  // backend's analysis-side scene attribution is reading toward Library
  // entries in the parallel quota work.
  const sceneCounts = new Map<string, number>();
  let syncedCount = 0;
  for (const v of library.videos ?? []) {
    const scene = (v as unknown as { scene?: string }).scene ?? "unknown";
    sceneCounts.set(scene, (sceneCounts.get(scene) ?? 0) + 1);
    if (v.syncedAt) syncedCount++;
  }
  const sorted = [...sceneCounts.entries()].sort((a, b) => b[1] - a[1]);
  const bySceneTop3 = sorted.slice(0, 3);
  const otherCount = sorted.slice(3).reduce((s, [, c]) => s + c, 0);

  // Vocab summary: sort by addedAt (ISO string compare works for any
  // consistent ISO format — lexicographic == chronological). Older entries
  // pre-dating the field get treated as oldest (empty string sorts first).
  const recent = [...vocab]
    .sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""))
    .slice(0, 5);

  // Learner profile: surface top weak patterns so the agent can proactively
  // bring up what the user struggles with (and recommend review for it). Read
  // from the store's already-hydrated state — never blocks (snapshot is sync);
  // absent until the profile hydrates, which AgentRoot kicks off at mount.
  const profile = useLearnerProfile.getState().profile;
  let learner: LearnerSummary | undefined;
  if (profile && profile.masteryIndex.weakPatterns.length > 0) {
    learner = {
      cefr: profile.estimate.cefr,
      weakTop: profile.masteryIndex.weakPatterns
        .slice(0, 4)
        .map((w) => [w.pattern, w.occurrences] as [ErrorPattern, number]),
    };
  }

  return {
    page,
    library: {
      total: (library.videos ?? []).length,
      bySceneTop3,
      otherCount,
      syncedCount,
    },
    vocab: {
      total: vocab.length,
      recentTop5: recent.map((e) => e.expression),
    },
    learner,
    llm: { vendor: getVendorKey(settings), model: getModelName(settings) },
  };
}

/**
 * Render a snapshot as the natural-language ⟨当前上下文⟩ system-prompt block.
 * Format locked by spec §7.2; tests assert on the exact line wording.
 */
export function render(s: ContextSnapshot): string {
  const lines: string[] = ["⟨当前上下文⟩"];

  // Page block.
  lines.push(`位置: ${s.page.pathname}`);
  if (s.page.videoTitle) {
    lines.push(`当前视频: "${s.page.videoTitle}"`);
  }
  if (typeof s.page.cueIdx === "number") {
    // Display is 1-based; internal cueIdx is 0-based.
    lines.push(`字幕游标: 第 ${s.page.cueIdx + 1} 句`);
  }

  // Library distribution.
  const libDistribution = s.library.bySceneTop3.length
    ? s.library.bySceneTop3.map(([k, v]) => `${k} ${v}`).join(" · ") +
      (s.library.otherCount > 0 ? ` · 其他 ${s.library.otherCount}` : "")
    : "空";
  lines.push(
    `库内: ${s.library.total} 个视频 (${libDistribution}, 已云同步 ${s.library.syncedCount})`,
  );

  // Vocab.
  const vocabRecent = s.vocab.recentTop5.length
    ? ` (最近 ${s.vocab.recentTop5.length} 条：${s.vocab.recentTop5.join(", ")})`
    : "";
  lines.push(`生词本: ${s.vocab.total} 条${vocabRecent}`);

  // Learner weak patterns — only when the profile is hydrated with data, so
  // the agent can proactively coach (call recommend_review for review spots).
  if (s.learner && s.learner.weakTop.length) {
    const level = s.learner.cefr ? `水平 ${s.learner.cefr} · ` : "";
    const weak = s.learner.weakTop
      .map(([p, n]) => `${ERROR_PATTERN_LABELS[p]}×${n}`)
      .join(" · ");
    lines.push(`${level}薄弱点: ${weak}`);
  }

  // LLM identity.
  lines.push(`当前 LLM: ${s.llm.model} (用户 BYOK)`);

  return lines.join("\n");
}
