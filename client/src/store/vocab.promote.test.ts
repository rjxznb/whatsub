import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VocabEntry } from "../types/vocab";

// invoke: vocab_add echoes the merged entry back as the list; token present.
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "get_session_token") return "tok";
  if (cmd === "vocab_add") return [args!.entry as VocabEntry];
  return [];
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [string, Record<string, unknown>?])) }));

import { useVocabulary } from "./vocab";

const entry: VocabEntry = {
  id: "save up",
  expression: "save up",
  meaningZh: "攒钱",
  usage: "",
  videoId: "vid123",
  videoTitle: "Budgeting 101",
  addedAt: "2026-01-01T00:00:00Z",
  cueTime: 42,
  cueText: "I need to save up.",
};

beforeEach(() => {
  invokeMock.mockClear();
  useVocabulary.setState({ entries: [{ ...entry }], loaded: true });
});

describe("vocab promoteToCloud", () => {
  it("contributes with a library source + writes cloudContributionId back", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 7 }) });
    vi.stubGlobal("fetch", fetchMock);

    const r = await useVocabulary.getState().promoteToCloud("save up");
    expect(r.ok).toBe(true);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.source.kind).toBe("library");
    expect(body.source.libraryEntryId).toBe("vid123");
    expect(body.source.timestampSec).toBe(42);
    expect(body.contextSentence).toBe("I need to save up.");
    expect(body.meaningZh).toBe("攒钱");

    const saved = useVocabulary.getState().entries.find((e) => e.id === "save up");
    expect(saved?.cloudContributionId).toBe(7);
    expect(saved?.promotedAt).toBeTypeOf("number");
  });

  it("is idempotent when already promoted (no fetch)", async () => {
    useVocabulary.setState({ entries: [{ ...entry, cloudContributionId: 9 }] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await useVocabulary.getState().promoteToCloud("save up");
    expect(r.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with the backend reason on quota_exceeded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ reason: "quota_exceeded" }) }),
    );
    const r = await useVocabulary.getState().promoteToCloud("save up");
    expect(r).toEqual({ ok: false, reason: "quota_exceeded" });
    expect(useVocabulary.getState().entries[0].cloudContributionId).toBeUndefined();
  });
});

describe("vocab unpromote", () => {
  it("deletes the cloud row + clears the local link", async () => {
    useVocabulary.setState({ entries: [{ ...entry, cloudContributionId: 7, promotedAt: 1 }] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await useVocabulary.getState().unpromote("save up");
    expect(fetchMock.mock.calls[0][0]).toContain("/corpus/contribute/7");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    const saved = useVocabulary.getState().entries[0];
    expect(saved.cloudContributionId).toBeUndefined();
    expect(saved.promotedAt).toBeUndefined();
  });
});
