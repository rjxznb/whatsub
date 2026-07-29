import { isSubtitle } from "./analysisCheckpoint";
import type { Subtitle } from "./types";
import type { TranslationStyle } from "../types/settings";

const MAX_ENTRIES = 50;
const STYLES = new Set<TranslationStyle>([
  "formal",
  "neutral",
  "colloquial",
  "playful",
  "cinematic",
  "literary",
]);

export interface AnalysisInflightEntry {
  cueOffset: number;
  subtitle: Subtitle;
}

export interface AnalysisInflightJournal {
  version: 1;
  journalId: string;
  transcriptGeneration: string;
  transcriptFingerprint: string;
  analysisStyle: TranslationStyle;
  baseRevision: number;
  startCueOffset: number;
  endCueOffset: number;
  entries: AnalysisInflightEntry[];
}

export interface JournalSessionContext {
  transcriptGeneration: string;
  transcriptFingerprint: string;
  analysisStyle: TranslationStyle;
  baseRevision: number;
  nextCueOffset: number;
  cueCount: number;
}

export function parseAnalysisInflightJournal(
  value: unknown,
): AnalysisInflightJournal | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!isNonEmptyString(value.journalId)) return null;
  if (!isNonEmptyString(value.transcriptGeneration)) return null;
  if (!isNonEmptyString(value.transcriptFingerprint)) return null;
  if (typeof value.analysisStyle !== "string" || !STYLES.has(value.analysisStyle as TranslationStyle)) {
    return null;
  }
  if (!isNonNegativeInteger(value.baseRevision)) return null;
  if (!isNonNegativeInteger(value.startCueOffset)) return null;
  if (!isNonNegativeInteger(value.endCueOffset)) return null;
  if (value.startCueOffset >= value.endCueOffset) return null;
  if (value.endCueOffset - value.startCueOffset > MAX_ENTRIES) return null;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) return null;

  const offsets = new Set<number>();
  const entries: AnalysisInflightEntry[] = [];
  for (const candidate of value.entries) {
    if (!isRecord(candidate) || !isNonNegativeInteger(candidate.cueOffset)) return null;
    if (
      candidate.cueOffset < value.startCueOffset
      || candidate.cueOffset >= value.endCueOffset
      || offsets.has(candidate.cueOffset)
      || !isSubtitle(candidate.subtitle)
    ) {
      return null;
    }
    offsets.add(candidate.cueOffset);
    entries.push({ cueOffset: candidate.cueOffset, subtitle: candidate.subtitle });
  }

  entries.sort((left, right) => left.cueOffset - right.cueOffset);
  return {
    version: 1,
    journalId: value.journalId,
    transcriptGeneration: value.transcriptGeneration,
    transcriptFingerprint: value.transcriptFingerprint,
    analysisStyle: value.analysisStyle as TranslationStyle,
    baseRevision: value.baseRevision,
    startCueOffset: value.startCueOffset,
    endCueOffset: value.endCueOffset,
    entries,
  };
}

export function journalMatchesSession(
  journal: AnalysisInflightJournal,
  context: JournalSessionContext,
): boolean {
  return (
    journal.transcriptGeneration === context.transcriptGeneration
    && journal.transcriptFingerprint === context.transcriptFingerprint
    && journal.analysisStyle === context.analysisStyle
    && journal.baseRevision === context.baseRevision
    && journal.startCueOffset === context.nextCueOffset
    && journal.endCueOffset <= context.cueCount
  );
}

export function mergeInflightEntries(
  journal: AnalysisInflightJournal,
  incoming: readonly AnalysisInflightEntry[],
): AnalysisInflightJournal {
  const merged = new Map(
    journal.entries.map((entry) => [entry.cueOffset, entry] as const),
  );
  for (const entry of incoming) {
    if (
      !isNonNegativeInteger(entry.cueOffset)
      || entry.cueOffset < journal.startCueOffset
      || entry.cueOffset >= journal.endCueOffset
      || !isSubtitle(entry.subtitle)
    ) {
      throw new TypeError("analysis inflight entry is invalid");
    }
    const current = merged.get(entry.cueOffset);
    if (current && !sameSubtitle(current.subtitle, entry.subtitle)) {
      throw new TypeError("analysis inflight entry rewrite rejected");
    }
    if (!current) merged.set(entry.cueOffset, entry);
  }
  if (merged.size > MAX_ENTRIES) {
    throw new RangeError("analysis inflight entry limit exceeded");
  }
  return {
    ...journal,
    entries: [...merged.values()].sort((left, right) => left.cueOffset - right.cueOffset),
  };
}

export function journalSubtitles(journal: AnalysisInflightJournal): Subtitle[] {
  return [...journal.entries]
    .sort((left, right) => left.cueOffset - right.cueOffset)
    .map((entry) => entry.subtitle);
}

function sameSubtitle(left: Subtitle, right: Subtitle): boolean {
  return JSON.stringify(stableSubtitle(left)) === JSON.stringify(stableSubtitle(right));
}

function stableSubtitle(subtitle: Subtitle) {
  return {
    time: subtitle.time,
    endTime: subtitle.endTime,
    text: subtitle.text,
    translation: subtitle.translation,
    isKeyPoint: subtitle.isKeyPoint,
    highlightWords: subtitle.highlightWords,
    keyNotes: Object.fromEntries(Object.entries(subtitle.keyNotes).sort(([a], [b]) => a.localeCompare(b))),
    highlightTranslations: Object.fromEntries(
      Object.entries(subtitle.highlightTranslations).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
