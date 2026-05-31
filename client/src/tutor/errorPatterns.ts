// Controlled vocabulary of error patterns. LLM responses MUST emit one of
// these values; "other" is the safety fallback. New patterns require schema
// migration — don't ad-hoc add at call sites.

export const ERROR_PATTERNS = [
  // Grammar
  "past_tense_irregular",
  "past_tense_regular",
  "third_person_singular",
  "article_missing",
  "article_wrong",
  "preposition_wrong",
  "subject_verb_agreement",
  "present_perfect_vs_past",
  "modal_verb_wrong",
  "conditional_form",
  // Vocabulary / expression
  "chinglish_directness",
  "chinglish_word_order",
  "false_friend",
  "register_too_formal",
  "register_too_casual",
  "word_choice_unnatural",
  // Pronunciation (events only emitted in v2; types ready now)
  "pronunciation_th",
  "pronunciation_final_consonant_drop",
  "pronunciation_vowel_confusion",
  // Listening
  "listening_missed_keyword",
  "listening_misheard_homophone",
  // Fallback
  "other",
] as const;

export type ErrorPattern = (typeof ERROR_PATTERNS)[number];

const ERROR_PATTERN_SET = new Set<string>(ERROR_PATTERNS);

export function isErrorPattern(s: string): s is ErrorPattern {
  return ERROR_PATTERN_SET.has(s);
}

/** Coerce an LLM-supplied string into a valid pattern, falling back to
 *  "other" rather than throwing. The LLM occasionally hallucinates new
 *  pattern names; this lets the rest of the pipeline keep moving. */
export function coerceErrorPattern(s: string | undefined | null): ErrorPattern {
  if (s && isErrorPattern(s)) return s;
  return "other";
}

/** Chinese label for UI display. Keep keys aligned with ERROR_PATTERNS. */
export const ERROR_PATTERN_LABELS: Record<ErrorPattern, string> = {
  past_tense_irregular: "过去式不规则",
  past_tense_regular: "过去式（规则）",
  third_person_singular: "第三人称单数",
  article_missing: "冠词缺失",
  article_wrong: "冠词用错（a/an/the）",
  preposition_wrong: "介词错误",
  subject_verb_agreement: "主谓一致",
  present_perfect_vs_past: "现在完成 vs 一般过去",
  modal_verb_wrong: "情态动词",
  conditional_form: "条件句",
  chinglish_directness: "中式直译",
  chinglish_word_order: "中式语序",
  false_friend: "形近义异",
  register_too_formal: "语体过书面",
  register_too_casual: "语体过随意",
  word_choice_unnatural: "用词不自然",
  pronunciation_th: "/θ/ 音",
  pronunciation_final_consonant_drop: "尾辅音吞音",
  pronunciation_vowel_confusion: "元音混淆",
  listening_missed_keyword: "听漏关键词",
  listening_misheard_homophone: "听岔同音词",
  other: "其它",
};
