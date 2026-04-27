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

export interface AnalysisResult {
  subtitles: Subtitle[];
  keyPhrases: KeyPhrase[];
}

export interface SrtCue {
  index: number;
  time: number;
  endTime: number;
  text: string;
}
