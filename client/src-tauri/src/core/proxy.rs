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
//! Resolution order (no user-facing setting — auto only, since auto-probe
//! covers Clash/V2Ray on standard ports and the explicit override felt
//! redundant; SOCKS-only / non-standard ports can still set HTTPS_PROXY):
//!   1. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` env vars (keeps dev working),
//!   2. auto-probe a short list of common local proxy ports.
//! Returns `None` for a direct connection.

use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

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
/// setups (e.g. 1080/10808) should export `HTTPS_PROXY=socks5://127.0.0.1:1080`.
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

/// The proxy URL to hand yt-dlp (`--proxy <url>`), or `None` for direct.
pub fn resolve_yt_dlp_proxy() -> Option<String> {
    env_proxy().or_else(probe_local_proxy)
}
