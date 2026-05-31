import type { LessonState, LearnerProfile } from "./types";
import type { ErrorPattern } from "./errorPatterns";

const REMEDIATION_OCCURRENCE_THRESHOLD = 3;
const REMEDIATION_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

export interface LessonSummary {
  totalAnchors: number;
  correctCount: number;
  topicsLearned: string[];
  errorCount: number;
  errorIds: string[];
}

export function computeLessonSummary(state: LessonState): LessonSummary {
  return {
    totalAnchors: state.history.length,
    correctCount: state.history.filter((h) => h.finalCorrect).length,
    topicsLearned: state.history.map((h) => h.topic),
    errorCount: state.errorsThisSession.length,
    errorIds: state.errorsThisSession,
  };
}

export interface RemediationOffer {
  pattern: ErrorPattern;
  occurrences: number;
}

/** Return the highest-occurrence pattern that meets the threshold AND is
 *  past cooldown, or null. Used at lesson end to surface the "本周第 N 次
 *  错 X，来 3 分钟专项？" CTA. */
export function shouldOfferRemediation(
  profile: LearnerProfile,
  now: number,
): RemediationOffer | null {
  const eligible = profile.masteryIndex.weakPatterns
    .filter((w) => w.occurrences >= REMEDIATION_OCCURRENCE_THRESHOLD)
    .filter(
      (w) =>
        w.lastRemediatedAt === null ||
        now - w.lastRemediatedAt > REMEDIATION_COOLDOWN_MS,
    )
    .sort((a, b) => b.occurrences - a.occurrences);
  if (eligible.length === 0) return null;
  const top = eligible[0];
  return { pattern: top.pattern, occurrences: top.occurrences };
}

// ──────────── Daily throttle ────────────
//
// Spec: "每节课检查一次但 24h 内最多弹一次专项" — daily throttle uses
// localStorage so the cap survives app restarts without needing a Rust
// command roundtrip.

const REMEDIATION_LAST_SHOWN_KEY = "tutor.remediationLastShownAt";

export function canShowRemediationOfferToday(now: number): boolean {
  try {
    const raw = localStorage.getItem(REMEDIATION_LAST_SHOWN_KEY);
    if (!raw) return true;
    const last = parseInt(raw, 10);
    if (isNaN(last)) return true;
    return now - last > 24 * 60 * 60 * 1000;
  } catch {
    return true; // localStorage broken → fail-open
  }
}

export function markRemediationOfferShown(now: number): void {
  try {
    localStorage.setItem(REMEDIATION_LAST_SHOWN_KEY, String(now));
  } catch {
    /* ignore */
  }
}
