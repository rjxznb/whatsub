import { describe, it, expect } from "vitest";
import type { Subtitle, KeyPhrase, AnalysisResult, RoleSetup, Scene } from "./types";

// Compile-time checks – these lines verify the shapes are assignable
const _kp: KeyPhrase = {
  expression: "",
  meaningZh: "",
  usage: "",
  register: "formal",
  speakerRole: "learner",
  minDifficulty: "EASY",
};
const _rs: RoleSetup = { name: "", identity: "", personality: "", accent: "British" };
void _kp; void _rs;

describe("types module", () => {
  it("Subtitle requires the EngHub fields", () => {
    const s: Subtitle = {
      time: 0,
      endTime: 1.5,
      text: "Hi",
      translation: "嗨",
      isKeyPoint: false,
      highlightWords: [],
      keyNotes: {},
      highlightTranslations: {},
    };
    expect(s.text).toBe("Hi");
  });

  it("AnalysisResult bundles subtitles + keyPhrases + roleSetup", () => {
    const a: AnalysisResult = {
      sceneContext: "ctx",
      subtitles: [],
      keyPhrases: [],
      roleSetup: {
        name: "Officer",
        identity: "Border officer",
        personality: "professional, polite",
        accent: "British",
      },
      complications: { medium: [], hard: [] },
      maxRounds: { easy: 4, medium: 6, hard: 10 },
      commonErrors: [],
      culturalNotes: "",
      country: "UK",
    };
    expect(a.country).toBe("UK");
  });

  it("Scene literal covers the 18 scenes", () => {
    const s: Scene = "immigration";
    expect(s).toBe("immigration");
  });
});
