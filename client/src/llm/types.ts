export interface Subtitle {
  time: number;
  endTime: number;
  text: string;
  translation: string;
  isKeyPoint: boolean;
  highlightWords: string[];
  keyNotes: Record<string, string>;
  highlightTranslations: Record<string, string>;
}

export interface KeyPhrase {
  expression: string;
  meaningZh: string;
  usage: string;
}

export type AnalysisCheckpointPhase = "cues" | "summary" | "complete";

export interface AnalysisCheckpoint {
  version: 1;
  transcriptFingerprint: string;
  nextCueOffset: number;
  phase: AnalysisCheckpointPhase;
  revision: number;
}

export interface AnalysisResult {
  subtitles: Subtitle[];
  keyPhrases: KeyPhrase[];
  checkpoint?: AnalysisCheckpoint;
}

export type CheckpointedAnalysis = AnalysisResult & {
  checkpoint: AnalysisCheckpoint;
};

export interface SrtCue {
  index: number;
  time: number;
  endTime: number;
  text: string;
}
