/**
 * TS wrapper for the `voice_transcribe` Rust command.
 *
 * Reads the configured whisper model from settings and invokes the Rust
 * command with the base64-encoded WAV bytes. The model must already be
 * downloaded; if it isn't, Rust returns AppError::NotFound which surfaces
 * as a rejected promise here.
 */

import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../store/settings";

/**
 * Transcribe a spoken utterance.
 *
 * @param wavBase64 - Base64-encoded 16-bit PCM mono WAV from `wavToBase64`.
 * @returns The trimmed transcript string (may be empty if whisper detected silence).
 */
export async function transcribeVoice(wavBase64: string): Promise<string> {
  const settings = useSettings.getState().settings;
  // `whisperModel` is the TS field for the chosen model size
  // (type WhisperModelSize = "tiny" | "base" | "small" | "medium" | "large-v3").
  // DEFAULT_SETTINGS.whisperModel = "small".
  const model: string = settings.whisperModel ?? "base";
  return invoke<string>("voice_transcribe", {
    wavBase64,
    model,
    lang: "en",
  });
}
