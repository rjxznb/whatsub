import { describe, expect, it } from "vitest";
import {
  fingerprintTranscript,
  parsePersistedAnalysis,
  prepareAnalysis,
} from "./analysisCheckpoint";
import type {
  AnalysisResult,
  CheckpointedAnalysis,
  SrtCue,
  Subtitle,
} from "./types";

const cues: SrtCue[] = [
  { index: 1, time: 0, endTime: 1, text: "First" },
  { index: 2, time: 1, endTime: 2, text: "Second" },
  { index: 3, time: 2, endTime: 3, text: "Third" },
];

const transcriptFingerprint =
  "sha256:52644329ac80b3fd47f022b08fd0ff31bb3215a843146de773927da0f0a406a2";

const subtitle = (text: string): Subtitle => ({
  time: 0,
  endTime: 1,
  text,
  translation: `译文：${text}`,
  isKeyPoint: false,
  highlightWords: [],
  keyNotes: {},
  highlightTranslations: {},
});

describe("analysis checkpoints", () => {
  it("rejects malformed domain objects before checkpoint recovery", () => {
    expect(
      parsePersistedAnalysis({
        subtitles: [{ ...subtitle("Bad"), time: "bad" }],
        keyPhrases: [],
      }),
    ).toBeNull();
    expect(
      parsePersistedAnalysis({
        subtitles: [subtitle("Good")],
        keyPhrases: [{ expression: 42, meaningZh: "含义", usage: "示例" }],
      }),
    ).toBeNull();
  });

  it("accepts valid legacy analysis and forward-compatible checkpoint extras", () => {
    const legacy = { subtitles: [subtitle("Legacy")], keyPhrases: [] };
    expect(parsePersistedAnalysis(legacy)).toEqual(legacy);

    const checkpointed = {
      ...legacy,
      checkpoint: {
        version: 1,
        transcriptFingerprint,
        nextCueOffset: 1,
        phase: "cues",
        revision: 2,
        futureField: "preserved",
      },
      futureTopLevelField: true,
    };
    expect(parsePersistedAnalysis(checkpointed)).toEqual(checkpointed);
  });

  it("rejects malformed checkpoint shape before transcript-dependent validation", () => {
    expect(
      parsePersistedAnalysis({
        subtitles: [],
        keyPhrases: [],
        checkpoint: {
          version: 1,
          transcriptFingerprint,
          nextCueOffset: 0,
          phase: "cues",
          revision: -1,
        },
      }),
    ).toBeNull();
  });

  it("creates a stable SHA-256 fingerprint from cue identity and content", async () => {
    await expect(fingerprintTranscript(cues)).resolves.toBe(transcriptFingerprint);
    await expect(fingerprintTranscript([...cues])).resolves.toBe(transcriptFingerprint);
    await expect(
      fingerprintTranscript([{ ...cues[0], text: "Changed" }, ...cues.slice(1)]),
    ).resolves.not.toBe(
      transcriptFingerprint,
    );
  });

  it("resumes a matching checkpoint by its committed input offset", async () => {
    const fingerprint = await fingerprintTranscript(cues);
    const cached: CheckpointedAnalysis = {
      subtitles: [subtitle("First")],
      keyPhrases: [{ expression: "first", meaningZh: "第一", usage: "示例" }],
      checkpoint: {
        version: 1,
        transcriptFingerprint: fingerprint,
        nextCueOffset: 2,
        phase: "cues",
        revision: 7,
      },
    };

    const prepared = await prepareAnalysis(cues, cached);

    expect(prepared).toEqual({
      analysis: cached,
      needsSave: false,
      reason: "resume",
    });
  });

  it("resets outputs when the saved checkpoint belongs to another transcript", async () => {
    const cached: CheckpointedAnalysis = {
      subtitles: [subtitle("Stale")],
      keyPhrases: [{ expression: "stale", meaningZh: "过期", usage: "示例" }],
      checkpoint: {
        version: 1,
        transcriptFingerprint: "sha256:another-transcript",
        nextCueOffset: 2,
        phase: "cues",
        revision: 4,
      },
    };

    const prepared = await prepareAnalysis(cues, cached);

    expect(prepared.reason).toBe("fingerprint-mismatch");
    expect(prepared.needsSave).toBe(true);
    expect(prepared.analysis.subtitles).toEqual([]);
    expect(prepared.analysis.keyPhrases).toEqual([]);
    expect(prepared.analysis.checkpoint).toEqual({
      version: 1,
      transcriptFingerprint: expect.stringMatching(/^sha256:/),
      nextCueOffset: 0,
      phase: "cues",
      revision: 0,
    });
  });

  it("migrates legacy outputs once using their bounded subtitle count", async () => {
    const cached: AnalysisResult = {
      subtitles: [subtitle("First"), subtitle("Second")],
      keyPhrases: [{ expression: "legacy", meaningZh: "旧版", usage: "示例" }],
    };

    const prepared = await prepareAnalysis(cues, cached);

    expect(prepared.reason).toBe("legacy-migration");
    expect(prepared.needsSave).toBe(true);
    expect(prepared.analysis.subtitles).toEqual(cached.subtitles);
    expect(prepared.analysis.keyPhrases).toEqual(cached.keyPhrases);
    expect(prepared.analysis.checkpoint).toEqual({
      version: 1,
      transcriptFingerprint: expect.stringMatching(/^sha256:/),
      nextCueOffset: 2,
      phase: "cues",
      revision: 0,
    });
  });

  it.each([
    ["unsupported version", { version: 2 }],
    ["negative offset", { nextCueOffset: -1 }],
    ["fractional offset", { nextCueOffset: 1.5 }],
    ["offset beyond the transcript", { nextCueOffset: 4 }],
    ["unknown phase", { phase: "later" }],
    ["negative revision", { revision: -1 }],
  ])("resets cached outputs for an invalid checkpoint %s", async (_name, override) => {
    const fingerprint = await fingerprintTranscript(cues);
    const cached = {
      subtitles: [subtitle("Stale")],
      keyPhrases: [{ expression: "stale", meaningZh: "过期", usage: "示例" }],
      checkpoint: {
        version: 1,
        transcriptFingerprint: fingerprint,
        nextCueOffset: 1,
        phase: "cues",
        revision: 3,
        ...override,
      },
    } as unknown as CheckpointedAnalysis;

    const prepared = await prepareAnalysis(cues, cached);

    expect(prepared).toMatchObject({
      needsSave: true,
      reason: "fresh",
      analysis: {
        subtitles: [],
        keyPhrases: [],
        checkpoint: {
          version: 1,
          transcriptFingerprint: fingerprint,
          nextCueOffset: 0,
          phase: "cues",
          revision: 0,
        },
      },
    });
  });

  it.each([undefined, null, false, 0, ""])(
    "resets when checkpoint is the present malformed value %j",
    async (checkpoint) => {
      const cached: unknown = {
        subtitles: [subtitle("Stale")],
        keyPhrases: [{ expression: "stale", meaningZh: "过期", usage: "示例" }],
        checkpoint,
      };

      const prepared = await prepareAnalysis(cues, cached);

      expect(prepared).toMatchObject({
        needsSave: true,
        reason: "fresh",
        analysis: {
          subtitles: [],
          keyPhrases: [],
          checkpoint: {
            version: 1,
            transcriptFingerprint,
            nextCueOffset: 0,
            phase: "cues",
            revision: 0,
          },
        },
      });
    },
  );

  it.each([
    ["null subtitles in a legacy payload", { subtitles: null, keyPhrases: [] }],
    ["missing subtitles in a legacy payload", { keyPhrases: [] }],
    [
      "a malformed subtitle with matching checkpoint metadata",
      {
        subtitles: [{ ...subtitle("Stale"), highlightWords: [42] }],
        keyPhrases: [],
        checkpoint: {
          version: 1,
          transcriptFingerprint,
          nextCueOffset: 1,
          phase: "cues",
          revision: 3,
        },
      },
    ],
    [
      "a malformed phrase with matching checkpoint metadata",
      {
        subtitles: [],
        keyPhrases: [{ expression: "stale", meaningZh: 42, usage: "示例" }],
        checkpoint: {
          version: 1,
          transcriptFingerprint,
          nextCueOffset: 1,
          phase: "cues",
          revision: 3,
        },
      },
    ],
  ])("resets malformed persisted analysis with %s", async (_name, cached) => {
    const prepared = await prepareAnalysis(cues, cached as unknown);

    expect(prepared).toMatchObject({
      needsSave: true,
      reason: "fresh",
      analysis: {
        subtitles: [],
        keyPhrases: [],
        checkpoint: {
          version: 1,
          transcriptFingerprint,
          nextCueOffset: 0,
          phase: "cues",
          revision: 0,
        },
      },
    });
  });
});
