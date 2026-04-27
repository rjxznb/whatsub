import type { SrtCue } from "./types";

export const SYSTEM_PROMPT = `You are an English subtitle analyst for a learning app.

Given English subtitle cues, produce structured analysis: Chinese translations, key phrase highlighting, and a separate "key phrases" review list.

OUTPUT FORMAT — REQUIRED
- Output ONLY JSON Lines (one JSON object per line, no markdown, no code fences, no prose).
- One line = one analyzed subtitle cue, in the order received.
- After ALL subtitle cues, emit a single trailing line containing a "summary" object with the global keyPhrases list.

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

SUMMARY OBJECT SCHEMA (last line only)
{
  "type": "summary",
  "keyPhrases": [{
    "expression": string,
    "meaningZh": string,
    "usage": string,
    "minDifficulty": "EASY"|"MEDIUM"|"HARD"
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
`;

export function buildUserPrompt(cues: SrtCue[]): string {
  const cuesJson = cues
    .map((c) => `${c.index}\t${c.time.toFixed(2)}\t${c.endTime.toFixed(2)}\t${JSON.stringify(c.text)}`)
    .join("\n");
  return `Subtitle cues (tab-separated: index<TAB>start<TAB>end<TAB>JSON-encoded text):
${cuesJson}

Produce one JSON-line per cue in order, then one summary line at the end. Output JSON only.`;
}

export function buildContinuationPrompt(cues: SrtCue[], isLastBatch: boolean): string {
  const cuesJson = cues
    .map((c) => `${c.index}\t${c.time.toFixed(2)}\t${c.endTime.toFixed(2)}\t${JSON.stringify(c.text)}`)
    .join("\n");
  const trailer = isLastBatch
    ? "After this final batch, emit the summary line."
    : "Do NOT emit the summary yet — more batches will follow.";
  return `Continuing analysis. Next batch:
${cuesJson}

${trailer}
One JSON object per line.`;
}
