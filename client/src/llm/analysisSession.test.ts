import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  executeAnalysisSession,
  openAnalysisSession,
  openStoredAnalysisSession,
  StaleAnalysisSessionError,
} from "./analysisSession";
import { fingerprintTranscript } from "./analysisCheckpoint";
import type { AnalysisInflightJournal } from "./analysisJournal";
import type { Provider } from "./providers/types";
import type { CheckpointedAnalysis, SrtCue, Subtitle } from "./types";

const mockInvoke = vi.mocked(invoke);

const cues: SrtCue[] = [
  { index: 1, time: 0, endTime: 1, text: "First" },
  { index: 2, time: 1, endTime: 2, text: "Second" },
];

const transcript = [
  "1",
  "00:00:00,000 --> 00:00:01,000",
  "First",
  "",
  "2",
  "00:00:01,000 --> 00:00:02,000",
  "Second",
].join("\n");

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

async function journal(
  overrides: Partial<AnalysisInflightJournal> = {},
): Promise<AnalysisInflightJournal> {
  return {
    version: 1,
    journalId: "journal-1",
    transcriptGeneration: "sha256:file-old",
    transcriptFingerprint: await fingerprintTranscript(cues),
    analysisStyle: "neutral",
    baseRevision: 0,
    startCueOffset: 0,
    endCueOffset: 2,
    entries: [{ cueOffset: 0, subtitle: subtitle("First") }],
    ...overrides,
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
    const transcriptGeneration = await fingerprintTranscript(cues);
    let begins = 0;
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "begin_analysis_session") {
        begins += 1;
        if (begins === 1) {
          expect(args).toEqual({
            videoId: "changed",
            reset: false,
            transcriptGeneration,
            analysisStyle: "colloquial",
          });
          return { lease: "lease-old", analysis: mismatched };
        }
        expect(args).toEqual({
          videoId: "changed",
          reset: true,
          transcriptGeneration,
          analysisStyle: "colloquial",
        });
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
      [
        "begin_analysis_session",
        {
          videoId: "changed",
          reset: false,
          transcriptGeneration,
          analysisStyle: "colloquial",
        },
      ],
      ["end_analysis_session", { videoId: "changed", lease: "lease-old" }],
      [
        "begin_analysis_session",
        {
          videoId: "changed",
          reset: true,
          transcriptGeneration,
          analysisStyle: "colloquial",
        },
      ],
      [
        "save_analysis_session",
        expect.objectContaining({ videoId: "changed", lease: "lease-reset" }),
      ],
    ]);
  });

  it("reopens a mismatched stored transcript only against the same generation", async () => {
    const mismatched = await checkpointed(4, 1);
    mismatched.checkpoint.transcriptFingerprint = "sha256:different";
    let begins = 0;
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === "begin_analysis_session_from_transcript") {
        begins += 1;
        if (begins === 1) {
          expect(args).toEqual({
            videoId: "stored",
            reset: false,
            expectedGeneration: null,
            analysisStyle: "colloquial",
          });
          return {
            transcript,
            transcriptGeneration: "sha256:file-old",
            session: { lease: "lease-old", analysis: mismatched },
          };
        }
        expect(args).toEqual({
          videoId: "stored",
          reset: true,
          expectedGeneration: "sha256:file-old",
          analysisStyle: "colloquial",
        });
        return {
          transcript,
          transcriptGeneration: "sha256:file-old",
          session: { lease: "lease-reset", analysis: null },
        };
      }
      if (command === "end_analysis_session") return undefined;
      if (command === "save_analysis_session") {
        expect(args).toMatchObject({ videoId: "stored", lease: "lease-reset" });
        return { status: "applied", revision: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const stored = await openStoredAnalysisSession("stored", { style: "colloquial" });

    expect(stored?.cues).toEqual(cues);
    expect(stored?.session.lease).toBe("lease-reset");
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
        yield `${JSON.stringify({ index: 1, translation: "第一句", highlights: [] })}\n`;
      },
    };
    const onCommitted = vi.fn();
    const onPreview = vi.fn();
    const session = await openAnalysisSession("failed-save", cues.slice(0, 1));
    const before = session.analysis;

    await expect(
      executeAnalysisSession({
        session,
        provider,
        cues: cues.slice(0, 1),
        style: "colloquial",
        onCommitted,
        onPreview,
      }),
    ).rejects.toBeInstanceOf(StaleAnalysisSessionError);

    expect(onCommitted).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenLastCalledWith(before, null);
    expect(session.analysis).toBe(before);
  });

  it("forwards previews before save and replaces them only after save succeeds", async () => {
    const initial = await checkpointed();
    initial.checkpoint.transcriptFingerprint = await fingerprintTranscript(cues.slice(0, 1));
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => { releaseStream = resolve; });
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    let previewSeen!: () => void;
    const previewPromise = new Promise<void>((resolve) => { previewSeen = resolve; });
    let saveStarted!: () => void;
    const saveStartedPromise = new Promise<void>((resolve) => { saveStarted = resolve; });

    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-preview", analysis: initial };
      }
      if (command === "save_analysis_session") {
        saveStarted();
        await saveGate;
        return { status: "applied", revision: 1 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const provider: Provider = {
      async *stream() {
        yield `${JSON.stringify({ index: 1, translation: "第一句", highlights: [] })}\n`;
        await streamGate;
      },
    };
    const controller = new AbortController();
    const onPreview = vi.fn(() => previewSeen());
    const onCommitted = vi.fn(() => controller.abort());
    const session = await openAnalysisSession("preview-save", cues.slice(0, 1));
    const durableBefore = session.analysis;

    const run = executeAnalysisSession({
      session,
      provider,
      cues: cues.slice(0, 1),
      style: "colloquial",
      signal: controller.signal,
      onPreview,
      onCommitted,
    });

    await previewPromise;
    expect(onPreview).toHaveBeenLastCalledWith(
      durableBefore,
      expect.objectContaining({
        subtitles: [expect.objectContaining({ text: "First", translation: "第一句" })],
      }),
    );
    expect(onCommitted).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls.filter(([command]) => command === "save_analysis_session"))
      .toHaveLength(0);

    releaseStream();
    await saveStartedPromise;
    expect(onCommitted).not.toHaveBeenCalled();
    expect(session.analysis).toBe(durableBefore);

    releaseSave();
    await run;
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        checkpoint: expect.objectContaining({ nextCueOffset: 1, phase: "summary" }),
      }),
      null,
    );
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

  it("adopts a matching journal and saves monotonic updates with the lease", async () => {
    const initial = await checkpointed();
    const startedJournal = await journal();
    const nextJournal = await journal({
      entries: [
        ...startedJournal.entries,
        { cueOffset: 1, subtitle: { ...subtitle("Second"), time: 1, endTime: 2 } },
      ],
    });
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session_from_transcript") {
        return {
          transcript,
          transcriptGeneration: "sha256:file-old",
          session: { lease: "lease-1", analysis: initial, inflight: startedJournal },
        };
      }
      if (command === "save_analysis_inflight") {
        return { status: "applied", revision: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const stored = await openStoredAnalysisSession("journal-adopt", { style: "neutral" });
    expect(stored?.session.inflight?.entries).toHaveLength(1);

    await stored!.session.saveInflight(nextJournal);
    expect(stored?.session.inflight?.entries).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith("save_analysis_inflight", {
      videoId: "journal-adopt",
      lease: "lease-1",
      journal: nextJournal,
    });
  });

  it("discards a semantically mismatched journal before exposing the session", async () => {
    const initial = await checkpointed();
    const staleJournal = await journal({ journalId: "stale-journal", analysisStyle: "formal" });
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session_from_transcript") {
        return {
          transcript,
          transcriptGeneration: "sha256:file-old",
          session: { lease: "lease-1", analysis: initial, inflight: staleJournal },
        };
      }
      if (command === "discard_analysis_inflight") {
        return { status: "applied", revision: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const stored = await openStoredAnalysisSession("journal-stale", { style: "neutral" });

    expect(stored?.session.inflight).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("discard_analysis_inflight", {
      videoId: "journal-stale",
      lease: "lease-1",
      journalId: "stale-journal",
    });
  });

  it("serializes canonical and inflight saves and close waits for the shared tail", async () => {
    const initial = await checkpointed();
    const generation = await fingerprintTranscript(cues);
    const pendingJournal = await journal({ transcriptGeneration: generation });
    let releaseInflight!: () => void;
    const inflightGate = new Promise<void>((resolve) => { releaseInflight = resolve; });
    let inflightStarted!: () => void;
    const inflightStartedPromise = new Promise<void>((resolve) => { inflightStarted = resolve; });

    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-tail", analysis: initial, inflight: null };
      }
      if (command === "save_analysis_inflight") {
        inflightStarted();
        await inflightGate;
        return { status: "applied", revision: 0 };
      }
      if (command === "save_analysis_session") {
        return { status: "applied", revision: 1 };
      }
      if (command === "end_analysis_session") return undefined;
      throw new Error(`unexpected command: ${command}`);
    });

    const session = await openAnalysisSession("tail", cues, "neutral");
    const inflightSave = session.saveInflight(pendingJournal);
    await inflightStartedPromise;
    const canonicalSave = session.save({
      ...initial,
      checkpoint: { ...initial.checkpoint, revision: 1 },
    });
    const close = session.close();
    await Promise.resolve();

    expect(mockInvoke.mock.calls.some(([command]) => command === "save_analysis_session"))
      .toBe(false);
    expect(mockInvoke.mock.calls.some(([command]) => command === "end_analysis_session"))
      .toBe(false);

    releaseInflight();
    await Promise.all([inflightSave, canonicalSave, close]);
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      "begin_analysis_session",
      "save_analysis_inflight",
      "save_analysis_session",
      "end_analysis_session",
    ]);
  });

  it("marks a session stale when an inflight save is rejected", async () => {
    const initial = await checkpointed();
    const generation = await fingerprintTranscript(cues);
    mockInvoke.mockImplementation(async (command) => {
      if (command === "begin_analysis_session") {
        return { lease: "lease-stale", analysis: initial, inflight: null };
      }
      if (command === "save_analysis_inflight") {
        return { status: "rejected", revision: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const session = await openAnalysisSession("stale-inflight", cues, "neutral");
    await expect(
      session.saveInflight(await journal({ transcriptGeneration: generation })),
    ).rejects.toBeInstanceOf(StaleAnalysisSessionError);
  });
});
