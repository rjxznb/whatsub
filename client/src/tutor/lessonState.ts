import { invoke } from "@tauri-apps/api/core";
import type { LessonState } from "./types";

/** Load the most recent in-progress lesson, or null if no pending. */
export async function loadLessonState(): Promise<LessonState | null> {
  const v = await invoke<LessonState | null>("lesson_state_load");
  return v ?? null;
}

export async function saveLessonState(state: LessonState): Promise<void> {
  await invoke("lesson_state_save", { state });
}

/** Called on lesson completion or explicit "重新开始". */
export async function clearLessonState(): Promise<void> {
  await invoke("lesson_state_clear");
}
