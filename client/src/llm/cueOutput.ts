import type { SrtCue, Subtitle } from "./types";
import { isAllowedLearningPhrase } from "./phraseRules";

export type CueOutputValidation =
  | {
      status: "resolved";
      index: number;
      subtitle: Subtitle;
      needsAnnotationRepair: boolean;
    }
  | { status: "unresolved"; index: number | null; reason: string };

interface HighlightCandidate {
  source: unknown;
  translation: unknown;
  note: unknown;
}

export interface AnnotationRepairSource {
  cue: SrtCue;
  translation: string;
}

export interface SubtitleAnnotationPatch {
  isKeyPoint: boolean;
  highlightWords: string[];
  keyNotes: Record<string, string>;
  highlightTranslations: Record<string, string>;
}

export type AnnotationRepairValidation =
  | { status: "resolved"; index: number; patch: SubtitleAnnotationPatch }
  | { status: "invalid"; index: number | null; reason: string };

/**
 * Convert one untrusted model object into a Subtitle while keeping transcript
 * identity authoritative. Invalid optional annotations are dropped; an absent
 * translation leaves the cue unresolved so the caller can request it again.
 */
export function validateCueOutput(
  value: unknown,
  requested: ReadonlyMap<number, SrtCue>,
): CueOutputValidation {
  if (!isPlainObject(value)) {
    return { status: "unresolved", index: null, reason: "output-not-an-object" };
  }

  const index = typeof value.i === "number" ? value.i : value.index;
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return { status: "unresolved", index: null, reason: "index-missing" };
  }
  const source = requested.get(index);
  if (!source) {
    return { status: "unresolved", index: null, reason: "index-not-requested" };
  }

  const rawTranslation = typeof value.zh === "string" ? value.zh : value.translation;
  if (typeof rawTranslation !== "string" || !rawTranslation.trim()) {
    return { status: "unresolved", index, reason: "translation-missing" };
  }
  const translation = rawTranslation.trim();
  const { candidates, annotationIntent } = annotationCandidates(value);
  const patch = validatedAnnotationPatch(candidates, source, translation);

  return {
    status: "resolved",
    index,
    needsAnnotationRepair: annotationIntent && patch.highlightWords.length === 0,
    subtitle: {
      time: source.time,
      endTime: source.endTime,
      text: source.text,
      translation,
      ...patch,
    },
  };
}

export function validateAnnotationRepair(
  value: unknown,
  requested: ReadonlyMap<number, AnnotationRepairSource>,
): AnnotationRepairValidation {
  if (!isPlainObject(value)) {
    return { status: "invalid", index: null, reason: "output-not-an-object" };
  }
  const index = value.i;
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return { status: "invalid", index: null, reason: "index-missing" };
  }
  const source = requested.get(index);
  if (!source) {
    return { status: "invalid", index, reason: "index-not-requested" };
  }
  if (!Array.isArray(value.p)) {
    return { status: "invalid", index, reason: "phrases-malformed" };
  }
  const { candidates } = annotationCandidates(value);
  const patch = validatedAnnotationPatch(candidates, source.cue, source.translation);
  if (value.p.length > 0 && patch.highlightWords.length === 0) {
    return { status: "invalid", index, reason: "phrases-invalid" };
  }
  return { status: "resolved", index, patch };
}

function validatedAnnotationPatch(
  candidates: readonly HighlightCandidate[],
  source: SrtCue,
  translation: string,
): SubtitleAnnotationPatch {
  for (const candidate of candidates) {
    const phrase = typeof candidate.source === "string" ? candidate.source.trim() : "";
    const translated = typeof candidate.translation === "string"
      ? candidate.translation.trim()
      : "";
    const note = typeof candidate.note === "string" ? candidate.note.trim() : "";
    if (!phrase || !translated || !note) continue;
    if (!source.text.includes(phrase) || !translation.includes(translated)) continue;
    if (!isAllowedLearningPhrase(phrase, source.text)) continue;
    const noteLength = Array.from(note).length;
    if (noteLength < 25 || noteLength > 90) continue;
    return {
      isKeyPoint: true,
      highlightWords: [phrase],
      keyNotes: { [phrase]: note },
      highlightTranslations: { [phrase]: translated },
    };
  }

  return {
    isKeyPoint: false,
    highlightWords: [],
    keyNotes: {},
    highlightTranslations: {},
  };
}

function annotationCandidates(value: Record<string, unknown>): {
  candidates: HighlightCandidate[];
  annotationIntent: boolean;
} {
  if (Object.prototype.hasOwnProperty.call(value, "p")) {
    const tuples = Array.isArray(value.p) ? value.p : [];
    return {
      candidates: tuples.map((tuple) => Array.isArray(tuple)
        ? { source: tuple[0], translation: tuple[1], note: tuple[2] }
        : { source: undefined, translation: undefined, note: undefined }),
      annotationIntent: !Array.isArray(value.p) || tuples.length > 0,
    };
  }

  if (Object.prototype.hasOwnProperty.call(value, "highlights")) {
    const highlights = Array.isArray(value.highlights) ? value.highlights : [];
    return {
      candidates: highlights.map((candidate) => isPlainObject(candidate)
        ? {
            source: candidate.source,
            translation: candidate.translation,
            note: candidate.note,
          }
        : { source: undefined, translation: undefined, note: undefined }),
      annotationIntent:
        value.isKeyPoint === true
        || !Array.isArray(value.highlights)
        || highlights.length > 0,
    };
  }

  const hasLegacy = ["highlightWords", "keyNotes", "highlightTranslations"]
    .some((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (hasLegacy) {
    const words = Array.isArray(value.highlightWords) ? value.highlightWords : [];
    const notes = isPlainObject(value.keyNotes) ? value.keyNotes : {};
    const translations = isPlainObject(value.highlightTranslations)
      ? value.highlightTranslations
      : {};
    return {
      candidates: words.map((word) => ({
        source: word,
        translation: typeof word === "string" ? translations[word] : undefined,
        note: typeof word === "string" ? notes[word] : undefined,
      })),
      annotationIntent:
        value.isKeyPoint === true
        || !Array.isArray(value.highlightWords)
        || words.length > 0,
    };
  }

  return { candidates: [], annotationIntent: value.isKeyPoint === true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
