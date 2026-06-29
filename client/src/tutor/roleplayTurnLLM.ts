import type { ObservedError, RoleplayScenario, RoleplayTurn } from "./types";
import { coerceErrorPattern } from "./errorPatterns";
import { extractJsonObject } from "./lessonPlanLLM";
import { getProvider } from "../llm/providers";
import type { Settings } from "../types/settings";

// ─────────────────────────────────────────────────────────────────────────
// SSE concatenator (shared with lessonPlanLLM — same wire shape)
// ─────────────────────────────────────────────────────────────────────────

function concatSse(raw: string): string {
  let out = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const body = line.slice(5).trim();
    if (!body || body === "[DONE]") continue;
    try {
      const obj = JSON.parse(body);
      const t =
        obj?.choices?.[0]?.delta?.content ??
        obj?.delta?.text ??
        obj?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof t === "string") out += t;
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Parser (SYNCHRONOUS — Correction 3)
// ─────────────────────────────────────────────────────────────────────────

export interface ParsedTurn {
  visibleText: string;
  observedErrors: ObservedError[];
}

const OBS_START = "<<<OBSERVATIONS>>>";
const OBS_END = "<<<END>>>";

/**
 * Parse a (potentially SSE-framed) turn response into visible text + observed
 * errors. Synchronous — no I/O. The `async` keyword is omitted intentionally
 * (Correction 3). Call sites may still `await` it harmlessly.
 */
export function parseTurnFromStream(rawStream: string): ParsedTurn {
  const full = concatSse(rawStream);
  const startIdx = full.indexOf(OBS_START);
  if (startIdx === -1) {
    return { visibleText: full.trim(), observedErrors: [] };
  }
  const visibleText = full.slice(0, startIdx).trim();
  const endIdx = full.indexOf(OBS_END, startIdx);
  const jsonChunk =
    endIdx === -1
      ? full.slice(startIdx + OBS_START.length).trim()
      : full.slice(startIdx + OBS_START.length, endIdx).trim();
  const obj = extractJsonObject(jsonChunk);
  if (!obj || typeof obj !== "object") {
    return { visibleText, observedErrors: [] };
  }
  const rawObs = (obj as Record<string, unknown>).observedErrors;
  if (!Array.isArray(rawObs)) {
    return { visibleText, observedErrors: [] };
  }
  const observedErrors: ObservedError[] = rawObs
    .map((o: unknown): ObservedError | null => {
      const r = o as Record<string, unknown>;
      if (typeof r.correction !== "string") return null;
      return {
        pattern: coerceErrorPattern(typeof r.pattern === "string" ? r.pattern : null),
        userText: typeof r.userText === "string" ? r.userText : "",
        correction: r.correction,
        detail: typeof r.detail === "string" ? r.detail : "",
      };
    })
    .filter((o): o is ObservedError => o !== null);
  return { visibleText, observedErrors };
}

// ─────────────────────────────────────────────────────────────────────────
// System-prompt builder
// ─────────────────────────────────────────────────────────────────────────

const TURN_SYSTEM = (s: RoleplayScenario) =>
  `You are roleplaying as ${s.agentRole} talking to a Chinese English learner playing ${s.userRole}. Scenario: ${s.setup}. Stay in character.

CRITICAL — LANGUAGE: Your visible reply MUST be in natural English ONLY. Never write any Chinese in the visible reply, no matter what language the user uses. If the learner replies in Chinese or mixes Chinese in, gently steer them back to English while staying in character — still entirely in English. (Only the hidden observation JSON below may contain Chinese in its "detail"/"correction" fields.)

Keep the conversation going: end each reply with a follow-up question or move the scene forward so the learner always has something to respond to. Do NOT wrap up or end the conversation yourself — it continues until the learner chooses to stop. Respond conversationally in 1-3 sentences. THEN on a new line, output a JSON block in this exact form (the user UI hides this from them):
${OBS_START}
{"observedErrors": [
  { "pattern": "<from controlled list>", "userText": "...", "correction": "...", "detail": "..." }
]}
${OBS_END}

If the user's last turn had no errors, emit "observedErrors": [].

Controlled patterns: past_tense_irregular, past_tense_regular, third_person_singular, article_missing, article_wrong, preposition_wrong, subject_verb_agreement, present_perfect_vs_past, modal_verb_wrong, conditional_form, chinglish_directness, chinglish_word_order, false_friend, register_too_formal, register_too_casual, word_choice_unnatural, other.`;

// ─────────────────────────────────────────────────────────────────────────
// LLM caller (Corrections 1 + 2)
// ─────────────────────────────────────────────────────────────────────────

export async function generateTurn(args: {
  settings: Settings;
  scenario: RoleplayScenario;
  history: RoleplayTurn[];
  userMessage: string;
  signal?: AbortSignal;
}): Promise<ParsedTurn> {
  // Correction 2: fold history + new user message into a single userPrompt
  // string — provider.stream() takes no messages array.
  // Agent turns already store only visibleText (no OBSERVATIONS block) so
  // we never replay the hidden JSON to the model.
  const transcript = args.history
    .map((t) => `${t.role === "user" ? "User" : args.scenario.agentRole}: ${t.text}`)
    .join("\n");
  const userPrompt =
    (transcript ? transcript + "\n" : "") + `User: ${args.userMessage}`;

  // Correction 1: use provider.stream() (not streamChat)
  const provider = getProvider(args.settings);
  let raw = "";
  for await (const chunk of provider.stream({
    systemPrompt: TURN_SYSTEM(args.scenario),
    userPrompt,
    signal: args.signal,
  })) {
    raw += chunk;
  }

  // Wrap into a single SSE frame so parseTurnFromStream handles both
  // streaming and non-streaming paths uniformly.
  const wrapped = `data: ${JSON.stringify({ choices: [{ delta: { content: raw } }] })}\n\ndata: [DONE]\n`;
  return parseTurnFromStream(wrapped);
}
