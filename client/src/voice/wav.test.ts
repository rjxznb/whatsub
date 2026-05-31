import { describe, it, expect } from "vitest";
import { encodeWav16, wavToBase64 } from "./wav";

// ── helpers ───────────────────────────────────────────────────────────────────

function readString(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

// ── encodeWav16 ───────────────────────────────────────────────────────────────

describe("encodeWav16", () => {
  it("produces the correct RIFF/WAVE/fmt /data header markers", () => {
    const samples = new Float32Array(4);
    const wav = encodeWav16(samples, 16000);
    const view = new DataView(wav.buffer);

    expect(readString(view, 0, 4)).toBe("RIFF");
    expect(readString(view, 8, 4)).toBe("WAVE");
    expect(readString(view, 12, 4)).toBe("fmt ");
    expect(readString(view, 36, 4)).toBe("data");
  });

  it("total byte length = 44 + samples.length * 2", () => {
    const n = 100;
    const wav = encodeWav16(new Float32Array(n), 16000);
    expect(wav.byteLength).toBe(44 + n * 2);
  });

  it("empty samples produce a 44-byte file with zero-length data chunk", () => {
    const wav = encodeWav16(new Float32Array(0), 16000);
    expect(wav.byteLength).toBe(44);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(40, true)).toBe(0); // data chunk size = 0
  });

  it("writes sampleRate at offset 24", () => {
    const wav = encodeWav16(new Float32Array(1), 44100);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(44100);
  });

  it("writes numChannels=1 at offset 22", () => {
    const wav = encodeWav16(new Float32Array(1), 16000);
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(1);
  });

  it("writes bitsPerSample=16 at offset 34", () => {
    const wav = encodeWav16(new Float32Array(1), 16000);
    const view = new DataView(wav.buffer);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it("encodes 1.0 as int16 32767", () => {
    const samples = new Float32Array([1.0]);
    const wav = encodeWav16(samples, 16000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
  });

  it("encodes -1.0 as int16 -32768", () => {
    const samples = new Float32Array([-1.0]);
    const wav = encodeWav16(samples, 16000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(-32768);
  });

  it("encodes 0.0 as int16 0", () => {
    const samples = new Float32Array([0.0]);
    const wav = encodeWav16(samples, 16000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0);
  });

  it("clamps values above 1.0 to 32767", () => {
    const samples = new Float32Array([2.0]);
    const wav = encodeWav16(samples, 16000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(32767);
  });

  it("clamps values below -1.0 to -32768", () => {
    const samples = new Float32Array([-2.0]);
    const wav = encodeWav16(samples, 16000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(-32768);
  });

  it("encodes multiple samples correctly", () => {
    const samples = new Float32Array([0.5, -0.5, 1.0, -1.0, 0.0]);
    const wav = encodeWav16(samples, 16000);
    expect(wav.byteLength).toBe(44 + samples.length * 2);
    const view = new DataView(wav.buffer);
    // 0.5 → floor(0.5 * 32767) = 16383
    expect(view.getInt16(44, true)).toBe(16383);
    // -0.5 → ceil(-0.5 * 32768) = -16384
    expect(view.getInt16(46, true)).toBe(-16384);
  });

  it("writes correct chunkSize (36 + dataSize) at offset 4", () => {
    const n = 10;
    const wav = encodeWav16(new Float32Array(n), 16000);
    const view = new DataView(wav.buffer);
    const dataSize = n * 2;
    expect(view.getUint32(4, true)).toBe(36 + dataSize);
  });

  it("writes audioFormat=1 (PCM) at offset 20", () => {
    const wav = encodeWav16(new Float32Array(1), 16000);
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1);
  });
});

// ── wavToBase64 ───────────────────────────────────────────────────────────────

describe("wavToBase64", () => {
  it("returns a non-empty base64 string for a real WAV", () => {
    const wav = encodeWav16(new Float32Array(100), 16000);
    const b64 = wavToBase64(wav);
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(0);
  });

  it("round-trips: atob(wavToBase64(bytes)) restores original bytes", () => {
    const samples = new Float32Array([0.1, -0.2, 0.5, -0.9, 1.0]);
    const wav = encodeWav16(samples, 16000);
    const b64 = wavToBase64(wav);
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(wav);
  });

  it("handles large buffers (> 8192 samples) without stack overflow", () => {
    // 50 000 samples → 100 000 bytes of PCM + 44-byte header
    const large = new Float32Array(50_000).fill(0.1);
    const wav = encodeWav16(large, 16000);
    expect(() => wavToBase64(wav)).not.toThrow();
    const b64 = wavToBase64(wav);
    expect(b64.length).toBeGreaterThan(0);
  });

  it("empty bytes produce empty base64 string", () => {
    expect(wavToBase64(new Uint8Array(0))).toBe("");
  });
});
