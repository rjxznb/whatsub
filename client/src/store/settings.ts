import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import { inferVendorId } from "../llm/vendors";

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
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    openaiCompatible: { ...DEFAULT_SETTINGS.openaiCompatible, ...(raw.openaiCompatible ?? {}) },
    claude: { ...DEFAULT_SETTINGS.claude, ...(raw.claude ?? {}) },
    gemini: { ...DEFAULT_SETTINGS.gemini, ...(raw.gemini ?? {}) },
  };
  // If raw didn't provide a vendorId, derive it from the protocol/baseUrl so it
  // stays consistent with llmProvider. Otherwise the dropdown (which reads
  // vendorId) and getProvider() (which reads llmProvider) can disagree — e.g.
  // raw.llmProvider="claude" with no vendorId would leave vendorId at the
  // default "deepseek", showing DeepSeek in the UI while routing to Claude.
  if (raw.vendorId === undefined) {
    merged.vendorId = inferVendorId(merged.llmProvider, merged.openaiCompatible.baseUrl);
  }
  return merged;
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
