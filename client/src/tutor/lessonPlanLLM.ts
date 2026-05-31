import type { LessonPlan, TeachingAnchor } from "./types";
import { coerceErrorPattern } from "./errorPatterns";

/** Pull the first balanced JSON object out of a string, even if wrapped
 *  in markdown code fences or natural-language framing. Returns null on
 *  unrecoverable input — caller decides whether to retry the LLM. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  // Try direct parse first (happiest path)
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  // Strip code fence with optional language tag
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* fall through */
    }
  }
  // Greedy: find first { … last } and try parsing the slice
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

/** Concatenate SSE `data:` chunks into the final assistant text. Works
 *  for OpenAI-compatible AND Claude AND Gemini formats — the schemas
 *  differ but they all carry the text under .delta.content / .text /
 *  .candidates[0].content.parts[0].text respectively. */
function concatenateSseText(raw: string): string {
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    try {
      const obj = JSON.parse(body);
      // OpenAI-compatible
      const ocText = obj?.choices?.[0]?.delta?.content;
      if (typeof ocText === "string") {
        out += ocText;
        continue;
      }
      // Claude
      const claudeText = obj?.delta?.text;
      if (typeof claudeText === "string") {
        out += claudeText;
        continue;
      }
      // Gemini
      const gemText = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof gemText === "string") {
        out += gemText;
        continue;
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Parse a complete (already buffered) SSE stream into a LessonPlan.
 *  Returns null if not recoverable. Coerces unknown patterns to 'other'
 *  rather than rejecting — keeps the user moving on LLM hallucinations. */
export async function parseLessonPlanFromStream(
  rawStream: string,
): Promise<LessonPlan | null> {
  const text = concatenateSseText(rawStream);
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as Record<string, unknown>;

  if (
    typeof raw.videoId !== "string" ||
    typeof raw.overview !== "string" ||
    !Array.isArray(raw.anchors)
  ) {
    return null;
  }

  const anchors: TeachingAnchor[] = [];
  for (const a of raw.anchors as Array<Record<string, unknown>>) {
    if (
      typeof a.cueIdx !== "number" ||
      typeof a.topic !== "string" ||
      typeof a.whyThisOne !== "string"
    ) {
      continue;
    }
    const tp = Array.isArray(a.targetPatterns) ? a.targetPatterns : [];
    anchors.push({
      cueIdx: a.cueIdx,
      topic: a.topic,
      whyThisOne: a.whyThisOne,
      targetPatterns: tp.map((s) => coerceErrorPattern(typeof s === "string" ? s : null)),
    });
  }

  if (anchors.length === 0) return null;

  // Enforce monotonic cueIdx — sort, then drop neighbors closer than 1 cue.
  anchors.sort((a, b) => a.cueIdx - b.cueIdx);
  const spaced: TeachingAnchor[] = [];
  for (const a of anchors) {
    const prev = spaced[spaced.length - 1];
    if (!prev || a.cueIdx - prev.cueIdx >= 1) spaced.push(a);
  }

  return {
    videoId: raw.videoId,
    estimateTokens: typeof raw.estimateTokens === "number" ? raw.estimateTokens : 3000,
    overview: raw.overview,
    anchors: spaced,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Live planning function (LLM call)
// ─────────────────────────────────────────────────────────────────────────

import { getProvider } from "../llm/providers";
import type { Settings } from "../types/settings";
import type { LearnerProfile } from "./types";

const SYSTEM_PROMPT = `You are an English-as-foreign-language tutor planning a guided lesson on a video for a Chinese-speaking learner. Output ONLY a JSON object matching this schema (no markdown, no commentary):

{
  "videoId": string,
  "estimateTokens": number,
  "overview": string (≤100 chars Chinese),
  "anchors": Array<{
    "cueIdx": number,
    "topic": string,
    "whyThisOne": string,
    "targetPatterns": Array<string from the controlled list below>
  }>
}

Pick 5-8 teaching anchors (3 if video < 3 min, 5 if < 6 min, 7 if < 10 min, 8 otherwise). Required priorities, in order:
1. Cues that hit the learner's weakPatterns (top 5).
2. Cues with ≥2 unfamiliar words from analysis.json highlights.
3. Cues with high pedagogical value (idioms, set phrases, grammar inflection points).

Excluded: Two anchors within 15 seconds of each other in the video timeline.

Controlled patterns: past_tense_irregular, past_tense_regular, third_person_singular, article_missing, article_wrong, preposition_wrong, subject_verb_agreement, present_perfect_vs_past, modal_verb_wrong, conditional_form, chinglish_directness, chinglish_word_order, false_friend, register_too_formal, register_too_casual, word_choice_unnatural, other.

Example output for a 4-minute immigration vlog:
{"videoId":"abc123","estimateTokens":3500,"overview":"教入境对话最常见的 5 个表达","anchors":[{"cueIdx":3,"topic":"I'm here for X","whyThisOne":"学员上次也错过 be here for","targetPatterns":["preposition_wrong"]}]}
`;

export interface PlanLessonInput {
  videoId: string;
  analysis: unknown;          // analysis.json content
  profile: LearnerProfile;
  settings: Settings;         // for LLM picker
  signal?: AbortSignal;
}

export async function planLesson(input: PlanLessonInput): Promise<LessonPlan | null> {
  const provider = getProvider(input.settings);
  // Strip the profile down — only weak patterns + last 30 events matter.
  const profileSlice = {
    estimate: input.profile.estimate,
    weakPatterns: input.profile.masteryIndex.weakPatterns.slice(0, 10),
    recentEvents: input.profile.errorEvents.slice(-30),
  };
  const userMessage = JSON.stringify({
    videoId: input.videoId,
    analysis: input.analysis,
    profile: profileSlice,
  });

  // MANDATORY CORRECTION 1: use provider.stream() (not streamChat) per the
  // actual Provider interface in src/llm/providers/types.ts
  let raw = "";
  for await (const chunk of provider.stream({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userMessage,
    signal: input.signal,
  })) {
    raw += chunk;
  }

  return parseLessonPlanFromStream(`data: {"choices":[{"delta":{"content":${JSON.stringify(raw)}}}]}\n\ndata: [DONE]\n`);
  // ^ We wrap raw in a single SSE frame so the same parser handles both
  // streaming and non-streaming providers. Cheap, removes a code path.
}
