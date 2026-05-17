import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VocabEntry } from "../types/vocab";

// ── Mock @tauri-apps/api/core before importing the store ──────────────────────
// We simulate a minimal in-memory Rust backend: vocab_add does a full replace
// (no merge), which is exactly the current Rust behaviour we're fixing at the
// TS layer.
const db: VocabEntry[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "vocab_list") {
      return [...db];
    }
    if (cmd === "vocab_add") {
      const entry = args?.entry as VocabEntry;
      const idx = db.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        db[idx] = entry; // full replace — simulates current Rust behaviour
      } else {
        db.push(entry);
      }
      return [...db];
    }
    if (cmd === "vocab_remove") {
      const id = args?.id as string;
      const i = db.findIndex((e) => e.id === id);
      if (i >= 0) db.splice(i, 1);
      return [...db];
    }
    return [];
  }),
}));

// Import AFTER mock is registered
const { useVocabulary } = await import("./vocab");

describe("vocab upsert preserves unknown fields", () => {
  beforeEach(() => {
    // Reset in-memory db and store state
    db.length = 0;
    useVocabulary.setState({ entries: [], loaded: false });
  });

  it("preserves source / videoUrl when desktop re-saves a plugin-written entry", async () => {
    // Step 1: Plugin writes an entry that includes source + videoUrl
    const pluginEntry: VocabEntry = {
      id: "save up money",
      expression: "save up money",
      meaningZh: "攒钱",
      usage: "",
      videoId: "abc123",
      videoTitle: "Budget tips",
      addedAt: new Date().toISOString(),
      source: "youtube",
      videoUrl: "https://youtu.be/abc123?t=46",
    };
    await useVocabulary.getState().add(pluginEntry);

    // Step 2: Desktop re-saves — it only knows the "desktop-native" fields
    // (it does NOT forward source / videoUrl because it was built before those
    // fields existed, or it simply constructs from its own form fields).
    const desktopResave: VocabEntry = {
      id: "save up money",
      expression: "save up money",
      meaningZh: "存点钱", // updated
      usage: "",
      videoId: "abc123",
      videoTitle: "Budget tips",
      addedAt: pluginEntry.addedAt,
      // source and videoUrl intentionally absent — desktop doesn't know about them
    };
    await useVocabulary.getState().add(desktopResave);

    const after = useVocabulary
      .getState()
      .entries.find((e) => e.id === "save up money");

    // The shallow-merge fix must preserve plugin-written fields even though
    // the desktop re-save did not include them.
    expect(after?.source).toBe("youtube");
    expect(after?.videoUrl).toBe("https://youtu.be/abc123?t=46");
    expect(after?.meaningZh).toBe("存点钱");
  });
});
