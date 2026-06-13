//! Resolve an HTTP proxy for yt-dlp invocations (search + download).
//!
//! Why this exists: on a GFW machine YouTube is reachable only via the user's
//! local proxy (Clash / V2Ray, e.g. `127.0.0.1:7890`). yt-dlp picks up a proxy
//! from the `HTTP_PROXY` / `HTTPS_PROXY` environment variables — which works in
//! `pnpm tauri dev` (the app inherits the launching terminal's env) but NOT in
//! the installed release build: an app launched from the Start menu gets the
//! GUI environment block, which doesn't carry the shell-only `HTTP_PROXY`, and
//! many users have no Windows system proxy either. yt-dlp then goes direct,
//! GFW blocks it, and the call hangs until it times out. We resolve a proxy
//! explicitly so it works regardless of how the app was launched.
//!
//! Resolution order:
//!   1. explicit `settings.ytDlpProxy` (user override; `off`/`direct`/`none`
//!      forces a direct connection — escape hatch),
//!   2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` env vars (keeps dev working),
//!   3. auto-probe a short list of common local proxy ports.
//! Returns `None` for a direct connection.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

fn settings_proxy() -> Option<String> {
    let path = crate::core::paths::settings_path().ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("ytDlpProxy")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
}

fn env_proxy() -> Option<String> {
    for k in [
        "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy",
    ] {
        if let Ok(v) = std::env::var(k) {
            let v = v.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

/// Common local HTTP(-mixed) proxy ports: Clash 7890/7897, V2Ray/Xray HTTP
/// 10809/2080, sing-box 8889. We only auto-probe ports that speak HTTP (Clash's
/// 7890 is a mixed HTTP+SOCKS port) so passing `http://` is correct; SOCKS-only
/// setups (e.g. 1080/10808) should set `settings.ytDlpProxy` explicitly
/// (`socks5://127.0.0.1:1080`).
const PROBE_PORTS: &[u16] = &[7890, 7897, 10809, 2080, 8889];

fn probe_local_proxy() -> Option<String> {
    for &port in PROBE_PORTS {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        if TcpStream::connect_timeout(&addr, Duration::from_millis(120)).is_ok() {
            return Some(format!("http://127.0.0.1:{port}"));
        }
    }
    None
}

/// A `ytDlpProxy` setting value that means "force a direct connection".
fn is_direct_sentinel(s: &str) -> bool {
    matches!(s.trim().to_lowercase().as_str(), "off" | "direct" | "none")
}

/// The proxy URL to hand yt-dlp (`--proxy <url>`), or `None` for direct.
pub fn resolve_yt_dlp_proxy() -> Option<String> {
    match settings_proxy().as_deref().map(str::trim) {
        Some(s) if is_direct_sentinel(s) => return None, // explicit opt-out
        Some(s) if !s.is_empty() => return Some(s.to_string()),
        _ => {}
    }
    env_proxy().or_else(probe_local_proxy)
}

#[cfg(test)]
mod tests {
    use super::is_direct_sentinel;

    #[test]
    fn recognises_direct_sentinels() {
        for s in ["off", "OFF", "Direct", " none ", "DIRECT"] {
            assert!(is_direct_sentinel(s), "{s:?} should force direct");
        }
    }

    #[test]
    fn proxy_urls_are_not_sentinels() {
        for s in ["http://127.0.0.1:7890", "socks5://127.0.0.1:1080", ""] {
            assert!(!is_direct_sentinel(s), "{s:?} should NOT be a sentinel");
        }
    }
}
