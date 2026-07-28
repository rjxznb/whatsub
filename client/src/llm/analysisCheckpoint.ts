import type {
  AnalysisCheckpoint,
  AnalysisCheckpointPhase,
  CheckpointedAnalysis,
  KeyPhrase,
  SrtCue,
  Subtitle,
} from "./types";

export interface PreparedAnalysis {
  analysis: CheckpointedAnalysis;
  needsSave: boolean;
  reason: "fresh" | "resume" | "legacy-migration" | "fingerprint-mismatch";
}

export async function fingerprintTranscript(cues: readonly SrtCue[]): Promise<string> {
  const payload = JSON.stringify(cues.map((cue) => [cue.index, cue.time, cue.endTime, cue.text]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const hash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

  return `sha256:${hash}`;
}

export async function prepareAnalysis(
  cues: readonly SrtCue[],
  cached?: unknown,
): Promise<PreparedAnalysis> {
  const transcriptFingerprint = await fingerprintTranscript(cues);

  if (!isPersistedAnalysis(cached)) {
    return freshAnalysis(transcriptFingerprint);
  }

  if (!hasOwn(cached, "checkpoint")) {
    const nextCueOffset = Math.min(cached.subtitles.length, cues.length);
    const checkpoint = createCheckpoint(
      transcriptFingerprint,
      nextCueOffset,
      nextCueOffset === cues.length ? "summary" : "cues",
    );

    return {
      analysis: {
        subtitles: cached.subtitles,
        keyPhrases: cached.keyPhrases,
        checkpoint,
      },
      needsSave: true,
      reason: "legacy-migration",
    };
  }

  if (!isValidCheckpoint(cached.checkpoint, cues.length)) {
    return freshAnalysis(transcriptFingerprint);
  }

  if (cached.checkpoint.transcriptFingerprint !== transcriptFingerprint) {
    return {
      ...freshAnalysis(transcriptFingerprint),
      reason: "fingerprint-mismatch",
    };
  }

  return {
    analysis: {
      subtitles: cached.subtitles,
      keyPhrases: cached.keyPhrases,
      checkpoint: cached.checkpoint,
    },
    needsSave: false,
    reason: "resume",
  };
}

function freshAnalysis(transcriptFingerprint: string): PreparedAnalysis {
  return {
    analysis: {
      subtitles: [],
      keyPhrases: [],
      checkpoint: createCheckpoint(transcriptFingerprint, 0, "cues"),
    },
    needsSave: true,
    reason: "fresh",
  };
}

function createCheckpoint(
  transcriptFingerprint: string,
  nextCueOffset: number,
  phase: AnalysisCheckpointPhase,
): AnalysisCheckpoint {
  return {
    version: 1,
    transcriptFingerprint,
    nextCueOffset,
    phase,
    revision: 0,
  };
}

function isValidCheckpoint(
  checkpoint: unknown,
  cueCount: number,
): checkpoint is AnalysisCheckpoint {
  if (!isRecord(checkpoint)) return false;

  const nextCueOffset = checkpoint.nextCueOffset;
  const revision = checkpoint.revision;

  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.transcriptFingerprint !== "string" ||
    checkpoint.transcriptFingerprint.length === 0 ||
    !isNonNegativeInteger(nextCueOffset) ||
    nextCueOffset > cueCount ||
    !isPhase(checkpoint.phase) ||
    !isNonNegativeInteger(revision)
  ) {
    return false;
  }

  return checkpoint.phase === "cues" || nextCueOffset === cueCount;
}

function isPhase(value: unknown): value is AnalysisCheckpointPhase {
  return value === "cues" || value === "summary" || value === "complete";
}

interface PersistedAnalysis {
  subtitles: Subtitle[];
  keyPhrases: KeyPhrase[];
  checkpoint?: unknown;
}

function isPersistedAnalysis(value: unknown): value is PersistedAnalysis {
  return (
    isRecord(value) &&
    Array.isArray(value.subtitles) &&
    value.subtitles.every(isSubtitle) &&
    Array.isArray(value.keyPhrases) &&
    value.keyPhrases.every(isKeyPhrase)
  );
}

function isSubtitle(value: unknown): value is Subtitle {
  return (
    isRecord(value) &&
    isFiniteNumber(value.time) &&
    isFiniteNumber(value.endTime) &&
    typeof value.text === "string" &&
    typeof value.translation === "string" &&
    typeof value.isKeyPoint === "boolean" &&
    Array.isArray(value.highlightWords) &&
    value.highlightWords.every((word) => typeof word === "string") &&
    isStringRecord(value.keyNotes) &&
    isStringRecord(value.highlightTranslations)
  );
}

function isKeyPhrase(value: unknown): value is KeyPhrase {
  return (
    isRecord(value) &&
    typeof value.expression === "string" &&
    typeof value.meaningZh === "string" &&
    typeof value.usage === "string"
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, property: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}
