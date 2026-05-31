import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { LearnerProfile, ErrorEvent } from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Raw Tauri command bindings — thin wrappers, no state.
// ─────────────────────────────────────────────────────────────────────────

export async function loadLearnerProfile(): Promise<LearnerProfile> {
  return invoke<LearnerProfile>("learner_profile_load");
}

export async function logErrorEvent(event: ErrorEvent): Promise<void> {
  await invoke("learner_profile_log_event", { event });
}

export async function resolveErrorEvents(ids: string[]): Promise<void> {
  await invoke("learner_profile_resolve_events", { ids });
}

export async function rebuildLearnerIndex(): Promise<LearnerProfile> {
  return invoke<LearnerProfile>("learner_profile_rebuild_index");
}

export async function exportLearnerProfile(): Promise<string> {
  return invoke<string>("learner_profile_export");
}

export async function resetLearnerProfile(): Promise<void> {
  await invoke("learner_profile_reset");
}

// ─────────────────────────────────────────────────────────────────────────
// zustand store — hydrated once at app boot, refreshed after writes.
// Components subscribe via useLearnerProfile().
// ─────────────────────────────────────────────────────────────────────────

interface LearnerProfileStore {
  profile: LearnerProfile | null;
  loading: boolean;
  hydrate: () => Promise<void>;
  /** Append an event + optimistically update the local store. The Rust
   *  side persists, then we re-load so derived indices stay in sync. */
  logEvent: (event: ErrorEvent) => Promise<void>;
  resolveEvents: (ids: string[]) => Promise<void>;
  reset: () => Promise<void>;
}

export const useLearnerProfile = create<LearnerProfileStore>((set, get) => ({
  profile: null,
  loading: false,
  async hydrate() {
    if (get().profile || get().loading) return;
    set({ loading: true });
    try {
      const profile = await loadLearnerProfile();
      set({ profile, loading: false });
    } catch (e) {
      console.warn("[learner-profile] hydrate failed", e);
      set({ loading: false });
    }
  },
  async logEvent(event) {
    await logErrorEvent(event);
    const profile = await loadLearnerProfile();
    set({ profile });
  },
  async resolveEvents(ids) {
    await resolveErrorEvents(ids);
    const profile = await loadLearnerProfile();
    set({ profile });
  },
  async reset() {
    await resetLearnerProfile();
    const profile = await loadLearnerProfile();
    set({ profile });
  },
}));
