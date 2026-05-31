// Mirrors the Rust LearnerProfile schema in
// src-tauri/src/commands/learner_profile.rs. Serde renames are applied
// camelCase-side so we match what Tauri actually returns.

import type { ErrorPattern } from "./errorPatterns";

export interface LearnerProfile {
  version: 1;
  createdAt: number;
  updatedAt: number;
  estimate: Estimate;
  errorEvents: ErrorEvent[];
  masteryIndex: MasteryIndex;
  goals: string[];
}

// NOTE: Rust stores `cefr` and `listeningLevel` as plain Option<String> and
// does NOT enforce the TS union values at runtime. Write-sites (Tasks 5+)
// must validate the incoming string before narrowing to these union types.
export interface Estimate {
  cefr: "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | null;
  vocabSize: number | null;
  listeningLevel: "low" | "mid" | "high" | null;
  confidence: number;
}

export interface ErrorEvent {
  id: string;
  ts: number;
  source: {
    type: "lesson" | "roleplay" | "remediation";
    videoId: string | null;
    cueIdx: number | null;
    questionId: string | null;
  };
  pattern: ErrorPattern;
  detail: string;
  userInput: string;
  correction: string;
  resolved: boolean;
  resolvedAt: number | null;
}

export interface MasteryIndex {
  weakPatterns: WeakPattern[];
  knownWords: string[];
  weakWords: string[];
}

export interface WeakPattern {
  pattern: ErrorPattern;
  occurrences: number;
  lastSeenAt: number;
  sampleErrorIds: string[];
  lastRemediatedAt: number | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Lesson types (used by Tasks 3-8)
// ─────────────────────────────────────────────────────────────────────────

export interface LessonPlan {
  videoId: string;
  estimateTokens: number;
  overview: string;
  anchors: TeachingAnchor[];
}

export interface TeachingAnchor {
  cueIdx: number;
  topic: string;
  whyThisOne: string;
  targetPatterns: ErrorPattern[];
}

export interface LessonState {
  videoId: string;
  startedAt: number;
  plan: LessonPlan;
  currentAnchorIdx: number;
  currentStep: 1 | 2 | 3 | 4 | 5;
  history: AnchorRecord[];
  errorsThisSession: string[]; // errorEvent ids written so far
}

export interface AnchorRecord {
  cueIdx: number;
  topic: string;
  attempts: number;        // how many times user tried this anchor's Q
  errorIds: string[];      // events written for this anchor
  finalCorrect: boolean;   // true if user answered right (or after answer-given)
}

// ─────────────────────────────────────────────────────────────────────────
// Roleplay types (used by Tasks 10-12)
// ─────────────────────────────────────────────────────────────────────────

export interface RoleplayScenario {
  id: string;
  title: string;          // "你当旅客我当海关"
  setup: string;          // 1-sentence scene description
  userRole: string;
  agentRole: string;
  difficulty: 1 | 2 | 3;
  sourceVideoId: string | null;
  vocabHints: string[];
}

export interface RoleplayTurn {
  role: "user" | "agent";
  text: string;
  ts: number;
}

export interface ObservedError {
  pattern: ErrorPattern;
  userText: string;
  correction: string;
  detail: string;
}

export interface ForensicReport {
  totalUserTurns: number;
  naturalCount: number;
  chinglishExamples: Array<{ original: string; better: string }>;
  patternHits: Array<{ pattern: ErrorPattern; count: number; example: string; monthCount?: number }>;
  registerNotes: string[];
  fallback: boolean; // true if degraded version (small model)
}
