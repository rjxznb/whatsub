import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (s: Settings) => Promise<void>;
}

// Deep-merge a partial settings object over DEFAULT_SETTINGS so that older or
// hand-edited settings.json files missing fields don't leave anything undefined.
function mergeWithDefaults(raw: Partial<Settings> | null | undefined): Settings {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    openaiCompatible: { ...DEFAULT_SETTINGS.openaiCompatible, ...(raw.openaiCompatible ?? {}) },
    claude: { ...DEFAULT_SETTINGS.claude, ...(raw.claude ?? {}) },
    gemini: { ...DEFAULT_SETTINGS.gemini, ...(raw.gemini ?? {}) },
  };
}

export const useSettings = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    const raw = await invoke<Partial<Settings> | null>("get_settings");
    set({ settings: mergeWithDefaults(raw), loaded: true });
  },
  async save(s) {
    await invoke("save_settings", { settings: s });
    set({ settings: s });
  },
}));
