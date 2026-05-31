import { extractJsonObject } from "./lessonPlanLLM";
import { getProvider } from "../llm/providers";
import type { Settings } from "../types/settings";
import type { LearnerProfile, RoleplayScenario } from "./types";

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

function newSceneId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// MANDATORY CORRECTION 2: this function is SYNCHRONOUS (no async).
// The test's `await parseScenariosFromStream(...)` still works on a non-promise.
export function parseScenariosFromStream(
  rawStream: string,
  sourceVideoId: string | null,
): RoleplayScenario[] {
  const text = concatSse(rawStream);
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== "object") return [];
  const raw = obj as Record<string, unknown>;
  const sc = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  return sc
    .map((s): RoleplayScenario | null => {
      const r = s as Record<string, unknown>;
      if (
        typeof r.title !== "string" ||
        typeof r.userRole !== "string" ||
        typeof r.agentRole !== "string"
      ) {
        return null;
      }
      const d = r.difficulty;
      const difficulty: 1 | 2 | 3 = d === 1 || d === 2 || d === 3 ? d : 2;
      return {
        id: typeof r.id === "string" ? r.id : newSceneId(),
        title: r.title,
        setup: typeof r.setup === "string" ? r.setup : "",
        userRole: r.userRole,
        agentRole: r.agentRole,
        difficulty,
        sourceVideoId,
        vocabHints: Array.isArray(r.vocabHints)
          ? (r.vocabHints.filter((v) => typeof v === "string") as string[])
          : [],
      };
    })
    .filter((s): s is RoleplayScenario => s !== null)
    .slice(0, 3);
}

const SCENE_SYSTEM = `Given a video analysis.json and a learner profile, propose 1-3 roleplay scenarios anchored to the video's setting and topics. Output JSON only:
{ "scenarios": [
  { "id": "...", "title": "...", "setup": "...", "userRole": "...", "agentRole": "...", "difficulty": 1|2|3, "vocabHints": ["..."] }
] }
Titles like "你当旅客我当海关". Difficulty 1=A2, 2=B1, 3=B2+. vocabHints should be 3-5 English phrases from analysis.json the learner just saw.`;

export async function deriveScenarios(args: {
  settings: Settings;
  analysis: unknown;
  profile: LearnerProfile;
  sourceVideoId: string | null;
  signal?: AbortSignal;
}): Promise<RoleplayScenario[]> {
  // MANDATORY CORRECTION 1: use provider.stream() from "../llm/providers",
  // NOT provider.streamChat() from "../llm/llmIdentity".
  const provider = getProvider(args.settings);
  const profileSlice = {
    estimate: args.profile.estimate,
    weakPatterns: args.profile.masteryIndex.weakPatterns.slice(0, 5),
  };
  let raw = "";
  for await (const chunk of provider.stream({
    systemPrompt: SCENE_SYSTEM,
    userPrompt: JSON.stringify({ analysis: args.analysis, profile: profileSlice }),
    signal: args.signal,
  })) {
    raw += chunk;
  }
  // Wrap raw text into a fake SSE frame so parseScenariosFromStream handles it.
  const wrapped = `data: ${JSON.stringify({ choices: [{ delta: { content: raw } }] })}\n\ndata: [DONE]\n`;
  return parseScenariosFromStream(wrapped, args.sourceVideoId);
}
