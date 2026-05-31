// src/tutor/edgeTts.ts
//
// Client for Microsoft Edge's online "Read Aloud" neural TTS (the same free
// Azure Neural voices Edge uses — zh-CN-XiaoxiaoNeural, en-US-AriaNeural, …).
// Far more natural than the local SAPI voices the Web Speech API exposes, and
// needs no locally-installed voice. Reverse-engineered protocol (the public
// edge-tts approach): a WebSocket to the bing endpoint, authed via a
// time-based Sec-MS-GEC token, streaming back MP3 audio frames.
//
// Network-only — callers fall back to local Web Speech (tts.ts) on any error
// so TTS still works offline.

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_BASE =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const GEC_VERSION = "1-130.0.2849.68";
// Seconds between the Windows epoch (1601-01-01) and the Unix epoch.
const WIN_EPOCH = 11644473600;

/** Natural neural voices. */
export const EDGE_VOICE_ZH = "zh-CN-XiaoxiaoNeural"; // 晓晓 — warm female
export const EDGE_VOICE_EN = "en-US-AriaNeural"; // Aria — natural female
/** Multilingual voice that reads mixed Chinese + English naturally in ONE
 *  utterance — used so a single request produces one continuous, gap-free
 *  MP3 (no pause at every zh↔en switch). */
export const EDGE_VOICE_MULTI = "zh-CN-XiaoxiaoMultilingualNeural";

async function sha256Upper(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** The Sec-MS-GEC token the endpoint now requires: SHA256 of (Windows
 *  file-time rounded down to a 5-minute boundary, in 100-ns ticks) +
 *  the trusted client token. BigInt because the tick count overflows
 *  Number.MAX_SAFE_INTEGER. Exported for testing. */
export async function generateSecMsGec(nowMs: number = Date.now()): Promise<string> {
  let ticks = BigInt(Math.floor(nowMs / 1000) + WIN_EPOCH);
  ticks -= ticks % 300n; // round down to nearest 5 minutes
  ticks *= 10_000_000n; // seconds → 100-nanosecond intervals
  return sha256Upper(`${ticks.toString()}${TRUSTED_CLIENT_TOKEN}`);
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build the SSML for one voice + text. `rate` is a multiplier (1 = normal);
 *  converted to the +N% form Edge expects. Exported for testing. */
export function buildSsml(text: string, voice: string, rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  const rateStr = `${pct >= 0 ? "+" : ""}${pct}%`;
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='${rateStr}' volume='+0%'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

/** Extract the audio bytes from one binary frame: 2-byte big-endian header
 *  length, the header text, then the audio payload. Exported for testing. */
export function extractAudioFrame(buf: ArrayBuffer): Uint8Array {
  const data = new Uint8Array(buf);
  const headerLen = (data[0] << 8) | data[1];
  return data.slice(2 + headerLen);
}

export interface EdgeSynthOptions {
  voice: string;
  rate?: number; // multiplier; default 1
  signal?: AbortSignal;
  timeoutMs?: number; // default 12000
}

/** Synthesize `text` to MP3 bytes via the Edge neural TTS WebSocket. Rejects
 *  on any failure (offline, blocked, timeout) so callers can fall back. */
export function edgeSynthesize(
  text: string,
  opts: EdgeSynthOptions,
): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    let settled = false;
    const done = (err: Error | null, result?: ArrayBuffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(result!);
    };

    const timer = setTimeout(
      () => done(new Error("edge-tts timeout")),
      opts.timeoutMs ?? 12000,
    );

    let ws: WebSocket;
    void (async () => {
      try {
        const gec = await generateSecMsGec();
        const url =
          `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
          `&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}`;
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";

        opts.signal?.addEventListener("abort", () =>
          done(new Error("edge-tts aborted")),
        );

        const chunks: Uint8Array[] = [];
        const ts = new Date().toString();
        const reqId =
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID().replace(/-/g, "")
            : Math.random().toString(16).slice(2).padEnd(32, "0");

        ws.onopen = () => {
          ws.send(
            `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\n` +
              `Path:speech.config\r\n\r\n` +
              `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`,
          );
          ws.send(
            `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\n` +
              `X-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
              buildSsml(text, opts.voice, opts.rate ?? 1),
          );
        };

        ws.onmessage = (ev) => {
          if (typeof ev.data === "string") {
            if (ev.data.includes("Path:turn.end")) {
              const total = chunks.reduce((n, c) => n + c.length, 0);
              if (total === 0) {
                done(new Error("edge-tts: no audio"));
                return;
              }
              const out = new Uint8Array(total);
              let o = 0;
              for (const c of chunks) {
                out.set(c, o);
                o += c.length;
              }
              done(null, out.buffer);
            }
          } else {
            chunks.push(extractAudioFrame(ev.data as ArrayBuffer));
          }
        };

        ws.onerror = () => done(new Error("edge-tts ws error"));
        ws.onclose = () => {
          if (!settled) done(new Error("edge-tts closed early"));
        };
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}
