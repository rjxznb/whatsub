//! Per-site login flow using the user's installed system browser.
//!
//! Originally this module spun up a Tauri WebviewWindow and had the
//! user log in inside it. That worked but had two killer flaws:
//!   1. OAuth popups (Sign in with Google, Sign in with Apple, FedCM)
//!      can't open in a single-window WebView — no popup/parent
//!      postMessage channel — so X / Instagram users got stuck.
//!   2. Users typing their Google password into a window with the
//!      whatsub icon felt phishy.
//!
//! New approach: launch the user's real Edge / Chrome / Brave with
//! an isolated, *persistent* user-data-dir at
//! `<app_data>/sites-browser/`. Because it's their genuine browser:
//!   - All login methods work (OAuth, QR codes, SMS, FedCM, passkeys)
//!   - Address-bar trust is real
//! Because the user-data-dir is dedicated:
//!   - No extensions are inherited from their daily profile (extensions
//!     are profile-scoped, and ours starts empty)
//!   - No accidental write-back into the user's main profile
//! Because the dir persists across whatsub launches:
//!   - Logging into YouTube once leaves the session cookie in our
//!     profile; next time the user clicks [YouTube], the browser is
//!     already authenticated and they just hit "保存".
//!
//! Cookie extraction uses Chrome DevTools Protocol (CDP) — launching
//! with `--remote-debugging-port=N` lets us talk to the running
//! browser over a WebSocket. `Storage.getCookies` returns every
//! cookie in the browser context without needing direct disk read
//! (so no file-lock issues — the original blocker for the file-based
//! extraction approach).

use crate::core::cookie_jar::{self, cookie_matches_domain, JarCookie, SiteBucket};
use crate::core::paths;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_tungstenite::tungstenite::Message;

// ─── Presets ─────────────────────────────────────────────────────────

fn presets() -> Vec<SitePreset> {
    vec![
        SitePreset {
            key: "youtube".into(),
            label: "YouTube".into(),
            login_url: "https://www.youtube.com/".into(),
            harvest_domains: vec![
                "youtube.com".into(),
                "google.com".into(),
                "googleusercontent.com".into(),
            ],
        },
        SitePreset {
            key: "bilibili".into(),
            label: "哔哩哔哩".into(),
            login_url: "https://www.bilibili.com/".into(),
            harvest_domains: vec!["bilibili.com".into(), "hdslb.com".into()],
        },
        SitePreset {
            key: "instagram".into(),
            label: "Instagram".into(),
            login_url: "https://www.instagram.com/".into(),
            harvest_domains: vec!["instagram.com".into(), "cdninstagram.com".into()],
        },
        SitePreset {
            key: "x".into(),
            label: "X (Twitter)".into(),
            login_url: "https://x.com/login".into(),
            harvest_domains: vec!["x.com".into(), "twitter.com".into()],
        },
        SitePreset {
            key: "tiktok".into(),
            label: "TikTok".into(),
            login_url: "https://www.tiktok.com/login".into(),
            harvest_domains: vec!["tiktok.com".into()],
        },
    ]
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SitePreset {
    pub key: String,
    pub label: String,
    pub login_url: String,
    pub harvest_domains: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SiteRecord {
    pub key: String,
    pub label: String,
    pub login_at: i64,
    pub cookie_count: usize,
}

// ─── State ───────────────────────────────────────────────────────────

/// Per-app shared state.
///
///   `pending`     — which site the user just clicked to log into;
///                   `site_login_finish` reads this to know what to
///                   harvest.
///   `cdp_port`    — port we launched the system browser on. Cached
///                   so subsequent logins reuse the running browser.
///   `pending_gen` — monotonic counter bumped on every successful
///                   `site_login_start`. Each spawned close-watcher
///                   captures the gen at spawn time and exits silently
///                   when it sees `pending` has been replaced by a
///                   newer login — so stale watchers from previous
///                   sessions can't accidentally cancel a new flow.
pub struct LoginState {
    pending: Mutex<Option<PendingLogin>>,
    cdp_port: Mutex<Option<u16>>,
    pending_gen: Mutex<u64>,
}

impl Default for LoginState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(None),
            cdp_port: Mutex::new(None),
            pending_gen: Mutex::new(0),
        }
    }
}

#[derive(Clone, Debug)]
struct PendingLogin {
    site_key: String,
    label: String,
    harvest_domains: Vec<String>,
    /// Snapshot of `LoginState.pending_gen` at the time this pending
    /// entry was created. Lets watcher tasks recognise their own
    /// session vs a newer one that replaced it.
    gen: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoginSuccess {
    pub site_key: String,
    pub label: String,
    pub cookie_count: usize,
    pub at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PendingLoginInfo {
    pub site_key: String,
    pub label: String,
}

// ─── Trivial commands ────────────────────────────────────────────────

#[tauri::command]
pub fn site_presets() -> Vec<SitePreset> {
    presets()
}

#[tauri::command]
pub fn site_logins_list() -> Vec<SiteRecord> {
    let jar = cookie_jar::load();
    jar.sites
        .into_iter()
        .map(|(key, b)| SiteRecord {
            key,
            label: b.label,
            login_at: b.login_at,
            cookie_count: b.cookies.len(),
        })
        .collect()
}

#[tauri::command]
pub fn site_login_pending(state: State<LoginState>) -> Option<PendingLoginInfo> {
    state
        .pending
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .map(|p| PendingLoginInfo {
            site_key: p.site_key,
            label: p.label,
        })
}

// ─── Start: launch (or reuse) the system browser ────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub key: String,
    pub label: String,
    pub login_url: String,
    pub harvest_domains: Vec<String>,
}

#[tauri::command]
pub async fn site_login_start(
    app: AppHandle,
    state: State<'_, LoginState>,
    args: StartArgs,
) -> Result<(), String> {
    if args.harvest_domains.is_empty() {
        return Err("harvest_domains 不能为空".into());
    }

    // Bump generation BEFORE we set pending so any stale watcher from
    // a prior login session sees the gen change next poll and exits
    // silently before we install the new pending entry.
    let my_gen = {
        let mut g = state.pending_gen.lock().map_err(|e| e.to_string())?;
        *g += 1;
        *g
    };
    {
        let mut guard = state.pending.lock().map_err(|e| e.to_string())?;
        *guard = Some(PendingLogin {
            site_key: args.key.clone(),
            label: args.label.clone(),
            harvest_domains: args.harvest_domains.clone(),
            gen: my_gen,
        });
    }

    // Try the cached port first. If the browser process is still up,
    // we just send a CDP request to open a new tab at the login URL —
    // no spawn, no waiting for startup.
    let cached_port = {
        let g = state.cdp_port.lock().map_err(|e| e.to_string())?;
        *g
    };
    let saved_port = cached_port.or_else(load_saved_port);
    if let Some(port) = saved_port {
        if is_cdp_alive(port).await {
            cdp_open_tab(port, &args.login_url)
                .await
                .map_err(|e| format!("打开新标签失败：{e}"))?;
            let mut g = state.cdp_port.lock().map_err(|e| e.to_string())?;
            *g = Some(port);
            let _ = app.emit(
                "site-login-progress",
                serde_json::json!({ "phase": "browser-ready" }),
            );
            spawn_close_watcher(app.clone(), my_gen);
            return Ok(());
        }
    }

    // Need to spawn a fresh browser. Pick a free port + launch.
    let browser_path = detect_browser()
        .ok_or_else(|| "未检测到 Edge / Chrome / Brave —— 请安装其中一个".to_string())?;
    let profile_dir = paths::app_data_dir()?.join("sites-browser");
    std::fs::create_dir_all(&profile_dir)
        .map_err(|e| format!("create sites-browser profile dir: {e}"))?;

    let port = pick_free_port()
        .ok_or_else(|| "在 9223-9322 范围内找不到空闲端口".to_string())?;

    spawn_browser(&browser_path, port, &profile_dir, &args.login_url)
        .map_err(|e| format!("启动浏览器失败：{e}"))?;

    // Poll until CDP endpoint responds (browser fully booted), up to 12s.
    let mut ready = false;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if is_cdp_alive(port).await {
            ready = true;
            break;
        }
    }
    if !ready {
        return Err(
            "浏览器启动了但 CDP 端点没响应。请确认 Edge / Chrome 不是企业策略限制版本"
                .into(),
        );
    }

    save_port(port);
    {
        let mut g = state.cdp_port.lock().map_err(|e| e.to_string())?;
        *g = Some(port);
    }

    let _ = app.emit(
        "site-login-progress",
        serde_json::json!({ "phase": "browser-ready" }),
    );
    spawn_close_watcher(app.clone(), my_gen);
    Ok(())
}

/// Background poller that detects when the user closes the launched
/// browser without clicking "保存". Fires `site-login-cancelled` to
/// release the frontend's "正在登录..." spinner.
///
/// The `my_gen` parameter is the pending-login generation at the
/// moment this watcher was spawned. Every iteration we re-check the
/// current pending entry — if its gen differs (meaning a newer login
/// flow has replaced ours) OR pending is None (user already clicked
/// save/cancel), the watcher exits silently. This prevents a stale
/// watcher from racing a fresh flow.
fn spawn_close_watcher(app: AppHandle, my_gen: u64) {
    tauri::async_runtime::spawn(async move {
        // Give the browser a moment to fully come up before we start
        // polling — `site_login_start` already waited for the port
        // to respond, but the user needs time to bring the window to
        // focus and start interacting.
        tokio::time::sleep(Duration::from_secs(3)).await;

        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;

            // Re-acquire state via the app handle every iteration so
            // we don't hold a State<> reference across awaits (Tauri
            // managed state isn't Send across all combinations).
            let Some(state) = app.try_state::<LoginState>() else {
                return;
            };

            let still_ours = {
                let p = match state.pending.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                match &*p {
                    Some(pl) => pl.gen == my_gen,
                    None => false,
                }
            };
            if !still_ours {
                // pending was cleared (save / cancel) or replaced by
                // a newer login. Either way, our job is done.
                return;
            }

            let port = {
                let g = match state.cdp_port.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                *g
            };
            let Some(port) = port else { return };

            if !is_cdp_alive(port).await {
                // Browser is gone. Clear our pending (only if it's
                // still ours — final check guards against a save
                // racing us in between checks).
                let cleared = {
                    let mut p = match state.pending.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    if p.as_ref().map(|x| x.gen) == Some(my_gen) {
                        *p = None;
                        true
                    } else {
                        false
                    }
                };
                if cleared {
                    // Also drop the cached port so the next login
                    // launches a fresh browser instead of trying to
                    // reuse a dead port.
                    if let Ok(mut g) = state.cdp_port.lock() {
                        *g = None;
                    }
                    let _ = app.emit("site-login-cancelled", ());
                }
                return;
            }
        }
    });
}

// ─── Finish: fetch cookies via CDP ───────────────────────────────────

#[tauri::command]
pub async fn site_login_finish(
    app: AppHandle,
    state: State<'_, LoginState>,
) -> Result<(), String> {
    let pending = {
        let mut guard = state.pending.lock().map_err(|e| e.to_string())?;
        guard.take()
    }
    .ok_or_else(|| "没有正在进行的登录".to_string())?;

    let port = {
        let g = state.cdp_port.lock().map_err(|e| e.to_string())?;
        g.or_else(load_saved_port)
    }
    .ok_or_else(|| "找不到浏览器的 CDP 端口 —— 请重新点登录".to_string())?;

    if !is_cdp_alive(port).await {
        // Put pending back so user can retry without restarting the
        // whole flow.
        let mut g = state.pending.lock().map_err(|e| e.to_string())?;
        *g = Some(pending);
        return Err("浏览器已关闭。请重新点登录按钮，登录后再保存".into());
    }

    let raw = cdp_get_all_cookies(port)
        .await
        .map_err(|e| format!("通过 CDP 抓 cookies 失败：{e}"))?;

    // Filter by this site's harvest domains + drop empty-value entries.
    let mut harvested: Vec<JarCookie> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for c in raw {
        if c.value.is_empty() {
            continue;
        }
        let matches = pending
            .harvest_domains
            .iter()
            .any(|d| cookie_matches_domain(&c.domain, d));
        if !matches {
            continue;
        }
        let key = (c.domain.clone(), c.name.clone());
        if seen.insert(key) {
            harvested.push(JarCookie {
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                // CDP expires is f64 seconds-since-epoch; -1 = session.
                expires: if c.expires < 0.0 {
                    None
                } else {
                    Some(c.expires as i64)
                },
                name: c.name,
                value: c.value,
            });
        }
    }

    if harvested.is_empty() {
        // Put pending back — almost always means user hit save before
        // completing the actual login in the browser window.
        let mut g = state.pending.lock().map_err(|e| e.to_string())?;
        *g = Some(pending.clone());
        return Err(format!(
            "没有抓到任何 {} 的 cookies — 请先在浏览器里完成登录",
            pending.label
        ));
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let mut jar = cookie_jar::load();
    let cookie_count = harvested.len();
    cookie_jar::upsert_site(
        &mut jar,
        &pending.site_key,
        SiteBucket {
            label: pending.label.clone(),
            login_at: now_ms,
            cookies: harvested,
        },
    );
    cookie_jar::save(&jar)?;
    let _ = bump_settings_in_app(now_ms);

    let _ = app.emit(
        "site-login-success",
        LoginSuccess {
            site_key: pending.site_key,
            label: pending.label,
            cookie_count,
            at: now_ms,
        },
    );

    // Cookies are saved + success event emitted — close the browser
    // we launched. The watcher polling above sees that `pending` was
    // already consumed by the `guard.take()` at the start of this
    // function (it tracks pending.gen), so the close won't be
    // mis-interpreted as a user dismissal. We also clear cdp_port
    // so the next login spawns a fresh browser rather than trying
    // to reuse a port whose process is already exiting.
    let _ = cdp_close_browser(port).await;
    if let Ok(mut g) = state.cdp_port.lock() {
        *g = None;
    }

    Ok(())
}

// ─── Cancel / remove / clear ─────────────────────────────────────────

#[tauri::command]
pub async fn site_login_cancel(state: State<'_, LoginState>) -> Result<(), String> {
    let mut guard = state.pending.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveArgs {
    pub site_key: String,
}

#[tauri::command]
pub fn site_login_remove(args: RemoveArgs) -> Result<(), String> {
    let mut jar = cookie_jar::load();
    cookie_jar::remove_site(&mut jar, &args.site_key);
    cookie_jar::save(&jar)
}

#[tauri::command]
pub fn site_logins_clear() -> Result<(), String> {
    let empty = cookie_jar::CookieJar::default();
    cookie_jar::save(&empty)?;
    let _ = clear_settings_in_app_at();
    Ok(())
}

// ─── Helpers: browser detection ──────────────────────────────────────

fn detect_browser() -> Option<PathBuf> {
    // Order: Edge (most universal on Win) → Chrome → Brave. Mac flips
    // to Chrome first since Edge is less common there.
    let candidates: Vec<Vec<PathBuf>> = if cfg!(target_os = "windows") {
        vec![win_paths("Edge"), win_paths("Chrome"), win_paths("Brave")]
    } else if cfg!(target_os = "macos") {
        vec![
            vec![PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            )],
            vec![PathBuf::from(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            )],
            vec![PathBuf::from(
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            )],
        ]
    } else {
        vec![]
    };
    for group in candidates {
        for p in group {
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn win_paths(name: &str) -> Vec<PathBuf> {
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let pf86 = std::env::var("ProgramFiles(x86)")
        .unwrap_or_else(|_| "C:\\Program Files (x86)".into());
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    match name {
        "Edge" => vec![
            PathBuf::from(format!("{pf86}\\Microsoft\\Edge\\Application\\msedge.exe")),
            PathBuf::from(format!("{pf}\\Microsoft\\Edge\\Application\\msedge.exe")),
        ],
        "Chrome" => vec![
            PathBuf::from(format!("{pf}\\Google\\Chrome\\Application\\chrome.exe")),
            PathBuf::from(format!("{pf86}\\Google\\Chrome\\Application\\chrome.exe")),
            PathBuf::from(format!(
                "{local}\\Google\\Chrome\\Application\\chrome.exe"
            )),
        ],
        "Brave" => vec![PathBuf::from(format!(
            "{pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
        ))],
        _ => vec![],
    }
}

#[cfg(not(target_os = "windows"))]
fn win_paths(_name: &str) -> Vec<PathBuf> {
    Vec::new()
}

// ─── Helpers: browser process ───────────────────────────────────────

fn spawn_browser(
    exe: &PathBuf,
    port: u16,
    profile_dir: &PathBuf,
    login_url: &str,
) -> std::io::Result<()> {
    // Detach the child. We don't `.wait()` on it; the user controls
    // the browser's lifetime from the browser UI.
    //
    // The flag set mirrors what ChromeDriver / Puppeteer pass to get a
    // "clean" browser. With JUST --user-data-dir, extensions stored in
    // the user's main profile don't leak in (extensions are profile-
    // scoped) — BUT Chrome / Edge still load:
    //   * built-in "component extensions" with background pages
    //     (Hangouts, Cast, Cryptotoken, etc.)
    //   * default apps (Chrome Web Store, Docs offline shim)
    //   * Edge-specific surfaces (Sidebar, Bing Chat / Copilot, the
    //     coupons popup, Drop, Discover, Workspaces)
    //   * sync / metrics / suggestion services that periodically
    //     show UI nags
    //
    // The flags below disable all of those without breaking real
    // browsing or login functionality. Order matters less than just
    // having the full set — we don't enable --headless or
    // --enable-automation because those trigger anti-bot detection
    // on Google / Instagram / X login forms (the whole reason we
    // moved off the embedded webview).
    std::process::Command::new(exe)
        .arg(format!(
            "--user-data-dir={}",
            profile_dir.to_string_lossy()
        ))
        .arg(format!("--remote-debugging-port={port}"))
        // ── Welcome / setup-screen suppression ─────────────────────
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--no-service-autorun")
        // ── Extensions, default apps, component extensions ─────────
        .arg("--disable-extensions")
        .arg("--disable-default-apps")
        .arg("--disable-component-extensions-with-background-pages")
        .arg("--disable-extensions-file-access-check")
        // ── Disable lots of Chrome-internal services that show UI nags
        //    or run background workers. The big `--disable-features=`
        //    list is the same one ChromeDriver applies. Includes Edge
        //    surfaces (Copilot sidebar, Bing Chat, Discover, Drop,
        //    Workspaces) and Chrome's translate bar, what's-new tab,
        //    side-panel pin prompt, optimization hints, etc.
        .arg(
            "--disable-features=\
TranslateUI,\
AcceptCHFrame,\
MediaRouter,\
OptimizationHints,\
ChromeWhatsNewUI,\
SidePanelPinning,\
DialMediaRouteProvider,\
GlobalMediaControls,\
ImprovedCookieControls,\
LazyFrameLoading,\
AutofillServerCommunication,\
CalculateNativeWinOcclusion,\
InterestFeedContentSuggestions,\
HeavyAdPrivacyMitigations,\
PrivacySandboxSettings4,\
msEdgeShoppingExperience,\
msEdgeSidebar,\
msEdgeSidebarSearchBar,\
msEdgeCollections,\
msEdgeBingChat,\
msEdgeDiscoverV2,\
msEdgeCopilot,\
msEdgeDrop,\
msEdgeWorkspaces"
        )
        // ── Background services / sync / nags ──────────────────────
        .arg("--disable-background-networking")
        .arg("--disable-background-timer-throttling")
        .arg("--disable-backgrounding-occluded-windows")
        .arg("--disable-breakpad")
        .arg("--disable-client-side-phishing-detection")
        .arg("--disable-hang-monitor")
        .arg("--disable-ipc-flooding-protection")
        .arg("--disable-popup-blocking")
        .arg("--disable-prompt-on-repost")
        .arg("--disable-renderer-backgrounding")
        .arg("--disable-sync")
        .arg("--metrics-recording-only")
        // ── Password store: use Chrome's plain-file store so we
        //    don't trigger keyring/Keychain unlock prompts in this
        //    isolated profile. Doesn't matter for our purposes since
        //    we read cookies via CDP, not from disk.
        .arg("--password-store=basic")
        .arg("--use-mock-keychain")
        // ── Open the target login URL in a new window. Must come
        //    AFTER the flags or some Chromium builds parse it as
        //    another flag.
        .arg("--new-window")
        .arg(login_url)
        .spawn()?;
    Ok(())
}

fn pick_free_port() -> Option<u16> {
    use std::net::TcpListener;
    for port in 9223u16..9323 {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

fn port_file() -> Option<PathBuf> {
    paths::app_data_dir()
        .ok()
        .map(|d| d.join("sites-browser-port"))
}

fn save_port(port: u16) {
    if let Some(p) = port_file() {
        let _ = std::fs::write(&p, port.to_string());
    }
}

fn load_saved_port() -> Option<u16> {
    let p = port_file()?;
    let raw = std::fs::read_to_string(&p).ok()?;
    raw.trim().parse().ok()
}

// ─── CDP HTTP / WebSocket ────────────────────────────────────────────

async fn is_cdp_alive(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/json/version");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(url)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn cdp_open_tab(port: u16, url: &str) -> Result<(), String> {
    let endpoint = format!("http://127.0.0.1:{port}/json/new?{url}");
    // Modern Chromium requires PUT; older accepted GET. Try PUT first.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.put(&endpoint).send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        return Ok(());
    }
    // Fallback to GET for older Chromium builds.
    let resp = client.get(&endpoint).send().await.map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("CDP /json/new returned {}", resp.status()))
    }
}

/// CDP cookie record (subset of `Network.Cookie` we care about).
#[derive(Debug, Clone)]
struct CdpCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    expires: f64,
    secure: bool,
}

async fn cdp_get_all_cookies(port: u16) -> Result<Vec<CdpCookie>, String> {
    // 1. Get the browser-level WebSocket URL.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    // Parse manually via .text() + serde_json so we don't need the
    // `json` feature on reqwest (saves a build flag toggle).
    let body = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let version: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let ws_url = version["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| "CDP /json/version 缺少 webSocketDebuggerUrl".to_string())?
        .to_string();

    // 2. Open the WebSocket.
    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| format!("WebSocket 连接失败：{e}"))?;

    // 3. Send Storage.getCookies — browser-level, returns the union
    //    of cookies across all tabs/contexts in this browser process.
    let req = serde_json::json!({
        "id": 1,
        "method": "Storage.getCookies",
        "params": {}
    });
    ws.send(Message::Text(req.to_string()))
        .await
        .map_err(|e| format!("CDP send: {e}"))?;

    // 4. Read response. Filter for our request id; ignore any
    //    out-of-band events the browser may emit on this channel.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("CDP Storage.getCookies 超时（10s）".into());
        }
        let msg = match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(m)) => m,
            Ok(None) => return Err("CDP WebSocket 提前关闭".into()),
            Err(_) => return Err("CDP Storage.getCookies 超时".into()),
        };
        let text = match msg.map_err(|e| e.to_string())? {
            Message::Text(t) => t,
            // Binary / Ping / Pong / Close — skip non-text frames.
            _ => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&text) {
            Ok(x) => x,
            Err(_) => continue,
        };
        if v.get("id").and_then(|i| i.as_i64()) != Some(1) {
            continue;
        }
        if let Some(err) = v.get("error") {
            return Err(format!("CDP error: {err}"));
        }
        let arr = v["result"]["cookies"]
            .as_array()
            .ok_or_else(|| "CDP response missing cookies array".to_string())?;
        let cookies: Vec<CdpCookie> = arr
            .iter()
            .filter_map(|c| {
                Some(CdpCookie {
                    name: c["name"].as_str()?.to_string(),
                    value: c["value"].as_str()?.to_string(),
                    domain: c["domain"].as_str()?.to_string(),
                    path: c["path"].as_str().unwrap_or("/").to_string(),
                    expires: c["expires"].as_f64().unwrap_or(-1.0),
                    secure: c["secure"].as_bool().unwrap_or(false),
                })
            })
            .collect();
        // Close the WS cleanly.
        let _ = ws.close(None).await;
        return Ok(cookies);
    }
}

/// Tell the dedicated browser to shut itself down. Sent via the same
/// CDP WebSocket pattern as `cdp_get_all_cookies`. Best-effort: a
/// failure here is logged but never propagates upward — cookies are
/// already saved by the time we call this, so the user shouldn't see
/// an error just because the close ping didn't land.
///
/// Browser.close gracefully exits the browser process across all its
/// tabs. Cleaner than killing the PID (we never kept a handle in
/// `spawn_browser`) and works the same on Win / Mac / Linux.
async fn cdp_close_browser(port: u16) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let body = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let version: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let ws_url = version["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| "CDP /json/version 缺少 webSocketDebuggerUrl".to_string())?
        .to_string();

    let (mut ws, _) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| format!("WebSocket 连接失败：{e}"))?;

    // Send Browser.close. Don't wait for a reply — the browser will
    // start tearing down the WebSocket the moment it processes the
    // command, and the response message may never arrive cleanly.
    let req = serde_json::json!({
        "id": 1,
        "method": "Browser.close",
        "params": {}
    });
    ws.send(Message::Text(req.to_string()))
        .await
        .map_err(|e| format!("CDP send: {e}"))?;
    // Give the browser ~300ms to read the command before we hang up;
    // closing the WS first would leave the browser running with a
    // half-processed command.
    let _ = tokio::time::timeout(Duration::from_millis(300), ws.next()).await;
    let _ = ws.close(None).await;
    Ok(())
}

// ─── settings.json helpers (unchanged from prior impl) ──────────────

fn bump_settings_in_app(at_ms: i64) -> Result<(), String> {
    let path = paths::settings_path()?;
    let mut value: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    value["cookieSource"] = serde_json::json!("in-app");
    value["inAppLoginAt"] = serde_json::json!(at_ms);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn clear_settings_in_app_at() -> Result<(), String> {
    let path = paths::settings_path()?;
    if !path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
        if let Some(obj) = v.as_object_mut() {
            obj.remove("inAppLoginAt");
            std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default())
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[allow(dead_code)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CookiesInfo {
    pub path: String,
    pub exists: bool,
}

#[tauri::command]
pub fn youtube_cookies_info() -> Result<CookiesInfo, String> {
    let path = paths::cookies_txt_path()?;
    Ok(CookiesInfo {
        path: path.to_string_lossy().into_owned(),
        exists: path.exists(),
    })
}
