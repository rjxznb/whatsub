//! Multi-site cookie jar.
//!
//! Persists all in-app login cookies in a per-site bucketed JSON file
//! (`<app_data>/cookies.json`) and regenerates the Netscape txt file
//! (`<app_data>/cookies.txt`) yt-dlp reads from. Buckets are keyed by a
//! stable `site_key` (e.g. "youtube", "bilibili", "custom-weibo.com")
//! so logging into a second site appends rather than replacing the
//! first.
//!
//! Source of truth = JSON jar. The Netscape txt is derived (rebuilt on
//! every save) so we can never drift out of sync between what we think
//! is logged in and what yt-dlp actually sees.
//!
//! ## On-disk shape
//!
//! ```json
//! {
//!   "version": 1,
//!   "sites": {
//!     "youtube": {
//!       "label": "YouTube",
//!       "loginAt": 1735689600000,
//!       "cookies": [
//!         { "domain": ".youtube.com", "path": "/", "secure": true,
//!           "expires": 1762560000, "name": "SID", "value": "..." },
//!         ...
//!       ]
//!     },
//!     "bilibili": { ... }
//!   }
//! }
//! ```
//!
//! ## Migration from v0 (yt-cookies.txt only)
//!
//! Pre-this-feature versions wrote a flat `yt-cookies.txt` with no
//! per-site structure. On first `load()` we detect that file, treat
//! its contents as a "youtube" bucket, save the new jar, regenerate
//! cookies.txt, and delete the old file. Idempotent — re-running on a
//! migrated install is a no-op.

use crate::core::netscape_cookies::{serialize, NetscapeCookie};
use crate::core::paths;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SiteBucket {
    /// User-facing display name shown in the Settings list. Comes from
    /// the preset's `label` for known sites, or the URL's hostname for
    /// custom logins.
    pub label: String,
    /// Unix epoch ms when this bucket was last upserted.
    pub login_at: i64,
    /// Cookies harvested from the webview at login time, already
    /// filtered to this site's relevant domains so re-flattening for
    /// cookies.txt doesn't accidentally merge unrelated state.
    pub cookies: Vec<JarCookie>,
}

/// Storage form of a cookie inside the JSON jar. Keep this stable —
/// it's what users have on disk. New fields go at the bottom + must
/// be `Option`/serde-default to round-trip old jars.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JarCookie {
    pub domain: String,
    pub path: String,
    pub secure: bool,
    /// Unix epoch seconds; None = session cookie.
    pub expires: Option<i64>,
    pub name: String,
    pub value: String,
}

impl JarCookie {
    pub fn from_netscape(n: &NetscapeCookie) -> Self {
        Self {
            domain: n.domain.clone(),
            path: n.path.clone(),
            secure: n.secure,
            expires: n.expires,
            name: n.name.clone(),
            value: n.value.clone(),
        }
    }
    pub fn to_netscape(&self) -> NetscapeCookie {
        NetscapeCookie {
            domain: self.domain.clone(),
            path: self.path.clone(),
            secure: self.secure,
            expires: self.expires,
            name: self.name.clone(),
            value: self.value.clone(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CookieJar {
    /// Schema version for future migrations. Currently 1.
    #[serde(default = "default_version")]
    pub version: u32,
    /// Site key → bucket. BTreeMap so the on-disk JSON has stable
    /// ordering across saves (helpful when users diff-check the file
    /// or when we want deterministic cookies.txt output).
    #[serde(default)]
    pub sites: BTreeMap<String, SiteBucket>,
}

fn default_version() -> u32 {
    1
}

/// Load the jar. Runs the v0 → v1 migration on first call if needed.
/// Always returns a valid jar — corruption / missing file = empty jar.
pub fn load() -> CookieJar {
    let jar_path = match paths::cookies_jar_path() {
        Ok(p) => p,
        Err(_) => return CookieJar::default(),
    };

    if jar_path.exists() {
        let raw = match fs::read_to_string(&jar_path) {
            Ok(s) => s,
            Err(_) => return CookieJar::default(),
        };
        return serde_json::from_str(&raw).unwrap_or_default();
    }

    // Migration from old yt-cookies.txt → "youtube" bucket.
    if let Ok(legacy) = paths::legacy_youtube_cookies_path() {
        if legacy.exists() {
            let mut jar = CookieJar {
                version: 1,
                sites: BTreeMap::new(),
            };
            if let Ok(text) = fs::read_to_string(&legacy) {
                let cookies = parse_netscape(&text);
                if !cookies.is_empty() {
                    jar.sites.insert(
                        "youtube".to_string(),
                        SiteBucket {
                            label: "YouTube".to_string(),
                            login_at: now_ms(),
                            cookies: cookies
                                .iter()
                                .map(JarCookie::from_netscape)
                                .collect(),
                        },
                    );
                }
            }
            // Best-effort save + cleanup; failure here just means the
            // migration runs again next launch (still idempotent).
            if save(&jar).is_ok() {
                let _ = fs::remove_file(&legacy);
            }
            return jar;
        }
    }

    CookieJar::default()
}

/// Save the jar AND regenerate cookies.txt. Both writes happen — if
/// either fails we return Err so the caller knows their state may be
/// inconsistent (rare; only on disk-full / permissions errors).
pub fn save(jar: &CookieJar) -> Result<(), String> {
    let jar_path = paths::cookies_jar_path()?;
    if let Some(parent) = jar_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create app data dir: {e}"))?;
    }

    let json =
        serde_json::to_string_pretty(jar).map_err(|e| format!("serialize jar: {e}"))?;
    fs::write(&jar_path, json).map_err(|e| format!("write jar: {e}"))?;

    // Regenerate Netscape txt file from the union of all buckets.
    let txt_path = paths::cookies_txt_path()?;
    let flattened = flatten_for_netscape(jar);
    let body = serialize(&flattened);
    fs::write(&txt_path, body).map_err(|e| format!("write cookies.txt: {e}"))?;

    Ok(())
}

/// Insert or replace a site's bucket. If the site already had cookies
/// they're discarded (intentional — re-login means new session).
pub fn upsert_site(jar: &mut CookieJar, key: &str, bucket: SiteBucket) {
    jar.sites.insert(key.to_string(), bucket);
}

pub fn remove_site(jar: &mut CookieJar, key: &str) -> bool {
    jar.sites.remove(key).is_some()
}

/// Flatten every bucket's cookies into a single Netscape-bound list,
/// dedup'd on (domain, name) — last writer wins, but we don't expect
/// collisions across buckets since each site harvest is filtered to
/// its own domains.
fn flatten_for_netscape(jar: &CookieJar) -> Vec<NetscapeCookie> {
    let mut by_key: BTreeMap<(String, String), NetscapeCookie> = BTreeMap::new();
    // Iterate in BTreeMap order (alphabetical by site_key) for
    // determinism. Within a bucket, cookies stay in their stored
    // order; the final serialize() applies its own sort anyway.
    for bucket in jar.sites.values() {
        for c in &bucket.cookies {
            by_key.insert((c.domain.clone(), c.name.clone()), c.to_netscape());
        }
    }
    by_key.into_values().collect()
}

/// Parse a Netscape cookies.txt file back into NetscapeCookie structs.
/// Used only during the v0 migration; a generic parser since we don't
/// care which site authored the file (the migration assumes YouTube).
fn parse_netscape(content: &str) -> Vec<NetscapeCookie> {
    let mut out = Vec::new();
    for line in content.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 7 {
            continue;
        }
        let secure = parts[3].eq_ignore_ascii_case("TRUE");
        let expires_raw: i64 = parts[4].parse().unwrap_or(0);
        let expires = if expires_raw == 0 { None } else { Some(expires_raw) };
        out.push(NetscapeCookie {
            domain: parts[0].to_string(),
            path: parts[2].to_string(),
            secure,
            expires,
            name: parts[5].to_string(),
            value: parts[6..].join("\t"),
        });
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// True if cookie's domain matches one of `harvest_domains`. A cookie
/// with domain `.youtube.com` matches "youtube.com" (subdomain wildcard
/// semantics); `accounts.google.com` matches "google.com" (parent
/// domain match). Used by site login to filter the webview's cookie
/// jar down to just this site's relevant cookies.
pub fn cookie_matches_domain(cookie_domain: &str, harvest_domain: &str) -> bool {
    let cd = cookie_domain.trim_start_matches('.').to_ascii_lowercase();
    let hd = harvest_domain.trim_start_matches('.').to_ascii_lowercase();
    if cd == hd {
        return true;
    }
    // Subdomain match: cd must end with .hd (e.g. cd=accounts.google.com, hd=google.com)
    if cd.ends_with(&format!(".{hd}")) {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(domain: &str, name: &str, value: &str) -> JarCookie {
        JarCookie {
            domain: domain.into(),
            path: "/".into(),
            secure: true,
            expires: Some(2_000_000_000),
            name: name.into(),
            value: value.into(),
        }
    }

    #[test]
    fn cookie_matches_domain_handles_subdomains() {
        assert!(cookie_matches_domain(".youtube.com", "youtube.com"));
        assert!(cookie_matches_domain("youtube.com", "youtube.com"));
        assert!(cookie_matches_domain("accounts.google.com", "google.com"));
        assert!(cookie_matches_domain(".accounts.google.com", "google.com"));
        assert!(!cookie_matches_domain(".bilibili.com", "youtube.com"));
        // Don't match unrelated domains that happen to end with same suffix
        assert!(!cookie_matches_domain("notyoutube.com", "youtube.com"));
    }

    #[test]
    fn flatten_dedups_by_domain_name() {
        let mut jar = CookieJar::default();
        upsert_site(
            &mut jar,
            "siteA",
            SiteBucket {
                label: "A".into(),
                login_at: 1,
                cookies: vec![cookie(".a.com", "X", "v1")],
            },
        );
        upsert_site(
            &mut jar,
            "siteB",
            SiteBucket {
                label: "B".into(),
                login_at: 2,
                cookies: vec![cookie(".b.com", "Y", "v2")],
            },
        );
        let flat = flatten_for_netscape(&jar);
        assert_eq!(flat.len(), 2);
        assert!(flat.iter().any(|c| c.name == "X" && c.domain == ".a.com"));
        assert!(flat.iter().any(|c| c.name == "Y" && c.domain == ".b.com"));
    }

    #[test]
    fn parse_netscape_round_trips() {
        let body = "# Netscape HTTP Cookie File\n\
                    .youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tabc\n\
                    .google.com\tTRUE\t/\tFALSE\t0\tSESSION\txyz\n";
        let parsed = parse_netscape(body);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].name, "SID");
        assert_eq!(parsed[0].secure, true);
        assert_eq!(parsed[0].expires, Some(2_000_000_000));
        assert_eq!(parsed[1].name, "SESSION");
        assert_eq!(parsed[1].expires, None); // 0 → session cookie
    }
}
