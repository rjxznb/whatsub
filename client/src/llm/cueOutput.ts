import type { SrtCue, Subtitle } from "./types";

export type CueOutputValidation =
  | { status: "resolved"; index: number; subtitle: Subtitle }
  | { status: "unresolved"; index: number | null; reason: string };

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

  const index = value.index;
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return { status: "unresolved", index: null, reason: "index-missing" };
  }
  const source = requested.get(index);
  if (!source) {
    return { status: "unresolved", index: null, reason: "index-not-requested" };
  }

  if (typeof value.translation !== "string" || !value.translation.trim()) {
    return { status: "unresolved", index, reason: "translation-missing" };
  }
  const translation = value.translation.trim();
  const highlightWords: string[] = [];
  const noteEntries: Array<[string, string]> = [];
  const translationEntries: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (const candidate of Array.isArray(value.highlights) ? value.highlights : []) {
    if (!isPlainObject(candidate)) continue;
    const phrase = typeof candidate.source === "string" ? candidate.source.trim() : "";
    const translated = typeof candidate.translation === "string"
      ? candidate.translation.trim()
      : "";
    const note = typeof candidate.note === "string" ? candidate.note.trim() : "";
    if (!phrase || !translated || !note || seen.has(phrase)) continue;
    if (!source.text.includes(phrase) || !translation.includes(translated)) continue;
    seen.add(phrase);
    highlightWords.push(phrase);
    noteEntries.push([phrase, note]);
    translationEntries.push([phrase, translated]);
  }

  return {
    status: "resolved",
    index,
    subtitle: {
      time: source.time,
      endTime: source.endTime,
      text: source.text,
      translation,
      isKeyPoint: value.isKeyPoint === true,
      highlightWords,
      keyNotes: Object.fromEntries(noteEntries),
      highlightTranslations: Object.fromEntries(translationEntries),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
