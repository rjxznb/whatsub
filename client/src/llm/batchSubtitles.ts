import type { SrtCue } from "./types";

export function batchSubtitles(cues: SrtCue[], batchSize: number): SrtCue[][] {
  const batches: SrtCue[][] = [];
  for (let i = 0; i < cues.length; i += batchSize) {
    batches.push(cues.slice(i, i + batchSize));
  }
  return batches;
}
