// src-tauri/src/commands/edge_tts.rs
//
// Microsoft Edge "Read Aloud" neural TTS over a WebSocket — run in Rust, NOT
// the WebView. The synthesize endpoint requires a specific Edge Origin +
// User-Agent on the WebSocket upgrade; a WebView WebSocket can't set those
// headers, so Microsoft accepts the upgrade then immediately closes the socket
// (the "edge-tts closed early" the UI used to report). Rust (native-tls +
// tungstenite) sets them, so synthesis works even from inside the WebView and
// from behind networks that block the browser's WS handshake. Returns the MP3
// as base64 for the UI to play.
//
// Protocol (public edge-tts): connect wss authed by a time-based Sec-MS-GEC
// token, send a speech.config frame + an ssml frame, then read back binary
// audio frames (2-byte big-endian header length + header text + MP3 payload)
// until a text frame with Path:turn.end.

use base64::Engine as _;
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_BASE: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
// Must track edge-tts's current CHROMIUM_FULL_VERSION / MAJOR — the endpoint
// returns 403 Forbidden on the WS upgrade if the Sec-MS-GEC-Version is stale
// OR if the User-Agent's major version doesn't match it. Bump BOTH together
// when synthesis starts 403-ing (read the `edge-tts` package's constants.py for
// the current value). Keeping them as separate consts here is intentional so a
// future bump can't silently update one and not the other.
const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
const CHROMIUM_MAJOR: &str = "143";
/// Seconds between the Windows file-time epoch (1601-01-01) and the Unix epoch.
const WIN_EPOCH_SECS: u64 = 11_644_473_600;
/// The Edge Read-Aloud extension Origin. The synthesize endpoint closes the
/// connection without it — the whole reason this runs in Rust rather than a
/// WebView WebSocket (which can't set Origin).
const EDGE_ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The Sec-MS-GEC token the endpoint requires: SHA256 of (Windows file-time
/// rounded down to a 5-minute boundary, in 100-ns ticks) + the trusted client
/// token, uppercase hex. `now_unix_secs` is seconds since the Unix epoch.
fn generate_sec_ms_gec(now_unix_secs: u64) -> String {
    let mut ticks = now_unix_secs + WIN_EPOCH_SECS;
    ticks -= ticks % 300; // round down to nearest 5 minutes
    let ticks_100ns = (ticks as u128) * 10_000_000u128; // seconds → 100-ns intervals
    let mut hasher = Sha256::new();
    hasher.update(format!("{ticks_100ns}{TRUSTED_CLIENT_TOKEN}").as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect()
}

/// Build the SSML for one voice + text. `rate_pct` is the +N% speed delta Edge
/// expects (0 = normal speed).
fn build_ssml(text: &str, voice: &str, rate_pct: i32) -> String {
    let sign = if rate_pct >= 0 { "+" } else { "" };
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
<voice name='{voice}'>\
<prosody pitch='+0Hz' rate='{sign}{rate_pct}%' volume='+0%'>{}</prosody>\
</voice></speak>",
        escape_xml(text)
    )
}

/// Pull the MP3 payload out of one binary frame: 2-byte big-endian header
/// length, the header text, then the audio bytes.
fn extract_audio_frame(buf: &[u8]) -> &[u8] {
    if buf.len() < 2 {
        return &[];
    }
    let header_len = ((buf[0] as usize) << 8) | (buf[1] as usize);
    let start = 2 + header_len;
    if start <= buf.len() {
        &buf[start..]
    } else {
        &[]
    }
}

/// A unique-ish 32-hex X-RequestId (edge-tts only needs uniqueness per request,
/// not a real UUID), derived from the current nanosecond clock.
fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher
        .finalize()
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Synthesize `text` with the given Edge neural `voice` at `rate_pct` (+N%
/// speed), returning the MP3 as base64. Errors carry a short reason the TS side
/// surfaces as the local-fallback explanation.
#[tauri::command]
pub async fn edge_tts_synthesize(
    text: String,
    voice: String,
    rate_pct: i32,
) -> Result<String, String> {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let gec = generate_sec_ms_gec(now_secs);
    let url = format!(
        "{WSS_BASE}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}\
&ConnectionId={conn}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version=1-{CHROMIUM_FULL_VERSION}",
        conn = request_id()
    );

    // The UA's major version MUST match the Sec-MS-GEC-Version above, or the
    // endpoint 403s. Build it from CHROMIUM_MAJOR so they stay coupled.
    let ua = format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/{CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/{CHROMIUM_MAJOR}.0.0.0"
    );

    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("bad request: {e}"))?;
    {
        let h = request.headers_mut();
        h.insert("Origin", HeaderValue::from_static(EDGE_ORIGIN));
        h.insert(
            "User-Agent",
            HeaderValue::from_str(&ua).map_err(|e| e.to_string())?,
        );
        h.insert("Pragma", HeaderValue::from_static("no-cache"));
        h.insert("Cache-Control", HeaderValue::from_static("no-cache"));
        h.insert(
            "Accept-Encoding",
            HeaderValue::from_static("gzip, deflate, br, zstd"),
        );
        h.insert("Accept-Language", HeaderValue::from_static("en-US,en;q=0.9"));
    }

    let (mut ws, _resp) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "connect timeout".to_string())?
    .map_err(|e| format!("connect: {e}"))?;

    let ts = Utc::now()
        .format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
        .to_string();
    let config = format!(
        "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\n\
Path:speech.config\r\n\r\n\
{{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":\
{{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\
\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}"
    );
    let ssml_msg = format!(
        "X-RequestId:{rid}\r\nContent-Type:application/ssml+xml\r\n\
X-Timestamp:{ts}Z\r\nPath:ssml\r\n\r\n{ssml}",
        rid = request_id(),
        ssml = build_ssml(&text, &voice, rate_pct)
    );

    ws.send(Message::Text(config))
        .await
        .map_err(|e| format!("send config: {e}"))?;
    ws.send(Message::Text(ssml_msg))
        .await
        .map_err(|e| format!("send ssml: {e}"))?;

    let mut audio: Vec<u8> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("edge-tts timeout".into());
        }
        let next = tokio::time::timeout(remaining, ws.next())
            .await
            .map_err(|_| "edge-tts timeout".to_string())?;
        let msg = match next {
            Some(Ok(m)) => m,
            Some(Err(e)) => return Err(format!("ws error: {e}")),
            None => break, // stream closed
        };
        match msg {
            Message::Text(t) => {
                if t.contains("Path:turn.end") {
                    break;
                }
            }
            Message::Binary(b) => audio.extend_from_slice(extract_audio_frame(&b)),
            Message::Close(_) => break,
            _ => {}
        }
    }

    let _ = ws.close(None).await;

    if audio.is_empty() {
        return Err("edge-tts: no audio".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&audio))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gec_is_64_char_uppercase_hex() {
        let tok = generate_sec_ms_gec(1_700_000_000);
        assert_eq!(tok.len(), 64);
        assert!(tok.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase()));
    }

    #[test]
    fn gec_is_stable_within_a_5_minute_window() {
        // 1_700_000_100 and +60s land in the same 300s bucket.
        let a = generate_sec_ms_gec(1_700_000_100);
        let b = generate_sec_ms_gec(1_700_000_160);
        assert_eq!(a, b);
    }

    #[test]
    fn gec_changes_across_a_5_minute_boundary() {
        let a = generate_sec_ms_gec(1_700_000_100);
        let b = generate_sec_ms_gec(1_700_000_100 + 6 * 60);
        assert_ne!(a, b);
    }

    #[test]
    fn escape_xml_escapes_metacharacters() {
        assert_eq!(escape_xml("a & b < c > d \" e ' f"),
            "a &amp; b &lt; c &gt; d &quot; e &apos; f");
    }

    #[test]
    fn build_ssml_embeds_voice_rate_and_escaped_text() {
        let ssml = build_ssml("hi & bye", "en-US-AriaNeural", 12);
        assert!(ssml.contains("name='en-US-AriaNeural'"));
        assert!(ssml.contains("rate='+12%'"));
        assert!(ssml.contains("hi &amp; bye"));
    }

    #[test]
    fn build_ssml_formats_a_slower_rate_as_negative_percent() {
        assert!(build_ssml("x", "v", -10).contains("rate='-10%'"));
    }

    #[test]
    fn extract_audio_frame_returns_bytes_after_header() {
        // 2-byte length = 3, 3-byte header "abc", then audio [1,2,3].
        let buf = [0x00, 0x03, b'a', b'b', b'c', 1, 2, 3];
        assert_eq!(extract_audio_frame(&buf), &[1, 2, 3]);
    }

    #[test]
    fn extract_audio_frame_handles_truncated_frames() {
        assert_eq!(extract_audio_frame(&[0x00]), &[] as &[u8]);
        // header length claims more than the buffer holds → empty, no panic.
        assert_eq!(extract_audio_frame(&[0x00, 0xFF, 1, 2]), &[] as &[u8]);
    }

    // Real network call — run explicitly with:
    //   cargo test --lib live_synth -- --ignored --nocapture
    // Use this to confirm a GEC_VERSION bump fixed a 403, or that a voice still
    // synthesizes (Microsoft removed zh-CN-XiaoxiaoMultilingualNeural).
    #[tokio::test]
    #[ignore]
    async fn live_synth_returns_audio() {
        let b64 = edge_tts_synthesize(
            "你好，hello world.".to_string(),
            "zh-CN-XiaoxiaoNeural".to_string(),
            0,
        )
        .await
        .expect("synth should succeed");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .unwrap();
        eprintln!("got {} bytes of mp3", bytes.len());
        assert!(bytes.len() > 1000, "expected a non-trivial mp3");
    }
}
