/**
 * Encode a Float32Array of mono PCM samples as a 16-bit PCM WAV (RIFF).
 *
 * The standard 44-byte header layout:
 *   0   "RIFF"          4 bytes
 *   4   chunkSize       4 bytes  (file size - 8)
 *   8   "WAVE"          4 bytes
 *  12   "fmt "          4 bytes
 *  16   subChunk1Size   4 bytes  (16 for PCM)
 *  20   audioFormat     2 bytes  (1 = PCM)
 *  22   numChannels     2 bytes
 *  24   sampleRate      4 bytes
 *  28   byteRate        4 bytes  (sampleRate * numChannels * bitsPerSample/8)
 *  32   blockAlign      2 bytes  (numChannels * bitsPerSample/8)
 *  34   bitsPerSample   2 bytes
 *  36   "data"          4 bytes
 *  40   subChunk2Size   4 bytes  (numSamples * numChannels * bitsPerSample/8)
 *  44   <PCM data>
 */
export function encodeWav16(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8); // 2
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // chunkSize = 36 + dataSize
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);             // subChunk1Size = 16 (PCM)
  view.setUint16(20, 1, true);              // audioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples: clamp float to [-1, 1], scale to int16
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Round toward zero then clamp to int16 range
    const int16 =
      clamped < 0
        ? Math.max(-32768, Math.ceil(clamped * 32768))
        : Math.min(32767, Math.floor(clamped * 32767));
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

/**
 * Convert a Uint8Array to a base64 string.
 *
 * Builds a binary string in chunks to avoid call-stack limits on large
 * audio buffers (direct String.fromCharCode(...bytes) blows the stack for
 * arrays > ~65k elements in some engines).
 */
export function wavToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
