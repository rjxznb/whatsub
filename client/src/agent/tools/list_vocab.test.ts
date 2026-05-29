import { describe, it, expect, beforeEach } from "vitest";
import { useVocabulary } from "../../store/vocab";
import { listVocabTool } from "./list_vocab";
import type { VocabEntry } from "../../types/vocab";

const ctx = { signal: new AbortController().signal };

function v(overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: overrides.id ?? "x",
    expression: overrides.expression ?? "x",
    meaningZh: overrides.meaningZh ?? "X 的意思",
    usage: overrides.usage ?? "X 的用法",
    videoId: overrides.videoId ?? "vid_1",
    videoTitle: overrides.videoTitle ?? "Some Video",
    addedAt: overrides.addedAt ?? "2026-05-29T00:00:00Z",
    cueTime: overrides.cueTime,
    ...overrides,
  };
}

function seed(entries: VocabEntry[]) {
  useVocabulary.setState({ entries, loaded: true });
}

beforeEach(() => {
  seed([]);
});

describe("list_vocab tool", () => {
  it("riskTier is LOW", () => {
    expect(listVocabTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true on any page", () => {
    expect(listVocabTool.availableOn({ pathname: "/x" })).toBe(true);
  });

  it("returns sorted-newest-first entries with total + matched counts", async () => {
    seed([
      v({ id: "a", expression: "alpha", addedAt: "2026-01-01T00:00:00Z" }),
      v({ id: "b", expression: "beta", addedAt: "2026-05-01T00:00:00Z" }),
      v({ id: "c", expression: "gamma", addedAt: "2026-03-01T00:00:00Z" }),
    ]);
    const r = await listVocabTool.execute({}, ctx);
    expect(r.total).toBe(3);
    expect(r.matched).toBe(3);
    expect(r.entries.map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("videoId filter narrows to a single source", async () => {
    seed([
      v({ id: "a", videoId: "vid_1" }),
      v({ id: "b", videoId: "vid_2" }),
      v({ id: "c", videoId: "vid_1" }),
    ]);
    const r = await listVocabTool.execute({ videoId: "vid_1" }, ctx);
    expect(r.matched).toBe(2);
    expect(r.entries.every((e) => e.videoId === "vid_1")).toBe(true);
    expect(r.total).toBe(3);
  });

  it("limit caps slice size", async () => {
    seed(
      Array.from({ length: 25 }, (_, i) =>
        v({
          id: `v${i}`,
          expression: `phrase ${i}`,
          addedAt: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      ),
    );
    const r = await listVocabTool.execute({ limit: 5 }, ctx);
    expect(r.total).toBe(25);
    expect(r.entries).toHaveLength(5);
  });

  it("maps cueTime → time and surfaces meaningZh", async () => {
    seed([
      v({ id: "a", expression: "alpha", cueTime: 12.5, meaningZh: "意思 A" }),
    ]);
    const r = await listVocabTool.execute({}, ctx);
    expect(r.entries[0]).toMatchObject({
      id: "a",
      expression: "alpha",
      meaningZh: "意思 A",
      time: 12.5,
    });
  });
});
