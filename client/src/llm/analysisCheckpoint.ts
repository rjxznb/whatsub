import type {
  AnalysisCheckpoint,
  AnalysisCheckpointPhase,
  AnalysisResult,
  CheckpointedAnalysis,
  SrtCue,
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
  cached?: AnalysisResult,
): Promise<PreparedAnalysis> {
  const transcriptFingerprint = await fingerprintTranscript(cues);

  if (!cached) {
    return freshAnalysis(transcriptFingerprint);
  }

  if (!cached.checkpoint) {
    const nextCueOffset = Math.min(cached.subtitles.length, cues.length);
    const checkpoint = createCheckpoint(
      transcriptFingerprint,
      nextCueOffset,
      nextCueOffset === cues.length ? "summary" : "cues",
    );

    return {
      analysis: { ...cached, checkpoint },
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
    analysis: cached as CheckpointedAnalysis,
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
  checkpoint: AnalysisCheckpoint,
  cueCount: number,
): boolean {
  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.transcriptFingerprint !== "string" ||
    checkpoint.transcriptFingerprint.length === 0 ||
    !Number.isInteger(checkpoint.nextCueOffset) ||
    checkpoint.nextCueOffset < 0 ||
    checkpoint.nextCueOffset > cueCount ||
    !isPhase(checkpoint.phase) ||
    !Number.isInteger(checkpoint.revision) ||
    checkpoint.revision < 0
  ) {
    return false;
  }

  return checkpoint.phase === "cues" || checkpoint.nextCueOffset === cueCount;
}

function isPhase(value: AnalysisCheckpointPhase): boolean {
  return value === "cues" || value === "summary" || value === "complete";
}
