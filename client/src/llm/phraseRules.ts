const TOKEN_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

export const MAX_HIGHLIGHTED_CUES = 20;
export const CUES_PER_HIGHLIGHT = 2.5;

export function compactHighlightCapacity(cueCount: number): number {
  if (!Number.isFinite(cueCount) || cueCount <= 0) return 0;
  return Math.min(
    MAX_HIGHLIGHTED_CUES,
    Math.ceil(Math.floor(cueCount) / CUES_PER_HIGHLIGHT),
  );
}

export class HighlightBudget {
  constructor(readonly limit: number, private usedCount = 0) {}

  get used(): number {
    return this.usedCount;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedCount);
  }

  accept(): boolean {
    if (this.remaining === 0) return false;
    this.usedCount += 1;
    return true;
  }
}

export function countPhraseTokens(value: string): number {
  return value.match(TOKEN_RE)?.length ?? 0;
}

function comparable(value: string): string {
  return (value.match(TOKEN_RE) ?? []).join(" ").toLocaleLowerCase();
}

export function isAllowedLearningPhrase(
  phrase: string,
  completeCue?: string,
): boolean {
  const count = countPhraseTokens(phrase);
  if (count < 1 || count > 4) return false;
  return !(completeCue && comparable(phrase) === comparable(completeCue) && count > 4);
}
