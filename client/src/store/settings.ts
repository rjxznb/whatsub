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

export const useSettings = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    const raw = await invoke<Settings | null>("get_settings");
    set({ settings: raw ?? DEFAULT_SETTINGS, loaded: true });
  },
  async save(s) {
    await invoke("save_settings", { settings: s });
    set({ settings: s });
  },
}));
