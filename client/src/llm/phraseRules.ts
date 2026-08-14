const TOKEN_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

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
  if (count < 1 || count > 8) return false;
  return !(
    completeCue
    && count > 5
    && comparable(phrase) === comparable(completeCue)
  );
}
