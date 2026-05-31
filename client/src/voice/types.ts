/** Lifecycle states for the full-screen voice conversation mode. */
export type VoiceState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

/** A single turn in the voice conversation transcript. */
export interface VoiceTurn {
  role: "user" | "assistant";
  text: string;
}
