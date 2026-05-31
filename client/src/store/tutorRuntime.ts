import { create } from "zustand";
import type { LessonPlan, LessonState, RoleplayScenario, RoleplayTurn, ObservedError } from "../tutor/types";
import type { ErrorPattern } from "../tutor/errorPatterns";

/** Active overlay UI state. Single-active — Lesson XOR Roleplay XOR
 *  Remediation. Tool calls + Player buttons all push into this store;
 *  the overlay portal in App.tsx reads it and mounts the right view. */
export type TutorMode =
  | { kind: "none" }
  | { kind: "lesson-preclass"; videoId: string; plan: LessonPlan }
  | { kind: "lesson-in-progress"; videoId: string; resumeFrom?: LessonState }
  | { kind: "lesson-end"; videoId: string; state: LessonState }
  | { kind: "roleplay-picker"; scenarios: RoleplayScenario[]; sourceVideoId: string | null; loading: boolean }
  | { kind: "roleplay-in-progress"; scenario: RoleplayScenario }
  | { kind: "roleplay-report"; scenario: RoleplayScenario; turns: RoleplayTurn[]; observations: ObservedError[] }
  | { kind: "remediation"; pattern: ErrorPattern; candidateErrorIds: string[] };

interface Store {
  mode: TutorMode;
  setMode: (mode: TutorMode) => void;
  close: () => void;
}

export const useTutorRuntime = create<Store>((set) => ({
  mode: { kind: "none" },
  setMode: (mode) => set({ mode }),
  close: () => set({ mode: { kind: "none" } }),
}));
