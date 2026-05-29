import type { SrtCue, Subtitle } from "../llm/types";

export type TutorAction = "explain" | "quiz" | "liaison";

export interface TutorContext {
  /**
   * The cues that form this action's context window.
   *  - explain / quiz (in-tab): current cue ± 2 cues (5 total)
   *  - quiz (toast trigger):   entire transcript
   *  - liaison:                 a single cue
   */
  cues: SrtCue[];
  /**
   * Subtitles produced by the analysis pipeline that overlap `cues` —
   * gives the LLM the Chinese translations + key phrases the user is
   * looking at. May be empty (e.g. analysis not yet complete).
   */
  analyzedSubtitles: Subtitle[];
}

/** Total character count of the cue texts in `ctx` — used for cost estimate. */
export function contextChars(ctx: TutorContext): number {
  return ctx.cues.reduce((sum, c) => sum + c.text.length, 0);
}

/** Expected response size in characters, per action. Used for cost estimate. */
export const RESPONSE_CHAR_ESTIMATE: Record<TutorAction, number> = {
  explain: 800,  // ~200-400 Chinese chars but Markdown overhead and headings push higher
  quiz: 1500,    // 5 questions × ~300 chars each (question + 4 options + explanation)
  liaison: 300,
};

/**
 * Build the prompt for "解释这段". Streaming markdown response.
 */
export function buildExplainPrompt(ctx: TutorContext): string {
  const transcript = ctx.cues
    .map((c, i) => `[Cue ${i}] ${c.text}`)
    .join("\n");
  return `You are an English-learning coach for a Chinese-speaking student. The student is watching a video and wants you to explain this passage.

Transcript excerpt:
${transcript}

Explain in Chinese:
1. What the dialogue means (overall meaning, not word-by-word).
2. Any idioms, cultural references, or registers (formal / casual / slangy) that a Chinese learner would miss.
3. Why the typical Chinese translation chose certain phrasings.

Keep it concise (200–400 Chinese characters total). Use markdown formatting (bold for terms, lists where useful).`;
}

/**
 * Build the prompt for "出个题". Streaming JSON Lines response — one
 * question per line. The caller parses each line as it arrives.
 */
export function buildQuizPrompt(ctx: TutorContext): string {
  const transcript = ctx.cues.map((c) => c.text).join(" ");
  return `Generate 5 multiple-choice questions about this English passage for a Chinese-speaking learner.

Passage:
${transcript}

Question mix: 2 vocabulary, 2 reading comprehension, 1 grammar.

Output as JSON Lines — one question per line, in this exact shape:
{"q": "Question in English", "type": "vocab" | "comprehension" | "grammar", "options": ["A...", "B...", "C...", "D..."], "answer": <0-3>, "explain": "Brief explanation in Chinese"}

Strict rules:
- Each option must be a complete phrase or sentence, not just a single letter or word from the original passage.
- "answer" is the 0-based index of the correct option (0, 1, 2, or 3).
- "explain" is in Chinese, 30-80 characters, says WHY the correct answer is right.
- Output ONLY the JSON Lines, no surrounding prose, no markdown code fences.`;
}

/**
 * Build the prompt for "标连读". Streaming JSON array response.
 * `cueIdx` is the cue's index in the full transcript (so the LLM
 * echoes it back and the renderer knows which cue row to underline).
 */
export function buildLiaisonPrompt(ctx: TutorContext, cueIdx: number): string {
  const cue = ctx.cues[0]; // liaison context is always a single cue
  return `Identify connected-speech / liaison points in this English sentence that a Chinese learner is likely to mishear.

Cue text: "${cue.text}"

Output as a JSON array (ONLY the array, no surrounding prose):
[{"cueIdx": ${cueIdx}, "wordStart": "<word before the join>", "wordEnd": "<word after>", "pronunciation": "/IPA/", "why": "<Chinese explanation, 20-40 chars>"}]

Only include cases where the spoken form differs meaningfully from the written form (linking r, voiced-t reduction, /j/ insertion, flap, contraction etc.). An empty array [] is valid if there are no notable liaisons in this cue.`;
}
