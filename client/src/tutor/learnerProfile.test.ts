import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadLearnerProfile,
  logErrorEvent,
  resolveErrorEvents,
  useLearnerProfile,
} from "./learnerProfile";
import type { LearnerProfile, ErrorEvent } from "./types";

const emptyProfile: LearnerProfile = {
  version: 1,
  createdAt: 0,
  updatedAt: 0,
  estimate: { cefr: null, vocabSize: null, listeningLevel: null, confidence: 0 },
  errorEvents: [],
  masteryIndex: { weakPatterns: [], knownWords: [], weakWords: [] },
  goals: [],
};

const sampleEvent: ErrorEvent = {
  id: "e1",
  ts: 100,
  source: { type: "lesson", videoId: "v1", cueIdx: 3, questionId: null },
  pattern: "past_tense_irregular",
  detail: "said 'I goed', want 'I went'",
  userInput: "I goed",
  correction: "I went",
  resolved: false,
  resolvedAt: null,
};

// Hoisted mock — the test-setup.ts already stubs @tauri-apps/api/core but
// returns undefined; we replace per-test to assert what gets called.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
  // Reset zustand store between tests
  useLearnerProfile.setState({ profile: null, loading: false });
});

describe("learnerProfile API", () => {
  it("loadLearnerProfile invokes learner_profile_load", async () => {
    mockInvoke.mockResolvedValue(emptyProfile);
    const got = await loadLearnerProfile();
    expect(mockInvoke).toHaveBeenCalledWith("learner_profile_load");
    expect(got).toEqual(emptyProfile);
  });

  it("logErrorEvent passes the event as the `event` arg", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await logErrorEvent(sampleEvent);
    expect(mockInvoke).toHaveBeenCalledWith("learner_profile_log_event", {
      event: sampleEvent,
    });
  });

  it("resolveErrorEvents passes ids array", async () => {
    mockInvoke.mockResolvedValue(undefined);
    await resolveErrorEvents(["e1", "e2"]);
    expect(mockInvoke).toHaveBeenCalledWith("learner_profile_resolve_events", {
      ids: ["e1", "e2"],
    });
  });
});

describe("useLearnerProfile store", () => {
  it("hydrate loads profile + flips loading flag", async () => {
    mockInvoke.mockResolvedValue(emptyProfile);
    await useLearnerProfile.getState().hydrate();
    expect(useLearnerProfile.getState().profile).toEqual(emptyProfile);
    expect(useLearnerProfile.getState().loading).toBe(false);
  });

  it("hydrate is single-flight (won't re-fetch while profile is set)", async () => {
    mockInvoke.mockResolvedValue(emptyProfile);
    await useLearnerProfile.getState().hydrate();
    mockInvoke.mockClear();
    await useLearnerProfile.getState().hydrate();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("logEvent calls Rust then re-loads", async () => {
    mockInvoke
      .mockResolvedValueOnce(undefined) // log_event
      .mockResolvedValueOnce({ ...emptyProfile, errorEvents: [sampleEvent] }); // load
    await useLearnerProfile.getState().logEvent(sampleEvent);
    expect(useLearnerProfile.getState().profile?.errorEvents).toHaveLength(1);
  });

  // Fix 6: test resolveEvents and reset store actions.
  it("resolveEvents calls Rust then re-loads updated profile", async () => {
    const resolvedProfile = {
      ...emptyProfile,
      errorEvents: [{ ...sampleEvent, resolved: true, resolvedAt: 999 }],
    };
    mockInvoke
      .mockResolvedValueOnce(undefined) // resolve_events
      .mockResolvedValueOnce(resolvedProfile); // load
    await useLearnerProfile.getState().resolveEvents(["e1"]);
    expect(mockInvoke).toHaveBeenCalledWith("learner_profile_resolve_events", {
      ids: ["e1"],
    });
    expect(useLearnerProfile.getState().profile?.errorEvents[0].resolved).toBe(true);
  });

  it("reset calls Rust then re-loads empty profile", async () => {
    // Seed a non-null profile first so we can confirm it gets replaced.
    useLearnerProfile.setState({
      profile: { ...emptyProfile, errorEvents: [sampleEvent] },
    });
    mockInvoke
      .mockResolvedValueOnce(undefined) // reset
      .mockResolvedValueOnce(emptyProfile); // load
    await useLearnerProfile.getState().reset();
    expect(mockInvoke).toHaveBeenCalledWith("learner_profile_reset");
    expect(useLearnerProfile.getState().profile?.errorEvents).toHaveLength(0);
  });
});
