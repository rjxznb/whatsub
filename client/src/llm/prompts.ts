import type { SrtCue, Subtitle } from "./types";
import type { TranslationStyle } from "../types/settings";

/**
 * Per-style guidance inserted into the system prompt's "translation register"
 * paragraph (replaces the generic Rule #7). Each entry tells the model the
 * register, vocabulary tilt, and what to do with filler words. The other
 * 9 rules + JSON schema are identical across styles.
 *
 * Adding a new style: add a key here, add the same key to TranslationStyle
 * in types/settings.ts, and add a label in TRANSLATION_STYLE_LABELS below.
 */
const STYLE_GUIDANCE: Record<TranslationStyle, string> = {
  colloquial: `Translation register: NATURAL CHINESE CONVERSATION. Sound like a young
native speaker chatting with friends. Allow contractions, omitted subjects,
soft particles (吧/啊/呢/嘛). Translate filler words faithfully (Uh→呃,
Hmm→嗯, You know→你懂的). Avoid 书面化措辞 like 因此/此外/然而 unless
the original is also formal. Idioms welcomed when they fit, but don't force
them.`,

  neutral: `Translation register: NEUTRAL EVERYDAY CHINESE — neither formal nor
casual. Mostly complete sentences with standard punctuation. Plain spoken
vocabulary: 但是/不过/而且/所以 are typical connectors (avoid heavier
书面化 like 因此/然而/此外 unless the original is academic). No 啊/吧/呢/嘛
particles. Drop most filler words (Uh / Hmm / You know) rather than
transcribing them, but a single particle is OK if it carries real meaning.
No internet slang, no 文言 flourishes, no movie-subtitle compression. Goal:
a clear, natural read that sounds like how a thoughtful adult would phrase
it talking to someone they don't know well.`,

  playful: `Translation register: VIVID AND EXPRESSIVE. Reach for punchy verbs and
colorful adjectives over neutral ones (爽 over 开心, 拽 over 厉害, 整 over 做).
Onomatopoeia and exclamations encouraged (wow→哇塞, oh no→糟了, ugh→啊这).
Translate with the energy of a voice actor, not a news anchor — preserve
emotional beats. Light internet vernacular OK when it sounds natural; avoid
stale memes.`,

  cinematic: `Translation register: MOVIE-SUBTITLE STYLE. **Brevity is a hard
constraint** — translations should be roughly the same length as the English
or shorter, never longer. Cut filler, redundant subjects, polite hedges.
Allow drama (短促有力的措辞、emotional emphasis), and where it improves
flow you may use a more literary turn ("此情可待" over "我会一直记得").
No 啊/吧/嘛 particles. Suitable for film, drama, prestige TV.`,

  formal: `Translation register: FORMAL WRITTEN CHINESE. Full sentences, complete
punctuation, regular grammar. Vocabulary tilts toward newspaper/textbook
level (因此/然而/此外/此刻 are fine; 不过/但是 also OK in moderation).
Drop filler words rather than transcribing them ("Uh..."→just elide them).
No particles like 啊/吧/嘛. Suitable for business, news, academic content.`,

  literary: `Translation register: REFINED AND POETIC. Word choice precise and elegant;
favor 四字格 / 文言-tinged phrasing where it fits naturally (don't force it
on plain conversation). Preserve mood and imagery over literal accuracy. May
trim filler aggressively. Suitable for poetry, romance, literary essays,
auteur cinema. NEVER cross into stiff archaism — the goal is *evocative*,
not *museum-piece*.`,
};

/** UI labels for the style slider. Plain Chinese, no emoji — the previous
 *  emoji-tagged dropdown felt over-stylized; the slider now shows just
 *  formal / neutral / colloquial as positions, with the labels below
 *  serving as anchors rather than menu items. Legacy styles are mapped
 *  to the nearest slider position for any UI that still needs a label. */
export const TRANSLATION_STYLE_LABELS: Record<TranslationStyle, string> = {
  formal: "正式",
  neutral: "中性",
  colloquial: "口语",
  playful: "口语",
  cinematic: "中性",
  literary: "正式",
};

export function buildSystemPrompt(style: TranslationStyle = "colloquial"): string {
  const styleBlock = STYLE_GUIDANCE[style] ?? STYLE_GUIDANCE.colloquial;
  return SYSTEM_PROMPT_TEMPLATE.replace("{{STYLE_GUIDANCE}}", styleBlock);
}

const SYSTEM_PROMPT_TEMPLATE = `You are an English subtitle analyst for a learning app.

Given English subtitle cues, produce structured analysis: Chinese translations, key phrase highlighting, and (when explicitly requested in a separate follow-up turn) a global "key phrases" review list.

OUTPUT FORMAT — REQUIRED
- Output ONLY JSON Lines (one JSON object per line, no markdown, no code fences, no prose).
- Per-cue request: one line = one analyzed subtitle cue, in the order received. NEVER include a summary line in a per-cue response.
- Summary request (a separate turn): output a SINGLE summary line; do NOT repeat any cue lines.

PER-CUE JSONL SCHEMA
{"i":12,"zh":"我得把邮件处理一下","p":[["catch up","处理一下","动词短语，表示赶上或补做落下的事情"]]}

i = supplied cue index.
zh = Chinese translation.
p = zero or one phrase tuple: [exact English source, exact Chinese substring, Chinese usage note].

WRONG (these have caused real bugs — DO NOT do this):
- Echoing source-owned fields such as text, time, or endTime.
- Returning phrase tuples whose English source is not an exact substring of the cue text.
- Returning a phrase tuple whose Chinese phrase is not an exact substring of zh.

SUMMARY JSONL SCHEMA (only when the user prompt explicitly asks for it)
{"p":[["catch up","补上","用于表示赶上进度或补做遗漏事项"]]}

Each summary tuple is [English expression, concise Chinese meaning, Chinese usage note].

CRITICAL RULES (these have caused bugs in the past — follow them strictly):

1. Each English phrase MUST be an exact substring of the cue text, character-for-character. If the original text has a typo like "teddy beir", use "teddy beir" — DO NOT correct it to "teddy bear".

2. Each phrase's Chinese translation MUST be an exact substring of zh. Do NOT use "和……结合" or "以……闻名" — these are templates with ellipses, NOT substrings of any real translation.

3. Phrase note values: 25 to 90 Chinese characters each. Explain meaning + usage context substantively, not just translation.

4. Each cue: AT MOST 1 phrase. It must contain one to four English words.

5. Select reusable learner-worthy chunks: phrasal verbs, fixed collocations, common collocations, idioms, pragmatic spoken expressions, discourse expressions, or easily misunderstood uses. A familiar expression still qualifies when its combination or conversational use is worth reusing. Omit greetings, fillers, names, numbers, function words, ordinary literal noun phrases, and simple compositional sentences. Use p=[] whenever there is no useful learning phrase.

6. NEVER use raw double quotes inside JSON string values. For Chinese quoted text use 「」 not "". For English quoted text use single quotes or rephrase.

7. {{STYLE_GUIDANCE}}

8. Each phrase source must be a substring of THE SAME CUE'S text. Don't span across cues.

9. Output one JSON object per line. No multi-line objects. No leading/trailing whitespace beyond the newline separator.

10. The numeric i value is authoritative. Copy the translation for the cue with that exact i; never move a translation, phrase, or note from one cue to another. Before emitting each line, verify that its zh answers that same cue's English text, not the previous or next cue.

11. p MUST be an array containing zero or one [source, translation, note] tuple. If you can't write a 25 to 90 Chinese character note AND find an exact translation substring for a phrase, omit that phrase entirely.
`;

function serializeCues(cues: readonly SrtCue[]): string {
  return cues
    .map((cue) => `${cue.index}\t${cue.time.toFixed(2)}\t${cue.endTime.toFixed(2)}\t${JSON.stringify(cue.text)}`)
    .join("\n");
}

export interface CompactPromptOptions {
  maxHighlightedCues: number;
}

function compactAllowance(options: CompactPromptOptions): string {
  const limit = Math.max(0, Math.floor(options.maxHighlightedCues));
  const density = limit === 0
    ? "No highlight slots remain, so return p=[] for every cue."
    : `Actively scan every cue for reusable learning expressions. When enough genuinely useful candidates exist, use most of the available allowance (roughly 60% to 100%; with an allowance of 20, usually select 12 to 20 cues). Do not leave an obvious reusable phrase unannotated merely to be conservative, but never invent or lower quality to fill the allowance.`;
  return `At most ${limit} cues in this request may have a non-empty p array. This is a hard ceiling, not a quota. ${density} Each selected phrase must contain one to four English words and its substantive Chinese usage note must contain 25 to 90 Chinese characters.`;
}

export function buildUserPrompt(
  cues: readonly SrtCue[],
  options: CompactPromptOptions,
): string {
  const cuesJson = serializeCues(cues);
  return `Subtitle cues (tab-separated: index<TAB>start<TAB>end<TAB>JSON-encoded text):
${cuesJson}

Produce one JSON-line per cue in order. Per-cue lines ONLY — do NOT emit a summary line; the summary will be requested separately.
${compactAllowance(options)}`;
}

export function buildContinuationPrompt(
  cues: readonly SrtCue[],
  options: CompactPromptOptions,
): string {
  const cuesJson = serializeCues(cues);
  return `Continuing analysis. Next batch:
${cuesJson}

One JSON object per cue. Do NOT emit a summary line.
${compactAllowance(options)}`;
}

export function buildRepairPrompt(
  cues: readonly SrtCue[],
  options: CompactPromptOptions,
): string {
  return `The following subtitle cues are still unresolved. Return exactly one JSON object for every supplied index and no other indexes:
${serializeCues(cues)}

One compact JSON object per cue. No markdown, prose, source-field echoes, or summary line.
${compactAllowance(options)}`;
}

export interface AnnotationRepairInput {
  index: number;
  text: string;
  translation: string;
}

export function buildAnnotationRepairPrompt(
  items: readonly AnnotationRepairInput[],
  options: CompactPromptOptions,
): string {
  const inputs = items.map((item) => JSON.stringify({
    i: item.index,
    text: item.text,
    translation: item.translation,
  })).join("\n");
  return `Repair only the learning-phrase annotations for these already translated cues:
${inputs}

Return one line per supplied cue: {"i":12,"p":[["English phrase","中文片段","中文用法说明"]]}
Do not translate again. Do not return zh, text, timestamps, prose, or markdown.
Use p=[] when no useful phrase exists. Phrase sources and Chinese fragments must be exact substrings of the supplied text and translation.
${compactAllowance(options)}`;
}

export function buildAnnotationFillPrompt(
  items: readonly AnnotationRepairInput[],
  options: CompactPromptOptions,
): string {
  const inputs = items.map((item) => JSON.stringify({
    i: item.index,
    text: item.text,
    translation: item.translation,
  })).join("\n");
  return `The first analysis pass was too sparse for these already translated subtitle cues. Re-scan every cue and add a learning phrase when a genuine reusable expression exists:
${inputs}

Return one line per supplied cue: {"i":12,"p":[["English phrase","中文片段","中文用法说明"]]}
Use p=[] only when the cue truly has no reusable learning expression. Do not translate again. Phrase sources and Chinese fragments must be exact substrings of the supplied text and translation.
${compactAllowance(options)}`;
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

Schema:
{"p":[["catch up","补上","用于表示赶上进度或补做遗漏事项"]]}

Each p tuple is [English expression, concise Chinese meaning, Chinese usage note].

Rules:
- Deduplicate by expression (case-insensitive). Pick the most natural canonical form.
- Drop trivial fillers, greetings, function words; keep idioms, phrasal verbs, vocabulary worth reviewing.
- Each expression must contain one to four English words.
- Aim for 8-20 entries depending on transcript size.
- Chinese meaning: 8-25 Chinese characters; concise gloss.
- Chinese usage note: 25-90 Unicode code points; substantively explain how and when it is used.

Output exactly one JSON object on one line. No fences, no prose, no other lines.`;
}

/**
 * Single-shot lookup of a user-selected word or short phrase. Used by the
 * subtitle selection bubble to fetch a Chinese gloss + usage for arbitrary
 * vocab adds (separate from the per-cue analysis pipeline).
 *
 * Output is parsed by `lookupExpression.ts` as a single JSON object.
 */
export function buildLookupPrompt(expression: string, cueText: string): string {
  return `请给出下面英文单词或短语的中文释义和简短中文用法说明。结合上下文判断在这一句里的具体含义。

单词/短语：${expression}

上下文：${cueText}

输出严格的 JSON 对象，只能包含两个字段，不要任何其他文字、Markdown 代码块、注释：

{"meaningZh": "中文释义（10-30 字）", "usage": "中文用法说明（30-80 字，举一个简单例子或描述使用语境）"}`;
}
