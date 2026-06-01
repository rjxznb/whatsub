// src/store/agentPanel.ts
//
// User-adjustable geometry for the AI Agent chat PANEL: overall width/height
// (drag the top-right corner) and the input-row height (drag the divider above
// the input). Persisted to localStorage so it survives reloads. Lives in a
// store (not ChatBar-local state) because two components read it: ChatBar lays
// out the panel + divider, and InputBox sizes its textarea to fill the input
// row in panel mode.

import { create } from "zustand";

const W_KEY = "agentPanelW";
const H_KEY = "agentPanelH";
const INPUT_KEY = "agentPanelInputH";

export const PANEL_MIN_W = 380;
export const PANEL_MAX_W = 900;
export const PANEL_MIN_H = 300;
export const PANEL_MAX_H = 860;
export const INPUT_MIN_H = 48;
export const INPUT_MAX_H = 280;

const DEFAULT_W = 600;
const DEFAULT_H = 480; // ~60vh on a typical window; user can resize
const DEFAULT_INPUT_H = 52; // single-line input row (≈ BAR_H)

export function clampNum(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function load(key: string, def: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    if (Number.isFinite(v) && v >= min && v <= max) return v;
  } catch {
    /* ignore */
  }
  return def;
}

function save(key: string, v: number) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* quota / unavailable — drop silently */
  }
}

interface AgentPanelStore {
  width: number;
  height: number;
  inputHeight: number;
  /** Set panel size (clamped + persisted). */
  setSize: (w: number, h: number) => void;
  /** Set input-row height (clamped + persisted). */
  setInputHeight: (h: number) => void;
}

export const useAgentPanel = create<AgentPanelStore>((set) => ({
  width: load(W_KEY, DEFAULT_W, PANEL_MIN_W, PANEL_MAX_W),
  height: load(H_KEY, DEFAULT_H, PANEL_MIN_H, PANEL_MAX_H),
  inputHeight: load(INPUT_KEY, DEFAULT_INPUT_H, INPUT_MIN_H, INPUT_MAX_H),
  setSize: (w, h) => {
    const width = clampNum(w, PANEL_MIN_W, PANEL_MAX_W);
    const height = clampNum(h, PANEL_MIN_H, PANEL_MAX_H);
    save(W_KEY, width);
    save(H_KEY, height);
    set({ width, height });
  },
  setInputHeight: (h) => {
    const inputHeight = clampNum(h, INPUT_MIN_H, INPUT_MAX_H);
    save(INPUT_KEY, inputHeight);
    set({ inputHeight });
  },
}));
