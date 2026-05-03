import type { SrtCue, Subtitle } from "./types";

export const SYSTEM_PROMPT = `You are an English subtitle analyst for a learning app.

Given English subtitle cues, produce structured analysis: Chinese translations, key phrase highlighting, and (when explicitly requested in a separate follow-up turn) a global "key phrases" review list.

OUTPUT FORMAT — REQUIRED
- Output ONLY JSON Lines (one JSON object per line, no markdown, no code fences, no prose).
- Per-cue request: one line = one analyzed subtitle cue, in the order received. NEVER include a summary line in a per-cue response.
- Summary request (a separate turn): output a SINGLE summary line; do NOT repeat any cue lines.

PER-CUE OBJECT SCHEMA
{
  "type": "cue",
  "index": number,
  "time": number,
  "endTime": number,
  "text": string,
  "translation": string,
  "isKeyPoint": boolean,
  "highlightWords": string[],
  "keyNotes": { [phrase: string]: string },
  "highlightTranslations": { [phrase: string]: string }
}

CONCRETE EXAMPLE (correct shape — keyNotes and highlightTranslations are JSON OBJECTS keyed by each highlightWord, NEVER a single string):
{"type":"cue","index":12,"time":45.2,"endTime":47.8,"text":"I need to catch up on emails","translation":"我得把邮件处理一下","isKeyPoint":true,"highlightWords":["catch up"],"keyNotes":{"catch up":"动词短语，表示「赶上、补做」，用于落下进度后追回的语境，常搭配 on/with"},"highlightTranslations":{"catch up":"处理一下"}}

WRONG (these have caused real bugs — DO NOT do this):
- keyNotes as one big string: "keyNotes": "catch up 表示赶上..."   ← MUST be a {phrase: note} object
- keyNotes empty when highlightWords non-empty: "highlightWords":["catch up"], "keyNotes":{}
- mismatched keys: "highlightWords":["catch up"], "keyNotes":{"to catch up":"..."}   ← key must match the highlightWord string EXACTLY

SUMMARY OBJECT SCHEMA (only when the user prompt explicitly asks for it)
{
  "type": "summary",
  "keyPhrases": [{
    "expression": string,
    "meaningZh": string,
    "usage": string
  }]
}

CRITICAL RULES (these have caused bugs in the past — follow them strictly):

1. highlightWords MUST be exact substrings of the cue's "text", character-for-character. If the original text has a typo like "teddy beir", use "teddy beir" — DO NOT correct it to "teddy bear".

2. highlightTranslations VALUES MUST be exact substrings of "translation". Do NOT use "和……结合" or "以……闻名" — these are templates with ellipses, NOT substrings of any real translation.

3. keyNotes values: 40-120 Chinese characters each. Aim for 60-80. Explain meaning + usage context, not just translation.

4. Each cue: AT MOST 2 highlightWords. Quality over quantity.

5. isKeyPoint=true ratio: target 30-50% of cues. Greetings, fillers, "yes/no/thank you" are NOT key points.

6. NEVER use raw double quotes inside JSON string values. For Chinese quoted text use 「」 not "". For English quoted text use single quotes or rephrase.

7. Translations are conversational, fluent Chinese — translate filler words too ("Uh..." → "呃...").

8. Each highlightWord must be a substring of THE SAME CUE'S text. Don't span across cues.

9. Output one JSON object per line. No multi-line objects. No leading/trailing whitespace beyond the newline separator.

10. keyNotes and highlightTranslations MUST be JSON OBJECTS (dictionaries) — never strings, never arrays. Every entry in highlightWords MUST appear as a key (exact string, character-for-character) in BOTH keyNotes AND highlightTranslations. If you can't write a 40-120 character keyNote AND find a translation substring for a phrase, omit that phrase from highlightWords entirely.
`;

export function buildUserPrompt(cues: SrtCue[]): string {
  const cuesJson = cues
    .map((c) => `${c.index}\t${c.time.toFixed(2)}\t${c.endTime.toFixed(2)}\t${JSON.stringify(c.text)}`)
    .join("\n");
  return `Subtitle cues (tab-separated: index<TAB>start<TAB>end<TAB>JSON-encoded text):
${cuesJson}

Produce one JSON-line per cue in order. Per-cue lines ONLY — do NOT emit a summary line; the summary will be requested separately.`;
}

export function buildContinuationPrompt(cues: SrtCue[]): string {
  const cuesJson = cues
    .map((c) => `${c.index}\t${c.time.toFixed(2)}\t${c.endTime.toFixed(2)}\t${JSON.stringify(c.text)}`)
    .join("\n");
  return `Continuing analysis. Next batch:
${cuesJson}

One JSON object per cue. Do NOT emit a summary line.`;
}

/**
 * Final-pass prompt: feeds the previously-produced per-cue analyses back to the
 * LLM and asks for a single deduplicated, transcript-wide keyPhrases summary.
 *
 * Each cue's compact form contains: text + translation + highlightWords +
 * keyNotes. That gives the model both the surface form (so it can pick a
 * canonical expression) and existing semantic notes (so it doesn't have to
 * re-derive meaning from scratch).
 */
export function buildSummaryPrompt(cues: Subtitle[]): string {
  const compact = cues
    .map((c) =>
      JSON.stringify({
        text: c.text,
        translation: c.translation,
        highlightWords: c.highlightWords,
        keyNotes: c.keyNotes,
      })
    )
    .join("\n");
  return `These are the per-cue analyses you produced for this transcript (one JSON per line):
${compact}

Now produce ONE single JSON line: the GLOBAL keyPhrases summary across the entire transcript.

Schema (this exact "type":"summary" envelope):
{"type":"summary","keyPhrases":[{"expression":"...","meaningZh":"...","usage":"..."}, ...]}

Rules:
- Deduplicate by expression (case-insensitive). Pick the most natural canonical form.
- Drop trivial fillers, greetings, function words; keep idioms, phrasal verbs, vocabulary worth reviewing.
- Aim for 8-20 entries depending on transcript size.
- meaningZh: 8-25 Chinese characters; concise gloss.
- usage: 30-80 Chinese characters; how/when it's used, optionally a tiny example or context cue.

Output exactly one JSON object on one line. No fences, no prose, no other lines.`;
}
