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
use std::process::Stdio;
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
    /// Optional explicit browser: "edge" | "chrome" | "brave". When None we
    /// auto-detect (Edge-first on Win). Lets the user pick Chrome, which —
    /// unlike Edge — won't hand off to a startup-boost background process and
    /// exit 0 before CDP comes up.
    #[serde(default)]
    pub browser: Option<String>,
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
    let browser_path = match args.browser.as_deref() {
        Some(id) => browser_path_named(id)
            .ok_or_else(|| format!("未找到所选浏览器（{id}）—— 请确认已安装"))?,
        None => detect_browser()
            .ok_or_else(|| "未检测到 Edge / Chrome / Brave —— 请安装其中一个".to_string())?,
    };
    let profile_dir = paths::app_data_dir()?.join("sites-browser");
    std::fs::create_dir_all(&profile_dir)
        .map_err(|e| format!("create sites-browser profile dir: {e}"))?;

    let port = pick_free_port()
        .ok_or_else(|| "在 9223-9322 范围内找不到空闲端口".to_string())?;

    let mut child = spawn_browser(&browser_path, port, &profile_dir, &args.login_url)
        .map_err(|e| format!("启动浏览器失败：{e}"))?;

    // Poll until the CDP endpoint responds (browser fully booted), up to 30s.
    //
    // ⚠️ The child process exiting is NOT a failure by itself. Edge (and
    // sometimes Chrome) uses a LAUNCHER process that forks the real browser
    // and then exits 0 — the actual browser is a separate process that binds
    // the debug port a moment LATER. So when `child` exits we keep polling CDP
    // for a grace window; only if CDP still hasn't come up do we treat the
    // exit as a genuine failure. (Earlier this bailed immediately on child
    // exit → "exit code 0" false failures even though DevTools was listening.)
    let mut ready = false;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut child_exited_at: Option<usize> = None;
    const GRACE_AFTER_EXIT: usize = 25; // ~5s of extra CDP polling
    for i in 0..150 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if is_cdp_alive(port).await {
            ready = true;
            break;
        }
        if child_exited_at.is_none() {
            if let Ok(Some(s)) = child.try_wait() {
                exit_status = Some(s);
                child_exited_at = Some(i);
                // keep polling CDP — the real browser may still be coming up
            }
        } else if let Some(start) = child_exited_at {
            // Launcher already exited and CDP STILL isn't up after the grace
            // window → genuine failure (handoff to a stale instance, policy
            // block, etc.). Stop waiting the full 30s.
            if i.saturating_sub(start) >= GRACE_AFTER_EXIT {
                break;
            }
        }
    }
    if !ready {
        let detail = if let Some(s) = exit_status {
            let code = s.code().map_or("?".into(), |c| c.to_string());
            format!(
                "浏览器进程在 CDP 启动前就退出了 (exit code {code})。最常见原因:\
                 \n① 已经有 Chrome/Edge 实例在用同一个登录 profile —— 请彻底退出\
                 所有 {browser_label} 窗口(系统托盘里也检查一下)后重试\
                 \n② 企业 / 学校组策略禁用了 --remote-debugging-port 调试端口\
                 \n③ 换用 Chrome(下拉里选)通常能绕过 Edge 的后台移交问题{log_tail}",
                browser_label = browser_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("浏览器"),
                log_tail = read_sitelogin_log_tail(),
            )
        } else {
            format!(
                "浏览器启动了但 CDP 端点 (127.0.0.1:{port}) 30 秒内没响应。\
                 可能原因:\
                 \n① 已有浏览器实例占用同一 profile,新进程被合并(关掉所有 Chrome / Edge 重试)\
                 \n② 企业 / 学校组策略禁用了 --remote-debugging-port\
                 \n③ 杀软 / 防火墙拦截 127.0.0.1:{port}"
            )
        };
        return Err(detail);
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

        // Latest cookies seen while CDP was alive. When the browser
        // dies we use this snapshot to do the harvest+save without
        // needing live CDP. Refreshed every 2s, so worst-case
        // staleness is ~2s — fine, the user logs in over many seconds.
        let mut last_cookies: Vec<CdpCookie> = Vec::new();
        // Latch: only treat "zero page targets" as "user closed the window"
        // AFTER we've seen at least one page. Otherwise a startup race (watcher
        // polls before the login tab registers) could finalize prematurely.
        let mut saw_page = false;

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

            if is_cdp_alive(port).await {
                // Process is up — but that's NOT the same as "a window is
                // open" (see cdp_count_pages). Check the page targets to tell
                // a genuinely-open login window apart from a lingering
                // background process whose windows the user already closed.
                match cdp_count_pages(port).await {
                    Some(0) if saw_page => {
                        // The user closed the last login window but the
                        // process is hanging around in the background. Treat
                        // it as closed: terminate the lingering process so we
                        // don't leave a headless browser running, then fall
                        // through to the finalize path below.
                        let _ = cdp_close_browser(port).await;
                    }
                    other => {
                        if matches!(other, Some(n) if n > 0) {
                            saw_page = true;
                        }
                        // Window still open (or count temporarily unknown) —
                        // refresh the snapshot. On error keep the previous one
                        // (better stale than empty).
                        if let Ok(latest) = cdp_get_all_cookies(port).await {
                            last_cookies = latest;
                        }
                        continue;
                    }
                }
            }

            // CDP gone (process exited) OR the last login window was closed
            // while the process lingered. Try to save the most recent snapshot
            // we captured. If it has cookies for this site's harvest domains,
            // the user logged in before closing — emit success. Otherwise
            // (empty profile / user closed without logging in), emit cancelled
            // so the dialog falls back to the form.
            let pending = {
                let mut p = match state.pending.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                match p.as_ref() {
                    Some(pl) if pl.gen == my_gen => p.take(),
                    _ => None,
                }
            };
            let Some(pending) = pending else { return };

            if let Ok(mut g) = state.cdp_port.lock() {
                *g = None;
            }

            match save_cookies_from_snapshot(&app, &last_cookies, &pending) {
                Ok(_) => {
                    // success event already emitted inside the helper
                }
                Err(_) => {
                    let _ = app.emit("site-login-cancelled", ());
                }
            }
            return;
        }
    });
}

// ─── Finish: fetch cookies via CDP ───────────────────────────────────

/// Filter a raw CDP cookie snapshot by the pending site's harvest
/// domains and persist them to the cookie jar. Emits site-login-success
/// when at least one usable cookie is found. The caller is responsible
/// for restoring pending state if this returns Err.
///
/// Pure: doesn't touch CDP. Used by both `harvest_cookies_and_save`
/// (live CDP fetch path) and the watcher's browser-close path (which
/// uses a cached snapshot taken before the browser process died).
fn save_cookies_from_snapshot(
    app: &AppHandle,
    raw: &[CdpCookie],
    pending: &PendingLogin,
) -> Result<usize, String> {
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
                domain: c.domain.clone(),
                path: c.path.clone(),
                secure: c.secure,
                // CDP expires is f64 seconds-since-epoch; -1 = session.
                expires: if c.expires < 0.0 {
                    None
                } else {
                    Some(c.expires as i64)
                },
                name: c.name.clone(),
                value: c.value.clone(),
            });
        }
    }

    if harvested.is_empty() {
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
            site_key: pending.site_key.clone(),
            label: pending.label.clone(),
            cookie_count,
            at: now_ms,
        },
    );

    Ok(cookie_count)
}

/// Fetch live cookies via CDP, then call save_cookies_from_snapshot.
/// Used by the explicit `site_login_finish` command.
async fn harvest_cookies_and_save(
    app: &AppHandle,
    port: u16,
    pending: &PendingLogin,
) -> Result<usize, String> {
    let raw = cdp_get_all_cookies(port)
        .await
        .map_err(|e| format!("通过 CDP 抓 cookies 失败：{e}"))?;
    save_cookies_from_snapshot(app, &raw, pending)
}

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

    match harvest_cookies_and_save(&app, port, &pending).await {
        Ok(_) => {
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
        Err(e) => {
            // Put pending back so user can retry (most common case:
            // they clicked save before actually completing login).
            let mut g = state.pending.lock().map_err(|e| e.to_string())?;
            *g = Some(pending);
            Err(e)
        }
    }
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

/// Candidate exe paths for one browser ("Edge" | "Chrome" | "Brave") on the
/// current OS. The first that `.exists()` is the one we launch.
fn browser_candidates(name: &str) -> Vec<PathBuf> {
    if cfg!(target_os = "windows") {
        win_paths(name)
    } else if cfg!(target_os = "macos") {
        match name {
            "Chrome" => vec![PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            )],
            "Edge" => vec![PathBuf::from(
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            )],
            "Brave" => vec![PathBuf::from(
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            )],
            _ => vec![],
        }
    } else {
        vec![]
    }
}

/// Preferred auto-detect order. Mac flips to Chrome first (Edge less common).
fn browser_order() -> [&'static str; 3] {
    if cfg!(target_os = "macos") {
        ["Chrome", "Edge", "Brave"]
    } else {
        ["Edge", "Chrome", "Brave"]
    }
}

fn detect_browser() -> Option<PathBuf> {
    for name in browser_order() {
        if let Some(p) = browser_candidates(name).into_iter().find(|p| p.exists()) {
            return Some(p);
        }
    }
    None
}

/// Resolve a specific browser by user-facing id ("edge"/"chrome"/"brave").
fn browser_path_named(id: &str) -> Option<PathBuf> {
    let name = match id.to_ascii_lowercase().as_str() {
        "edge" => "Edge",
        "chrome" => "Chrome",
        "brave" => "Brave",
        _ => return None,
    };
    browser_candidates(name).into_iter().find(|p| p.exists())
}

/// List installed browsers (lowercase ids) so the UI can offer a picker —
/// Chrome avoids Edge's startup-boost handoff that yields the exit-0 error.
#[tauri::command]
pub fn site_login_browsers() -> Vec<String> {
    ["Edge", "Chrome", "Brave"]
        .iter()
        .filter(|n| browser_candidates(n).into_iter().any(|p| p.exists()))
        .map(|n| n.to_ascii_lowercase())
        .collect()
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
) -> std::io::Result<std::process::Child> {
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
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(format!(
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
        // stdin null in case a build emits prompts on startup.
        .stdin(Stdio::null());
    // Capture the browser's stdout+stderr to a log (truncated per launch).
    // Chromium chatter is mostly benign, but when the process exits 0 before
    // CDP comes up, this log is the ONLY place the real reason shows (profile
    // in use / policy blocked / bad flag) — the exit-0 branch reads its tail.
    // Best-effort: if the file can't be opened, fall back to discarding output.
    match std::fs::File::create(sitelogin_log_path())
        .and_then(|f| f.try_clone().map(|g| (f, g)))
    {
        Ok((out, err)) => {
            cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    let child = cmd.spawn()?;
    Ok(child)
}

/// Diagnostic log path for the spawned browser's stdout+stderr.
fn sitelogin_log_path() -> PathBuf {
    std::env::temp_dir().join("whatsub-sitelogin.log")
}

/// Tail of the browser log, for surfacing the real exit-0 reason. Empty string
/// when the log is missing/empty (so it appends cleanly to the error message).
fn read_sitelogin_log_tail() -> String {
    let raw = match std::fs::read_to_string(sitelogin_log_path()) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Last ~800 chars — enough for the relevant Chromium error line(s).
    let tail: String = trimmed.chars().rev().take(800).collect::<Vec<_>>().into_iter().rev().collect();
    format!("\n\n浏览器输出（诊断用）:\n{tail}")
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
    // .no_proxy() is CRITICAL: reqwest honors the system / env proxy by
    // default, so for a user on a 梯子/VPN the localhost CDP request gets sent
    // THROUGH the proxy (which can't reach their 127.0.0.1) and fails — even
    // though the browser's debug port is up. That produced the false
    // "exit code 0" while the log showed "DevTools listening on ws://...".
    let client = match reqwest::Client::builder()
        .no_proxy()
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

/// Count the browser's currently-open `"type":"page"` targets via the CDP
/// `/json/list` HTTP endpoint. Returns `None` on any error so the caller can
/// treat it as "unknown — keep waiting" rather than "closed".
///
/// Why this exists: `is_cdp_alive` hits `/json/version`, which is answered by
/// the browser PROCESS — it stays 200 even after the user closes every window,
/// because on Windows Edge/Chrome routinely keeps a background process alive
/// (background mode / startup boost / lingering profile process). So a CDP-only
/// liveness check never detects "the user closed the login window" and the
/// close-watcher would wait forever. Page targets DO disappear when their
/// window/tab is closed, so a drop to zero is the reliable "window closed"
/// signal even while the process lingers.
async fn cdp_count_pages(port: u16) -> Option<usize> {
    let url = format!("http://127.0.0.1:{port}/json/list");
    // .no_proxy() for the same 梯子/VPN reason as is_cdp_alive.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(1500))
        .build()
        .ok()?;
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.text().await.ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    Some(count_page_targets(&v))
}

/// Pure core of [`cdp_count_pages`]: count array entries whose `type` is
/// `"page"` (the user-facing tabs/windows). Background pages, service workers,
/// `iframe`, etc. have other `type`s and don't count — so zero pages means the
/// user closed the login window even if the browser process is still running.
fn count_page_targets(targets: &serde_json::Value) -> usize {
    targets
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|t| t.get("type").and_then(|x| x.as_str()) == Some("page"))
                .count()
        })
        .unwrap_or(0)
}

async fn cdp_open_tab(port: u16, url: &str) -> Result<(), String> {
    let endpoint = format!("http://127.0.0.1:{port}/json/new?{url}");
    // Modern Chromium requires PUT; older accepted GET. Try PUT first.
    // .no_proxy(): never route the localhost CDP call through a 梯子/VPN proxy.
    let client = reqwest::Client::builder()
        .no_proxy()
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
    // .no_proxy(): localhost CDP must not go through a 梯子/VPN proxy.
    let client = reqwest::Client::builder()
        .no_proxy()
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
    // .no_proxy(): localhost CDP must not go through a 梯子/VPN proxy.
    let client = reqwest::Client::builder()
        .no_proxy()
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

#[cfg(test)]
mod tests {
    use super::count_page_targets;
    use serde_json::json;

    #[test]
    fn counts_only_page_type_targets() {
        // A typical /json/list payload: one open login page plus
        // non-page targets that must NOT be counted.
        let v = json!([
            { "type": "page", "url": "https://www.youtube.com/" },
            { "type": "service_worker", "url": "https://www.youtube.com/sw.js" },
            { "type": "background_page", "url": "chrome-extension://x" },
            { "type": "page", "url": "https://accounts.google.com/" }
        ]);
        assert_eq!(count_page_targets(&v), 2);
    }

    #[test]
    fn zero_pages_when_only_non_page_targets() {
        // User closed every window: the process lingers and only a
        // service worker remains → zero pages → "window closed" signal.
        let v = json!([{ "type": "service_worker", "url": "x" }]);
        assert_eq!(count_page_targets(&v), 0);
    }

    #[test]
    fn empty_list_is_zero() {
        assert_eq!(count_page_targets(&json!([])), 0);
    }

    #[test]
    fn non_array_is_zero() {
        // Malformed / unexpected shape must not panic or over-count.
        assert_eq!(count_page_targets(&json!({ "error": "nope" })), 0);
        assert_eq!(count_page_targets(&json!(null)), 0);
    }

    #[test]
    fn missing_type_field_does_not_count() {
        let v = json!([{ "url": "https://x" }, { "type": "page" }]);
        assert_eq!(count_page_targets(&v), 1);
    }
}
