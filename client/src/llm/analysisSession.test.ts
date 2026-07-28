import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  executeAnalysisSession,
  openAnalysisSession,
  StaleAnalysisSessionError,
} from "./analysisSession";
import { fingerprintTranscript } from "./analysisCheckpoint";
import type { Provider } from "./providers/types";
import type { CheckpointedAnalysis, SrtCue, Subtitle } from "./types";

const mockInvoke = vi.mocked(invoke);

const cues: SrtCue[] = [
  { index: 1, time: 0, endTime: 1, text: "First" },
  { index: 2, time: 1, endTime: 2, text: "Second" },
];

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

async function checkpointed(
  revision = 0,
  nextCueOffset = 0,
  phase: "cues" | "summary" | "complete" = "cues",
): Promise<CheckpointedAnalysis> {
  return {
    subtitles: nextCueOffset > 0 ? [subtitle("First")] : [],
    keyPhrases: [],
    checkpoint: {
      version: 1,
      transcriptFingerprint: await fingerprintTranscript(cues),
      nextCueOffset,
      phase,
      revision,
    },
  };
}

describe("immutable analysis sessions", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("uses the lease captured at begin for every save and never rebinds after rejection", async () => {
    const initial = await checkpointed();
    let saves = 0;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-old", analysis: initial };
      }
      if (command === "save_analysis_session") {
        saves += 1;
        return saves === 1
          ? { status: "applied", revision: 1 }
          : { status: "rejected", revision: 1 };
      }
      if (command === "end_analysis_session") return undefined;
      throw new Error(`unexpected command: ${command}`);
    });

    const session = await openAnalysisSession("v1", cues);
    const next = { ...initial, checkpoint: { ...initial.checkpoint, revision: 1 } };
    await session.save(next);

    expect(mockInvoke).toHaveBeenCalledWith("save_analysis_session", {
      videoId: "v1",
      lease: "lease-old",
      analysis: next,
    });

    const rejected = { ...next, checkpoint: { ...next.checkpoint, revision: 2 } };
    await expect(session.save(rejected)).rejects.toBeInstanceOf(StaleAnalysisSessionError);
    expect(mockInvoke.mock.calls.filter(([command]) => command === "begin_analysis_session"))
      .toHaveLength(1);
  });

  it("persists a legacy snapshot as checkpoint revision zero before returning", async () => {
    const legacy = { subtitles: [subtitle("First")], keyPhrases: [] };
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-migrate", analysis: legacy };
      }
      if (command === "save_analysis_session") {
        return { status: "applied", revision: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const session = await openAnalysisSession("legacy", cues);

    expect(session.analysis.checkpoint.revision).toBe(0);
    expect(session.analysis.checkpoint.nextCueOffset).toBe(1);
    expect(mockInvoke).toHaveBeenLastCalledWith("save_analysis_session", {
      videoId: "legacy",
      lease: "lease-migrate",
      analysis: session.analysis,
    });
  });

  it("closes a mismatched continuation lease and explicitly begins a reset session", async () => {
    const mismatched = await checkpointed(4, 1);
    mismatched.checkpoint.transcriptFingerprint = "sha256:different";
    let begins = 0;
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "begin_analysis_session") {
        begins += 1;
        if (begins === 1) {
          expect(args).toEqual({ videoId: "changed", reset: false });
          return { lease: "lease-old", analysis: mismatched };
        }
        expect(args).toEqual({ videoId: "changed", reset: true });
        return { lease: "lease-reset", analysis: null };
      }
      if (command === "end_analysis_session") return undefined;
      if (command === "save_analysis_session") {
        expect(args).toMatchObject({ videoId: "changed", lease: "lease-reset" });
        return { status: "applied", revision: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const session = await openAnalysisSession("changed", cues);

    expect(session.lease).toBe("lease-reset");
    expect(mockInvoke.mock.calls).toEqual([
      ["begin_analysis_session", { videoId: "changed", reset: false }],
      ["end_analysis_session", { videoId: "changed", lease: "lease-old" }],
      ["begin_analysis_session", { videoId: "changed", reset: true }],
      [
        "save_analysis_session",
        expect.objectContaining({ videoId: "changed", lease: "lease-reset" }),
      ],
    ]);
  });

  it("publishes a batch only after its checkpoint save succeeds", async () => {
    let saves = 0;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-run", analysis: null };
      }
      if (command === "save_analysis_session") {
        saves += 1;
        return saves === 1
          ? { status: "applied", revision: 0 }
          : { status: "rejected", revision: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const provider: Provider = {
      async *stream() {
        yield `${JSON.stringify({ type: "cue", translation: "第一句" })}\n`;
      },
    };
    const onCommitted = vi.fn();
    const session = await openAnalysisSession("failed-save", cues.slice(0, 1));
    const before = session.analysis;

    await expect(
      executeAnalysisSession({
        session,
        provider,
        cues: cues.slice(0, 1),
        style: "colloquial",
        onCommitted,
      }),
    ).rejects.toBeInstanceOf(StaleAnalysisSessionError);

    expect(onCommitted).not.toHaveBeenCalled();
    expect(session.analysis).toBe(before);
  });

  it("resumes from the committed input offset rather than the output subtitle count", async () => {
    const longCues: SrtCue[] = Array.from({ length: 51 }, (_, index) => ({
      index: index + 1,
      time: index,
      endTime: index + 1,
      text: `Cue input ${index + 1}`,
    }));
    const fingerprint = await fingerprintTranscript(longCues);
    const initial: CheckpointedAnalysis = {
      subtitles: Array.from({ length: 47 }, (_, index) => subtitle(`Output ${index + 1}`)),
      keyPhrases: [],
      checkpoint: {
        version: 1,
        transcriptFingerprint: fingerprint,
        nextCueOffset: 50,
        phase: "cues",
        revision: 8,
      },
    };
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-resume", analysis: initial };
      }
      if (command === "save_analysis_session") {
        return { status: "applied", revision: null };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const prompts: string[] = [];
    const provider: Provider = {
      async *stream(request) {
        prompts.push(request.userPrompt);
        if (prompts.length === 1) {
          yield `${JSON.stringify({ type: "cue", index: 51, translation: "第五十一句" })}\n`;
        } else {
          yield `${JSON.stringify({ type: "summary", keyPhrases: [] })}\n`;
        }
      },
    };

    const session = await openAnalysisSession("exact-resume", longCues);
    await executeAnalysisSession({
      session,
      provider,
      cues: longCues,
      style: "colloquial",
    });

    expect(prompts[0]).toContain("Cue input 51");
    expect(prompts[0]).not.toContain("Cue input 48");
    expect(
      mockInvoke.mock.calls.some(
        ([command]) => command === "retranscribe_video" || command === "delete_analysis",
      ),
    ).toBe(false);
  });

  it("continues a summary checkpoint without submitting transcript batches again", async () => {
    const initial = await checkpointed(3, cues.length, "summary");
    initial.subtitles = [subtitle("First"), subtitle("Second")];
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-summary", analysis: initial };
      }
      if (command === "save_analysis_session") {
        return { status: "applied", revision: 4 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const prompts: string[] = [];
    const provider: Provider = {
      async *stream(request) {
        prompts.push(request.userPrompt);
        yield `${JSON.stringify({ type: "summary", keyPhrases: [] })}\n`;
      },
    };

    const session = await openAnalysisSession("summary-only", cues);
    await executeAnalysisSession({ session, provider, cues, style: "colloquial" });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Now produce ONE single JSON line");
  });

  it("closes a lease idempotently", async () => {
    const initial = await checkpointed();
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-close", analysis: initial };
      }
      if (command === "end_analysis_session") return undefined;
      throw new Error(`unexpected command: ${command}`);
    });
    const session = await openAnalysisSession("close", cues);

    await Promise.all([session.close(), session.close()]);

    expect(mockInvoke.mock.calls.filter(([command]) => command === "end_analysis_session"))
      .toHaveLength(1);
  });

  it("releases a fresh lease when its required revision-zero save fails", async () => {
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-failed-open", analysis: null };
      }
      if (command === "save_analysis_session") {
        return { status: "rejected", revision: null };
      }
      if (command === "end_analysis_session") return undefined;
      throw new Error(`unexpected command: ${command}`);
    });

    await expect(openAnalysisSession("failed-open", cues)).rejects.toBeInstanceOf(
      StaleAnalysisSessionError,
    );
    expect(mockInvoke).toHaveBeenLastCalledWith("end_analysis_session", {
      videoId: "failed-open",
      lease: "lease-failed-open",
    });
  });

  it("serializes same-video opens until the current local producer closes", async () => {
    const initial = await checkpointed();
    let active = false;
    let beginCount = 0;
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        beginCount += 1;
        if (active) throw new Error("backend session already active");
        active = true;
        return { lease: `lease-${beginCount}`, analysis: initial };
      }
      if (command === "end_analysis_session") {
        active = false;
        return undefined;
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const first = await openAnalysisSession("strict-mode", cues);
    let secondResolved = false;
    const secondPromise = openAnalysisSession("strict-mode", cues).then((session) => {
      secondResolved = true;
      return session;
    });
    await Promise.resolve();

    expect(beginCount).toBe(1);
    expect(secondResolved).toBe(false);

    await first.close();
    const second = await secondPromise;
    expect(beginCount).toBe(2);
    await second.close();
  });
});
