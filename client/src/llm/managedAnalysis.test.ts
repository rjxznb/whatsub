import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointedAnalysis, Subtitle } from "./types";
const invokeMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: fetchMock }));
import {
  applyManagedPreviewEvent,
  buildManagedJobPayload,
  cancelManagedAnalysis,
  canFinalizeManagedCompletion,
  checkpointManagedPreview,
  isManagedErrorCode,
  isRetryableManagedError,
  managedAnalysisErrorMessage,
  resumeManagedAnalysisJob,
  managedCursorForCheckpoint,
  ManagedRequestError,
  mergeManagedSummary,
  mergeManagedSubtitleBatch,
  requiresExternalQuotaRecovery,
  type ManagedPreviewState,
} from "./managedAnalysis";
import type { PersistedAnalysisSession } from "./analysisSession";

function subtitle(index: number): Subtitle {
  return {
    time: index,
    endTime: index + 0.8,
    text: `cue ${index}`,
    translation: `字幕 ${index}`,
    isKeyPoint: false,
    highlightWords: [],
    keyNotes: {},
    highlightTranslations: {},
  };
}

function analysis(
  nextCueOffset: number,
  subtitleCount = nextCueOffset,
): CheckpointedAnalysis {
  return {
    subtitles: Array.from({ length: subtitleCount }, (_, index) =>
      subtitle(index),
    ),
    keyPhrases: [],
    checkpoint: {
      version: 1,
      transcriptFingerprint: "sha256:test",
      nextCueOffset,
      phase: "cues",
      revision: 1,
    },
  };
}

describe("managed desktop job contract", () => {
  it("does not immediately resume a quota-paused server job", () => {
    expect(requiresExternalQuotaRecovery("paused_quota")).toBe(true);
    expect(requiresExternalQuotaRecovery("running")).toBe(false);
  });

  it("keeps desktop jobs out of server-side Library persistence", () => {
    const payload = buildManagedJobPayload({
      videoId: "video-1",
      transcriptGeneration: "generation-1",
      youtubeId: "abc12345",
      sourceUrl: "https://www.youtube.com/watch?v=abc12345",
      title: "Fixture",
      durationSec: 12,
      cues: [{ index: 0, time: 0, endTime: 1, text: "hello" }],
    });

    expect(payload.persistLibraryEntry).toBe(false);
    expect(payload.idempotencyKey).toBe("desktop:video-1:generation-1");
  });

  it("derives the results cursor only from complete managed input batches", () => {
    expect(managedCursorForCheckpoint(0, 120)).toBe(-1);
    expect(managedCursorForCheckpoint(50, 120)).toBe(0);
    expect(managedCursorForCheckpoint(100, 120)).toBe(1);
    expect(managedCursorForCheckpoint(73, 73)).toBe(1);
    expect(managedCursorForCheckpoint(25, 120)).toBeNull();
  });

  it("advances durable input progress even when a batch returns fewer visible subtitles", () => {
    const merged = mergeManagedSubtitleBatch(
      analysis(50, 43),
      1,
      Array.from({ length: 41 }, (_, index) => subtitle(50 + index)),
      undefined,
      120,
    );

    expect(merged.subtitles).toHaveLength(84);
    expect(merged.checkpoint.nextCueOffset).toBe(100);
    expect(merged.checkpoint.phase).toBe("cues");
  });

  it("finalizes only after every input cue and the summary are durable", () => {
    expect(canFinalizeManagedCompletion(50, 100, true)).toBe(false);
    expect(canFinalizeManagedCompletion(100, 100, false)).toBe(false);
    expect(canFinalizeManagedCompletion(100, 100, true)).toBe(true);
  });

  it("persists an explicitly empty summary without changing cue progress", () => {
    const current = analysis(100, 84);
    const merged = mergeManagedSummary(current, []);

    expect(merged.keyPhrases).toEqual([]);
    expect(merged.checkpoint.nextCueOffset).toBe(100);
    expect(merged.checkpoint.revision).toBe(current.checkpoint.revision + 1);
  });
});

describe("managed request errors", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("session-token");
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies queue errors independently of their diagnostic suffix", () => {
    const error = new ManagedRequestError(429, "queue_limit", "relay_busy");
    expect(isManagedErrorCode(error, "queue_limit")).toBe(true);
    expect(isRetryableManagedError(error)).toBe(true);
    expect(error.message).toContain("relay_busy");
  });

  it("retries timeout and server HTTP responses", () => {
    expect(
      isRetryableManagedError(new ManagedRequestError(408, "timeout")),
    ).toBe(true);
    expect(
      isRetryableManagedError(new ManagedRequestError(503, "upstream")),
    ).toBe(true);
    expect(
      isRetryableManagedError(new ManagedRequestError(400, "invalid")),
    ).toBe(false);
  });

  it("hides raw request URLs in the user-facing network error", () => {
    const error = new Error(
      "error sending request for url (https://whatsub.eversay.cc/api/library/mobile-analysis/jobs/private/results)",
    );

    expect(managedAnalysisErrorMessage(error)).toBe(
      "连接服务器失败，当前进度已经保存，请检查网络后继续解析。",
    );
  });

  it("sends an idempotent server cancellation for the active managed job", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      jobId: "job-1",
      status: "cancelled",
    }), { status: 200 }));

    await cancelManagedAnalysis("job-1");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/jobs\/job-1\/cancel$/),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("waits for a cancelled request fence to settle before resuming", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "response_unrecoverable",
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jobId: "job-1",
        status: "queued",
      }), { status: 200 }));

    await expect(resumeManagedAnalysisJob("job-1", undefined, 0)).resolves.toMatchObject({
      jobId: "job-1",
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("managed SSE preview ordering", () => {
  const committed = analysis(0, 0);
  const indexes = Array.from({ length: 100 }, (_, index) => index);

  it("ignores stale events and rebases accepted cues into the retry attempt", () => {
    let state: ManagedPreviewState | null = null;
    let result = applyManagedPreviewEvent(
      state,
      {
        eventId: 2,
        eventType: "cue",
        batchIndex: 0,
        attempt: 1,
        payload: { index: 2, ...subtitle(2) },
      },
      committed,
      100,
      indexes,
    );
    state = result.state;
    expect(result.preview?.entries.map((entry) => entry.cueOffset)).toEqual([
      2,
    ]);

    result = applyManagedPreviewEvent(
      state,
      {
        eventId: 1,
        eventType: "cue",
        batchIndex: 0,
        attempt: 1,
        payload: { index: 1, ...subtitle(1) },
      },
      committed,
      100,
      indexes,
    );
    expect(result.state).toBe(state);
    expect(result.changed).toBe(false);

    result = applyManagedPreviewEvent(
      state,
      {
        eventId: 3,
        eventType: "cue",
        batchIndex: 0,
        attempt: 2,
        payload: { index: 3, ...subtitle(3) },
      },
      committed,
      100,
      indexes,
    );
    state = result.state;
    expect(result.preview?.entries.map((entry) => entry.cueOffset)).toEqual([
      3,
    ]);

    result = applyManagedPreviewEvent(
      state,
      {
        eventId: 4,
        eventType: "batch_reset",
        batchIndex: 0,
        attempt: 1,
      },
      committed,
      100,
      indexes,
    );
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);

    result = applyManagedPreviewEvent(
      state,
      {
        eventId: 5,
        eventType: "batch_reset",
        batchIndex: 0,
        attempt: 2,
        payload: { abandonedAttempt: 2, nextAttempt: 3 },
      },
      committed,
      100,
      indexes,
    );
    expect(result.changed).toBe(true);
    expect(result.state?.attempt).toBe(3);
    expect(result.preview?.entries.map((entry) => entry.cueOffset)).toEqual([
      3,
    ]);
    state = result.state;

    result = applyManagedPreviewEvent(
      state,
      {
        eventId: 4,
        eventType: "cue",
        batchIndex: 0,
        attempt: 2,
        payload: { index: 4, ...subtitle(4) },
      },
      committed,
      100,
      indexes,
    );
    expect(result.changed).toBe(false);
    expect(result.state).toBe(state);
    expect(result.preview?.entries.map((entry) => entry.cueOffset)).toEqual([
      3,
    ]);
  });

  it("rejects cues outside the active committed batch", () => {
    const result = applyManagedPreviewEvent(
      null,
      {
        eventId: 1,
        eventType: "cue",
        batchIndex: 1,
        attempt: 1,
        payload: { index: 50, ...subtitle(50) },
      },
      committed,
      100,
      indexes,
    );

    expect(result.changed).toBe(false);
    expect(result.state).toBeNull();
  });

  it("records a reset before the first cue so an older attempt cannot reappear", () => {
    const reset = applyManagedPreviewEvent(
      null,
      {
        eventId: 8,
        eventType: "batch_reset",
        batchIndex: 0,
        attempt: 2,
        payload: { abandonedAttempt: 2, nextAttempt: 3 },
      },
      committed,
      100,
      indexes,
    );

    expect(reset.changed).toBe(true);
    expect(reset.state).toMatchObject({
      batchIndex: 0,
      attempt: 3,
      lastEventId: 8,
    });

    const staleCue = applyManagedPreviewEvent(
      reset.state,
      {
        eventId: 9,
        eventType: "cue",
        batchIndex: 0,
        attempt: 1,
        payload: { index: 1, ...subtitle(1) },
      },
      committed,
      100,
      indexes,
    );

    expect(staleCue.changed).toBe(false);
    expect(staleCue.state).toBe(reset.state);
  });

  it("persists each managed cue before publishing it to the UI", async () => {
    const order: string[] = [];
    let inflight: PersistedAnalysisSession["inflight"] = null;
    const session = {
      videoId: "video-1",
      lease: "lease-1",
      transcriptGeneration: "generation-1",
      analysis: committed,
      get inflight() {
        return inflight;
      },
      async save() {
        return committed;
      },
      async saveInflight(next: NonNullable<PersistedAnalysisSession["inflight"]>) {
        order.push("disk");
        inflight = next;
        return next;
      },
      async close() {},
    } satisfies PersistedAnalysisSession;
    const preview = {
      startCueOffset: 0,
      endCueOffset: 50,
      entries: [{ cueOffset: 2, subtitle: subtitle(2) }],
      subtitles: [subtitle(2)],
    };

    await checkpointManagedPreview(
      session,
      "colloquial",
      committed,
      preview,
      (_analysis, published) => {
        order.push("ui");
        expect(published?.entries.map((entry) => entry.cueOffset)).toEqual([2]);
      },
    );

    expect(order).toEqual(["disk", "ui"]);
    expect(session.inflight?.entries.map((entry) => entry.cueOffset)).toEqual([2]);
  });

});
