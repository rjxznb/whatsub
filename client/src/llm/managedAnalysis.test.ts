import { describe, expect, it } from "vitest";
import type { CheckpointedAnalysis, Subtitle } from "./types";
import {
  applyManagedPreviewEvent,
  buildManagedJobPayload,
  canFinalizeManagedCompletion,
  isManagedErrorCode,
  isRetryableManagedError,
  managedCursorForCheckpoint,
  ManagedRequestError,
  mergeManagedSummary,
  mergeManagedSubtitleBatch,
  requiresExternalQuotaRecovery,
  type ManagedPreviewState,
} from "./managedAnalysis";

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
});

describe("managed SSE preview ordering", () => {
  const committed = analysis(0, 0);
  const indexes = Array.from({ length: 100 }, (_, index) => index);

  it("ignores stale events and resets only the active batch attempt", () => {
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
      },
      committed,
      100,
      indexes,
    );
    expect(result.changed).toBe(true);
    expect(result.preview).toBeNull();
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
    expect(result.preview).toBeNull();
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
      },
      committed,
      100,
      indexes,
    );

    expect(reset.changed).toBe(true);
    expect(reset.state).toMatchObject({
      batchIndex: 0,
      attempt: 2,
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
});
