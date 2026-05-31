import type { ErrorPattern } from "./errorPatterns";

export interface RemediationQuestion {
  id: string;
  prompt: string;        // Chinese prompt
  type: "fill" | "choice" | "transform";
  expected: string;      // canonical answer
  choices?: string[];    // for "choice" type
  hint?: string;
}

/** Hard-coded 20+ items per high-frequency pattern. v1 just ships a few
 *  patterns; we add more as the data shows demand. LLM generates 2
 *  additional per session in the runtime; this bank is the fallback. */
const BANK: Partial<Record<ErrorPattern, RemediationQuestion[]>> = {
  past_tense_irregular: [
    { id: "pti_1", type: "fill", prompt: "她昨天买了一本书。", expected: "She bought a book yesterday.", hint: "buy → bought" },
    { id: "pti_2", type: "choice", prompt: "He __ the coffee.", choices: ["drank", "drinked", "drunk"], expected: "drank" },
    { id: "pti_3", type: "transform", prompt: "改错：I goed to the shop yesterday.", expected: "I went to the shop yesterday." },
    { id: "pti_4", type: "fill", prompt: "他上周看了那部电影。", expected: "He saw that movie last week.", hint: "see → saw" },
    { id: "pti_5", type: "choice", prompt: "I __ my keys this morning.", choices: ["losed", "lost", "loosed"], expected: "lost" },
    { id: "pti_6", type: "transform", prompt: "改错：She catched the ball.", expected: "She caught the ball." },
    { id: "pti_7", type: "fill", prompt: "我吃完早饭了。", expected: "I ate breakfast." },
    { id: "pti_8", type: "choice", prompt: "They __ the news yesterday.", choices: ["knowed", "knew", "knowen"], expected: "knew" },
  ],
  article_missing: [
    { id: "am_1", type: "fill", prompt: "我是学生。", expected: "I am a student." },
    { id: "am_2", type: "transform", prompt: "改错：I'm student from China.", expected: "I'm a student from China." },
    { id: "am_3", type: "choice", prompt: "I went to __ supermarket.", choices: ["the", "a", "(none)"], expected: "the" },
    { id: "am_4", type: "fill", prompt: "他买了一辆新车。", expected: "He bought a new car." },
    { id: "am_5", type: "transform", prompt: "改错：Can you pass me salt?", expected: "Can you pass me the salt?" },
    { id: "am_6", type: "choice", prompt: "She is __ engineer.", choices: ["an", "a", "(none)"], expected: "an" },
  ],
  third_person_singular: [
    { id: "tps_1", type: "fill", prompt: "她每天早上跑步。", expected: "She runs every morning." },
    { id: "tps_2", type: "transform", prompt: "改错：He go to school by bus.", expected: "He goes to school by bus." },
    { id: "tps_3", type: "choice", prompt: "My mum __ tea every afternoon.", choices: ["drink", "drinks", "drinking"], expected: "drinks" },
    { id: "tps_4", type: "fill", prompt: "他不喜欢咖啡。", expected: "He doesn't like coffee." },
  ],
  preposition_wrong: [
    { id: "pw_1", type: "choice", prompt: "I'll see you __ Monday.", choices: ["in", "on", "at"], expected: "on" },
    { id: "pw_2", type: "transform", prompt: "改错：I'm waiting since 2 hours.", expected: "I've been waiting for 2 hours." },
    { id: "pw_3", type: "fill", prompt: "我等了你两小时。", expected: "I've been waiting for you for two hours." },
    { id: "pw_4", type: "choice", prompt: "She is good __ math.", choices: ["in", "at", "on"], expected: "at" },
  ],
  present_perfect_vs_past: [
    { id: "pp_1", type: "choice", prompt: "I __ him three times this week.", choices: ["saw", "have seen", "see"], expected: "have seen" },
    { id: "pp_2", type: "transform", prompt: "改错：I have seen him yesterday.", expected: "I saw him yesterday." },
    { id: "pp_3", type: "fill", prompt: "我以前去过英国。", expected: "I have been to the UK before." },
  ],
};

export function getQuestionsForPattern(pattern: ErrorPattern, n: number): RemediationQuestion[] {
  const all = BANK[pattern] ?? [];
  // Stable shuffle: take first n in their declared order, no Math.random
  // so tests are deterministic without seeding. The 5-day cool-down means
  // users rarely see the same first-N twice in a row anyway.
  return all.slice(0, n);
}

export function isAvailablePattern(pattern: ErrorPattern): boolean {
  return Array.isArray(BANK[pattern]) && (BANK[pattern]?.length ?? 0) > 0;
}
