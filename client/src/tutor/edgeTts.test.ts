import { describe, it, expect } from "vitest";
import {
  generateSecMsGec,
  escapeXml,
  buildSsml,
  extractAudioFrame,
} from "./edgeTts";

describe("generateSecMsGec", () => {
  it("returns a 64-char uppercase hex string", async () => {
    const tok = await generateSecMsGec(1_700_000_000_000);
    expect(tok).toMatch(/^[0-9A-F]{64}$/);
  });

  it("is stable within the same 5-minute window", async () => {
    const base = 1_700_000_000_000;
    const a = await generateSecMsGec(base);
    const b = await generateSecMsGec(base + 60_000); // +1 min, same window
    expect(a).toBe(b);
  });

  it("changes across a 5-minute boundary", async () => {
    const base = 1_700_000_100_000; // pick a time then jump well past 5 min
    const a = await generateSecMsGec(base);
    const b = await generateSecMsGec(base + 6 * 60_000);
    expect(a).not.toBe(b);
  });
});

describe("escapeXml", () => {
  it("escapes XML metacharacters", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });
});

describe("buildSsml", () => {
  it("embeds the voice, +N% rate and escaped text", () => {
    const ssml = buildSsml("hi & bye", "en-US-AriaNeural", 1.12);
    expect(ssml).toContain("name='en-US-AriaNeural'");
    expect(ssml).toContain("rate='+12%'");
    expect(ssml).toContain("hi &amp; bye");
  });

  it("formats a slower rate as a negative percent", () => {
    expect(buildSsml("x", "v", 0.9)).toContain("rate='-10%'");
  });
});

describe("extractAudioFrame", () => {
  it("returns the bytes after the 2-byte header length + header", () => {
    // header length = 3, header = 'abc', audio = [0xAA, 0xBB]
    const buf = new Uint8Array([0x00, 0x03, 0x61, 0x62, 0x63, 0xaa, 0xbb]).buffer;
    const audio = extractAudioFrame(buf);
    expect(Array.from(audio)).toEqual([0xaa, 0xbb]);
  });
});
