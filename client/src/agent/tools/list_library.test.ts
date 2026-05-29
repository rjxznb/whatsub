import { describe, it, expect, beforeEach } from "vitest";
import { useLibrary } from "../../store/library";
import { listLibraryTool } from "./list_library";
import type { LibraryEntry } from "../../types/library";

const ctx = { signal: new AbortController().signal };

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    id: overrides.id ?? "vid_x",
    title: overrides.title ?? "Video X",
    source: overrides.source ?? { type: "url", url: "https://yt/x" },
    durationSec: overrides.durationSec ?? 120,
    thumbnailPath: overrides.thumbnailPath ?? "",
    createdAt: overrides.createdAt ?? "2026-05-29T00:00:00Z",
    status: overrides.status ?? "ready",
    lastError: overrides.lastError ?? null,
    syncedAt: overrides.syncedAt,
    syncError: overrides.syncError,
  };
}

function seed(videos: LibraryEntry[]) {
  useLibrary.setState({
    library: { videos, folders: [], topLevelOrder: [] },
    loaded: true,
  });
}

beforeEach(() => {
  seed([]);
});

describe("list_library tool", () => {
  it("riskTier is LOW", () => {
    expect(listLibraryTool.riskTier).toBe("LOW");
  });

  it("availableOn returns true on any page", () => {
    expect(listLibraryTool.availableOn({ pathname: "/x" })).toBe(true);
  });

  it("happy path: returns sorted videos with total + matched counts", async () => {
    seed([
      entry({ id: "v1", title: "Old", createdAt: "2026-01-01T00:00:00Z" }),
      entry({ id: "v2", title: "New", createdAt: "2026-05-01T00:00:00Z" }),
      entry({ id: "v3", title: "Middle", createdAt: "2026-03-01T00:00:00Z" }),
    ]);
    const r = await listLibraryTool.execute({}, ctx);
    expect(r.total).toBe(3);
    expect(r.matched).toBe(3);
    expect(r.videos.map((v) => v.id)).toEqual(["v2", "v3", "v1"]);
  });

  it("status filter keeps only matching entries", async () => {
    seed([
      entry({ id: "v1", status: "ready" }),
      entry({ id: "v2", status: "analyzing" }),
      entry({ id: "v3", status: "ready" }),
    ]);
    const r = await listLibraryTool.execute({ status: "ready" }, ctx);
    expect(r.matched).toBe(2);
    expect(r.videos.every((v) => v.status === "ready")).toBe(true);
    expect(r.total).toBe(3);
  });

  it("syncedOnly drops entries with no syncedAt", async () => {
    seed([
      entry({ id: "v1", syncedAt: 1000 }),
      entry({ id: "v2" }), // no syncedAt
      entry({ id: "v3", syncedAt: 2000 }),
    ]);
    const r = await listLibraryTool.execute({ syncedOnly: true }, ctx);
    expect(r.matched).toBe(2);
    expect(r.videos.map((v) => v.id).sort()).toEqual(["v1", "v3"]);
  });

  it("limit caps the returned slice", async () => {
    seed(
      Array.from({ length: 30 }, (_, i) =>
        entry({
          id: `v${i}`,
          createdAt: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      ),
    );
    const r = await listLibraryTool.execute({ limit: 5 }, ctx);
    expect(r.total).toBe(30);
    expect(r.matched).toBe(30);
    expect(r.videos).toHaveLength(5);
  });
});
