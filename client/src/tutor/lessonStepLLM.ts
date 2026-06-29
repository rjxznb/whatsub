import type { ErrorPattern } from "./errorPatterns";
import { coerceErrorPattern } from "./errorPatterns";
import { extractJsonObject } from "./lessonPlanLLM";
import type { Subtitle } from "../llm/types";

/** Explaining a cue only needs that cue + a little surrounding context, not the
 *  whole video. Return a window of cues around cueIdx, each keyed by its real
 *  index `i` (so anchor.cueIdx still resolves) with the Chinese translation. */
function passageAround(analysis: unknown, cueIdx: number) {
  const cues = Array.isArray(analysis) ? (analysis as Subtitle[]) : [];
  const from = Math.max(0, cueIdx - 2);
  const to = Math.min(cues.length, cueIdx + 5);
  return cues.slice(from, to).map((c, k) => ({
    i: from + k,
    text: c?.text ?? "",
    zh: c?.translation ?? "",
    hl: c?.highlightWords?.filter(Boolean) ?? [],
  }));
}

// Reuse the SSE concatenation logic. Re-implementing per file would drift.
// The SSE-concat helper is duplicated here intentionally to avoid depending
// on another module's internal — lessonPlanLLM does not export it.

function concatSse(raw: string): string {
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    try {
      const obj = JSON.parse(body);
      const t1 = obj?.choices?.[0]?.delta?.content;
      const t2 = obj?.delta?.text;
      const t3 = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof t1 === "string") out += t1;
      else if (typeof t2 === "string") out += t2;
      else if (typeof t3 === "string") out += t3;
    } catch {
      /* skip */
    }
  }
  return out;
}

// ──────────── Step 2 (讲解) ────────────

export function parseExplainFromStream(rawStream: string): string {
  return concatSse(rawStream).trim();
}

// ──────────── Step 3 (问题) ────────────

export interface LessonQuestion {
  question: string;
  expectedAnswer: string;
  targetPattern: ErrorPattern;
}

export function parseQuestionFromStream(
  rawStream: string,
): LessonQuestion | null {
  const text = concatSse(rawStream);
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Record<string, unknown>;
  if (typeof raw.question !== "string" || typeof raw.expectedAnswer !== "string") {
    return null;
  }
  return {
    question: raw.question,
    expectedAnswer: raw.expectedAnswer,
    targetPattern: coerceErrorPattern(
      typeof raw.targetPattern === "string" ? raw.targetPattern : null,
    ),
  };
}

// ──────────── Step 5 (反馈) ────────────

export type FeedbackVerdict = "correct" | "partial" | "incorrect";

export interface LessonFeedback {
  verdict: FeedbackVerdict;
  feedback: string;
  errors: Array<{
    pattern: ErrorPattern;
    userText: string;
    correction: string;
    detail: string;
  }>;
}

export function parseFeedbackFromStream(
  rawStream: string,
): LessonFeedback | null {
  const text = concatSse(rawStream);
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Record<string, unknown>;
  const v = typeof raw.verdict === "string" ? raw.verdict : "";
  if (v !== "correct" && v !== "partial" && v !== "incorrect") return null;
  const errorsRaw = Array.isArray(raw.errors) ? raw.errors : [];
  const errors = errorsRaw
    .map((e: unknown) => {
      const r = e as Record<string, unknown>;
      if (typeof r.pattern !== "string" || typeof r.correction !== "string") return null;
      return {
        pattern: coerceErrorPattern(r.pattern),
        userText: typeof r.userText === "string" ? r.userText : "",
        correction: r.correction,
        detail: typeof r.detail === "string" ? r.detail : "",
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  return {
    verdict: v as FeedbackVerdict,
    feedback: typeof raw.feedback === "string" ? raw.feedback : "",
    errors,
  };
}

// ──────────── Live LLM adapter ────────────

import { getProvider } from "../llm/providers";
import type { Settings } from "../types/settings";
import type { LessonPlan } from "./types";
import type { LessonLlmAdapter } from "./lessonRuntime";

const EXPLAIN_SYSTEM = `You are a Chinese-speaking learner's English tutor. Input is { anchor: {cueIdx, topic, ...}, analysis: [{i, text, zh, hl}] } — explain the cue whose i === anchor.cueIdx (the others are surrounding context). Explain it in plain natural Chinese (~80-150 chars), then list 1-3 key vocab items in **word**: 中文释义 markdown. End with one sentence on cultural/register context. Do NOT ask a question — that comes next.`;

const QUESTION_SYSTEM = `Generate ONE short Chinese-language English-production question for the learner, based on the just-explained cue. Output JSON only:
{ "question": "...", "expectedAnswer": "...", "targetPattern": "<pattern>" }
Question ≤40 chars. expectedAnswer is the model English answer.`;

const FEEDBACK_SYSTEM = `You are grading the learner's English answer. Output JSON only:
{
  "verdict": "correct" | "partial" | "incorrect",
  "feedback": "<≤200 char Chinese explanation>",
  "errors": [
    { "pattern": "<from controlled list>", "userText": "...", "correction": "...", "detail": "..." }
  ]
}
"partial" = essentially right but missed an article/preposition. Treat as correct for advancing but emit one error.

Controlled patterns: past_tense_irregular, past_tense_regular, third_person_singular, article_missing, article_wrong, preposition_wrong, subject_verb_agreement, present_perfect_vs_past, modal_verb_wrong, conditional_form, chinglish_directness, chinglish_word_order, false_friend, register_too_formal, register_too_casual, word_choice_unnatural, other.`;

async function streamToText(
  settings: Settings,
  system: string,
  userMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const provider = getProvider(settings);
  let out = "";
  for await (const chunk of provider.stream({ systemPrompt: system, userPrompt: userMessage, signal })) {
    out += chunk;
  }
  return out;
}

export function makeLiveLessonLlmAdapter(
  settings: Settings,
  signal?: AbortSignal,
): LessonLlmAdapter {
  return {
    async explain({ plan, anchorIdx, analysis }: { plan: LessonPlan; anchorIdx: number; analysis: unknown }) {
      const anchor = plan.anchors[anchorIdx];
      const userMsg = JSON.stringify({ anchor, analysis: passageAround(analysis, anchor.cueIdx) });
      return streamToText(settings, EXPLAIN_SYSTEM, userMsg, signal);
    },
    async question({ plan, anchorIdx, explainText }: { plan: LessonPlan; anchorIdx: number; explainText: string }) {
      const anchor = plan.anchors[anchorIdx];
      const userMsg = JSON.stringify({ anchor, explainText });
      const raw = await streamToText(settings, QUESTION_SYSTEM, userMsg, signal);
      const wrappedSse = `data: {"choices":[{"delta":{"content":${JSON.stringify(raw)}}}]}\n\ndata: [DONE]\n`;
      return parseQuestionFromStream(wrappedSse);
    },
    async feedback({ plan, anchorIdx, question, userAnswer, attempt }: { plan: LessonPlan; anchorIdx: number; question: LessonQuestion; userAnswer: string; attempt: number }) {
      const anchor = plan.anchors[anchorIdx];
      const userMsg = JSON.stringify({ anchor, question, userAnswer, attempt });
      const raw = await streamToText(settings, FEEDBACK_SYSTEM, userMsg, signal);
      const wrappedSse = `data: {"choices":[{"delta":{"content":${JSON.stringify(raw)}}}]}\n\ndata: [DONE]\n`;
      return parseFeedbackFromStream(wrappedSse);
    },
  };
}
