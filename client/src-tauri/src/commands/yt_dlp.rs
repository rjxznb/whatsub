//! Runtime yt-dlp management.
//!
//! Why this module exists:
//!   yt-dlp upstream ships frequent updates (multiple per week) chasing
//!   YouTube's player JS / signature changes. Whenever YouTube changes
//!   their extraction algorithm, older yt-dlp versions break (downloads
//!   fail with "Unable to extract" or produce broken streams). Bundling
//!   a single yt-dlp at app-build time means users would have to wait
//!   for a fresh whatsub release every time upstream catches up — way
//!   too slow for a fast-moving cat-and-mouse game.
//!
//! How it works:
//!   - At build time we bundle the latest yt-dlp release as a Tauri
//!     sidecar (binaries/yt-dlp-<triple>{.exe}). That's the fallback.
//!   - Users can hit Settings → 更新 yt-dlp to download the current
//!     latest into `<app_data>/bin/yt-dlp{.exe}`.
//!   - `pipeline::ytdlp` checks for the AppData copy FIRST on every
//!     run; falls back to the bundled sidecar if absent. So updates
//!     are user-driven, immediate, and don't require re-releasing
//!     whatsub itself.
//!
//! Atomic update: we download to `yt-dlp.downloading`, then rename to
//! the final name. Crashes / network drops leave the previous good
//! binary in place.

use crate::core::paths;
use crate::pipeline::spawn::run_sidecar;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::AppHandle;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpStatus {
    /// e.g. "2026.03.17" — the `--version` output from the active binary.
    pub version: String,
    /// "appdata" if user-updated copy is being used, "bundled" if not.
    pub source: String,
}

/// Compute the path to the AppData yt-dlp, regardless of whether it
/// exists. Exported so other modules (e.g. pipeline::ytdlp) can pick
/// it up. Returns None on systems where we can't resolve app_data_dir.
pub fn appdata_yt_dlp_path() -> Option<PathBuf> {
    let dir = paths::app_data_dir().ok()?.join("bin");
    let name = if cfg!(target_os = "windows") {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };
    Some(dir.join(name))
}

/// Returns Some(path) IFF the AppData yt-dlp exists on disk and is
/// readable. The pipeline calls this to decide whether to use it
/// instead of the bundled sidecar.
pub fn resolve_appdata_yt_dlp() -> Option<PathBuf> {
    let p = appdata_yt_dlp_path()?;
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

/// GET a URL and return the whole body, mapping errors to Chinese strings.
async fn download_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))
        .map(|b| b.to_vec())
}

/// Run `<exe> --version` and return the trimmed first line of stdout.
fn run_version_cmd(exe: &std::path::Path) -> Result<String, String> {
    let output = std::process::Command::new(exe)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("无法运行 yt-dlp --version: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "yt-dlp --version 退出码 {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string())
}

#[tauri::command]
pub async fn yt_dlp_get_status(app: AppHandle) -> Result<YtDlpStatus, String> {
    if let Some(p) = resolve_appdata_yt_dlp() {
        let version = run_version_cmd(&p)?;
        return Ok(YtDlpStatus {
            version,
            source: "appdata".into(),
        });
    }
    // Bundled — use the shell sidecar to ask for --version.
    let stdout = run_sidecar(&app, "yt-dlp", &["--version"], |_| {}, None)
        .await
        .map_err(|e| format!("无法读取内置 yt-dlp 版本: {e}"))?;
    let version = stdout.lines().next().unwrap_or("").trim().to_string();
    Ok(YtDlpStatus {
        version,
        source: "bundled".into(),
    })
}

#[tauri::command]
pub async fn yt_dlp_update() -> Result<YtDlpStatus, String> {
    let is_windows = cfg!(target_os = "windows");
    if !is_windows && !cfg!(target_os = "macos") {
        return Err("当前操作系统不支持 yt-dlp 自动更新".into());
    }

    // Resolve one immutable upstream version first. DogeCloud and GitHub then
    // serve byte-identical filenames under that version rather than mutable
    // `latest` paths that CDN edges could cache inconsistently.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP client build: {e}"))?;
    let manifest = fetch_update_manifest(&client)
        .await
        .ok_or_else(|| "无法获取 yt-dlp 最新版本信息".to_string())?;
    let (primary, fallback) = yt_dlp_download_urls(&manifest.version, is_windows);

    let final_path = appdata_yt_dlp_path().ok_or_else(|| "无法定位 AppData 目录".to_string())?;
    let bin_dir = final_path
        .parent()
        .ok_or_else(|| "AppData 路径无效".to_string())?
        .to_path_buf();
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("创建 bin 目录失败: {e}"))?;

    let tmp_path = bin_dir.join(format!(
        "{}.downloading",
        final_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("yt-dlp")
    ));

    // 120s total timeout — yt-dlp.exe is ~20MB on Win, ~30MB on Mac.
    // DogeCloud CDN is primary (mainland CN); GitHub is fallback. A short
    // connect_timeout bounds the worst case: if the CDN primary hangs at
    // connect, we fall back to GitHub in ~15s instead of waiting the full 120s.
    let bytes = match download_bytes(&client, &primary).await {
        Ok(b) => b,
        Err(primary_err) => download_bytes(&client, &fallback)
            .await
            .map_err(|fb_err| format!("主源失败({primary_err}); 备用源失败({fb_err})"))?,
    };

    std::fs::write(&tmp_path, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;

    // chmod +x on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp_path)
            .map_err(|e| format!("读取临时文件权限失败: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tmp_path, perms)
            .map_err(|e| format!("设置可执行权限失败: {e}"))?;
    }

    // Atomic rename. If the final path is currently in use by another
    // process (e.g. yt-dlp running on background import), rename may
    // fail on Windows with "file in use". We'd handle that with retry
    // in a future revision; for now the error message bubbles up so
    // the user knows to retry after the current import finishes.
    std::fs::rename(&tmp_path, &final_path)
        .map_err(|e| format!("替换 yt-dlp 失败 (可能正在运行中,稍后重试): {e}"))?;

    let version = run_version_cmd(&final_path)?;
    Ok(YtDlpStatus {
        version,
        source: "appdata".into(),
    })
}

/// DogeCloud-hosted version manifest URL, followed by the official upstream
/// GitHub Release API fallback. The fixed `yt-dlp` tag is not the app latest.
const YTDLP_MANIFEST_URLS: [&str; 2] = [
    "https://download.eversay.cc/yt-dlp/yt-dlp-version.json",
    "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
];
const YTDLP_MANIFEST_USER_AGENT: &str = "whatsub/yt-dlp-updater";

fn yt_dlp_download_urls(version: &str, windows: bool) -> (String, String) {
    let filename = if windows { "yt-dlp.exe" } else { "yt-dlp_macos" };
    (
        format!("https://download.eversay.cc/yt-dlp/{version}/{filename}"),
        format!("https://github.com/yt-dlp/yt-dlp/releases/download/{version}/{filename}"),
    )
}

fn valid_ytdlp_version(version: &str) -> bool {
    !version.is_empty()
        && version.split('.').all(|part| {
            !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn ytdlp_manifest_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
}

fn ytdlp_manifest_request(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    client
        .get(url)
        .header(reqwest::header::USER_AGENT, YTDLP_MANIFEST_USER_AGENT)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YtDlpUpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub notes: String,
}

#[derive(Deserialize)]
struct YtDlpManifest {
    version: String,
    #[serde(default)]
    notes: String,
}

#[derive(Deserialize)]
struct GitHubYtDlpRelease {
    tag_name: String,
    #[serde(default)]
    body: String,
}

async fn download_update_manifest(
    client: &reqwest::Client,
    url: &str,
) -> Result<YtDlpManifest, ()> {
    let bytes = ytdlp_manifest_request(client, url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| ())?
        .bytes()
        .await
        .map_err(|_| ())?;

    let manifest = if url == YTDLP_MANIFEST_URLS[0] {
        serde_json::from_slice(&bytes).map_err(|_| ())
    } else {
        let release: GitHubYtDlpRelease = serde_json::from_slice(&bytes).map_err(|_| ())?;
        Ok(YtDlpManifest {
            version: release.tag_name,
            notes: release.body,
        })
    }?;
    valid_ytdlp_version(&manifest.version)
        .then_some(manifest)
        .ok_or(())
}

async fn fetch_update_manifest(client: &reqwest::Client) -> Option<YtDlpManifest> {
    for url in YTDLP_MANIFEST_URLS {
        if let Ok(candidate) = download_update_manifest(client, url).await {
            return Some(candidate);
        }
    }
    None
}

/// True when dotted-numeric `latest` is strictly newer than `current`
/// (e.g. "2026.06.10" > "2026.06.09"). Component-wise numeric compare so
/// point releases ("2026.06.09.1") and any zero-pad quirks are handled;
/// unparseable components count as 0, so malformed input is never "newer".
fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| {
        s.split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect::<Vec<u64>>()
    };
    let (l, c) = (parse(latest), parse(current));
    for i in 0..l.len().max(c.len()) {
        let lv = l.get(i).copied().unwrap_or(0);
        let cv = c.get(i).copied().unwrap_or(0);
        if lv != cv {
            return lv > cv;
        }
    }
    false
}

#[tauri::command]
pub async fn yt_dlp_check_update(app: AppHandle) -> Result<YtDlpUpdateInfo, String> {
    let current = yt_dlp_get_status(app).await?.version;
    let none = |cur: &str| YtDlpUpdateInfo {
        current: cur.to_string(),
        latest: cur.to_string(),
        has_update: false,
        notes: String::new(),
    };
    // Best-effort: any network/parse failure → "no update" (never blocks launch).
    let client = match ytdlp_manifest_client() {
        Ok(c) => c,
        Err(_) => return Ok(none(&current)),
    };
    let Some(manifest) = fetch_update_manifest(&client).await else {
        return Ok(none(&current));
    };
    let has_update = is_newer(&manifest.version, &current);
    Ok(YtDlpUpdateInfo {
        current,
        latest: manifest.version,
        has_update,
        notes: manifest.notes,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        is_newer, valid_ytdlp_version, yt_dlp_download_urls, ytdlp_manifest_request,
        YTDLP_MANIFEST_URLS,
    };
    use reqwest::header::USER_AGENT;

    #[test]
    fn manifest_client_sends_a_stable_user_agent_to_github() {
        let request = ytdlp_manifest_request(&reqwest::Client::new(), YTDLP_MANIFEST_URLS[1])
            .build()
            .expect("GitHub manifest request must build");

        assert_eq!(
            request.headers().get(USER_AGENT).and_then(|value| value.to_str().ok()),
            Some("whatsub/yt-dlp-updater"),
        );
    }

    #[test]
    fn yt_dlp_runtime_sources_prefer_dogecloud_before_official_github() {
        assert_eq!(
            yt_dlp_download_urls("2026.08.20", true),
            (
                "https://download.eversay.cc/yt-dlp/2026.08.20/yt-dlp.exe".to_string(),
                "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.20/yt-dlp.exe".to_string(),
            )
        );
        assert_eq!(
            yt_dlp_download_urls("2026.08.20", false),
            (
                "https://download.eversay.cc/yt-dlp/2026.08.20/yt-dlp_macos".to_string(),
                "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.20/yt-dlp_macos".to_string(),
            )
        );
    }

    #[test]
    fn yt_dlp_version_rejects_path_and_url_injection() {
        assert!(valid_ytdlp_version("2026.08.20"));
        assert!(valid_ytdlp_version("2026.08.20.1"));
        assert!(!valid_ytdlp_version(""));
        assert!(!valid_ytdlp_version("latest"));
        assert!(!valid_ytdlp_version("../latest"));
        assert!(!valid_ytdlp_version("2026.08.20?x=1"));
    }

    #[test]
    fn newer_by_day_month_year() {
        assert!(is_newer("2026.06.10", "2026.06.09"));
        assert!(is_newer("2026.07.01", "2026.06.30"));
        assert!(is_newer("2027.01.01", "2026.12.31"));
    }

    #[test]
    fn not_newer_when_equal_or_older() {
        assert!(!is_newer("2026.06.09", "2026.06.09"));
        assert!(!is_newer("2026.06.08", "2026.06.09"));
    }

    #[test]
    fn handles_point_release_and_malformed() {
        assert!(is_newer("2026.06.09.1", "2026.06.09")); // point release is newer
        assert!(!is_newer("2026.06.09", "2026.06.09.1"));
        assert!(!is_newer("", "2026.06.09"));            // malformed → not newer
        assert!(!is_newer("garbage", "2026.06.09"));
    }
}
