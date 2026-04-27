/**
 * Offline IPA lookup. Loads ipa-en-us.json on first use and caches the promise.
 * Single-word: direct lookup.
 * Multi-word phrase: split by whitespace, look up each token, join with spaces.
 *   If ANY token is missing, returns null (per UX decision: don't show partial).
 */

let dictPromise: Promise<Record<string, string>> | null = null;

function loadDict(): Promise<Record<string, string>> {
  if (!dictPromise) {
    dictPromise = fetch("/data/ipa-en-us.json")
      .then((r) => {
        if (!r.ok) throw new Error(`ipa-en-us.json HTTP ${r.status}`);
        return r.json() as Promise<Record<string, string>>;
      })
      .catch((e) => {
        // Reset so a future call retries.
        dictPromise = null;
        throw e;
      });
  }
  return dictPromise;
}

/**
 * @param expression English word or phrase, case-insensitive.
 * @returns IPA wrapped in slashes (e.g. `/ˈkʌm.fə.tə.bəl/`) or null if any
 *   constituent token cannot be resolved.
 */
export async function lookupPhonetic(expression: string): Promise<string | null> {
  const dict = await loadDict();
  // Normalize: lowercase, strip leading/trailing punctuation, split on spaces.
  const tokens = expression
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}']+|[^\p{L}']+$/gu, ""))
    .filter(Boolean);

  if (tokens.length === 0) return null;

  const ipas: string[] = [];
  for (const tok of tokens) {
    const ipa = dict[tok];
    if (!ipa) return null; // any miss → no phonetic shown
    ipas.push(ipa);
  }
  return `/${ipas.join(" ")}/`;
}
