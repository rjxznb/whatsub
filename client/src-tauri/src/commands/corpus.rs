//! Corpus Tauri commands — wrap server HTTP calls with the session token.

use crate::auth;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

const SERVER_BASE: &str = "https://whatsub.eversay.cc/api/license";

#[derive(Serialize, Deserialize, Debug)]
pub struct BrowseItem {
    // Server's /browse returns SQL snake_case (phrase_normalized, etc.)
    // straight from pg, but the desktop UI uses camelCase. Map both
    // directions explicitly via serde so the JSON shape coming from the
    // server deserialises and the JSON we hand to the React layer keeps
    // its existing field names. meaning_zh + contribution_count default
    // to None/0 because /browse's SELECT doesn't include them today —
    // adding them server-side would be the proper fix.
    #[serde(rename(deserialize = "phrase_normalized", serialize = "phraseNormalized"))]
    pub phrase_normalized: String,
    #[serde(rename(deserialize = "phrase_raw", serialize = "phraseRaw"))]
    pub phrase_raw: String,
    #[serde(rename(deserialize = "meaning_zh", serialize = "meaningZh"), default)]
    pub meaning_zh: Option<String>,
    // 2026-05-20 schema migration: corpus_phrases.key_notes was dropped and
    // moved to corpus_contributions.usage_note. /lookup withScope now sends
    // `usage_note` on the phrase object. Map to `usageNote` for the JS layer.
    #[serde(rename(deserialize = "usage_note", serialize = "usageNote"), default)]
    pub usage_note: Option<String>,
    #[serde(default)]
    pub tags: serde_json::Value,
    #[serde(rename(deserialize = "contribution_count", serialize = "contributionCount"), default)]
    pub contribution_count: i64,
    // Representative source (most-recent curator contribution's source) — lets
    // the public list group "by video source". Passes through verbatim as
    // `source` for the JS layer (same shape as the personal list's source).
    #[serde(default)]
    pub source: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BrowseResponse {
    // Server's /browse endpoint returns the array as `phrases`; the rest of
    // the desktop UI uses `items` everywhere (matches MineResponse). Map
    // both directions on serde so JS sees a single `items` key.
    #[serde(rename(deserialize = "phrases", serialize = "items"))]
    pub items: Vec<BrowseItem>,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MineItem {
    /** corpus_contributions.id — needed so the client can delete one row. */
    #[serde(default)]
    pub id: i64,
    #[serde(rename = "phraseNormalized")]
    pub phrase_normalized: String,
    #[serde(rename = "phraseRaw")]
    pub phrase_raw: String,
    #[serde(rename = "meaningZh")]
    pub meaning_zh: Option<String>,
    #[serde(rename = "contextSentence")]
    pub context_sentence: String,
    pub source: serde_json::Value,
    #[serde(rename = "contributedAt")]
    pub contributed_at: i64,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MineResponse {
    pub items: Vec<MineItem>,
    pub total: i64,
    pub page: i64,
    #[serde(rename = "pageSize")]
    pub page_size: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct ContributionDetail {
    pub id: i64,
    // Server's /lookup withScope returns raw SQL rows (snake_case); the
    // React layer uses camelCase. Same two-way serde rename as BrowseItem.
    #[serde(rename(deserialize = "context_sentence", serialize = "contextSentence"))]
    pub context_sentence: String,
    pub source: serde_json::Value,
    #[serde(rename(deserialize = "contributed_at", serialize = "contributedAt"))]
    pub contributed_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PhraseDetail {
    // phrase is null when the looked-up phrase is a draft (filtered by
    // public_corpus_version). Drafts shouldn't appear in /browse so the UI
    // typically won't request one, but the wire shape allows null, so the
    // type does too.
    pub phrase: Option<BrowseItem>,
    #[serde(rename(deserialize = "publicContributions", serialize = "publicContributions"))]
    pub public_contributions: Vec<ContributionDetail>,
    #[serde(rename(deserialize = "personalContributions", serialize = "personalContributions"))]
    pub personal_contributions: Vec<ContributionDetail>,
}

fn require_token<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    let auth = auth::get_auth(app).ok_or_else(|| "auth_required".to_string())?;
    if !auth::is_valid(&auth) {
        return Err("auth_required".to_string());
    }
    Ok(auth.session_token)
}

#[tauri::command]
pub async fn corpus_browse<R: Runtime>(
    app: AppHandle<R>,
    scene: Option<String>,
    tags: Option<Vec<String>>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<BrowseResponse, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let mut req = client
        .get(format!("{}/corpus/browse", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token));
    if let Some(s) = scene {
        req = req.query(&[("scene", s)]);
    }
    if let Some(ts) = tags {
        if !ts.is_empty() {
            req = req.query(&[("tags", ts.join(","))]);
        }
    }
    if let Some(p) = page {
        req = req.query(&[("page", p.to_string())]);
    }
    if let Some(ps) = page_size {
        req = req.query(&[("pageSize", ps.to_string())]);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        if resp.status().as_u16() == 403 {
            return Err("license_required".to_string());
        }
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str::<BrowseResponse>(&body).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TagsResponse {
    pub tags: Vec<TagCount>,
}

#[tauri::command]
pub async fn corpus_tags<R: Runtime>(
    app: AppHandle<R>,
    scope: Option<String>,
) -> Result<TagsResponse, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let mut req = client
        .get(format!("{}/corpus/tags", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token));
    if let Some(s) = scope {
        req = req.query(&[("scope", s)]);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        if resp.status().as_u16() == 403 {
            return Err("license_required".to_string());
        }
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str::<TagsResponse>(&body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn corpus_mine<R: Runtime>(
    app: AppHandle<R>,
    tags: Option<Vec<String>>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<MineResponse, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let mut req = client
        .get(format!("{}/corpus/mine", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token));
    if let Some(ts) = tags {
        if !ts.is_empty() {
            req = req.query(&[("tags", ts.join(","))]);
        }
    }
    if let Some(p) = page {
        req = req.query(&[("page", p.to_string())]);
    }
    if let Some(ps) = page_size {
        req = req.query(&[("pageSize", ps.to_string())]);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str::<MineResponse>(&body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn corpus_phrase_detail<R: Runtime>(
    app: AppHandle<R>,
    phrase: String,
) -> Result<PhraseDetail, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let resp = client
        .get(format!("{}/corpus/lookup", SERVER_BASE))
        .query(&[("phrase", phrase), ("withScope", "true".to_string())])
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str::<PhraseDetail>(&body).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VersionsResp {
    /// Server-side timestamp of the user's latest contribution. Always present
    /// in current server builds.
    #[serde(default)]
    pub mine: i64,
    /// Server-side timestamp of the latest published public corpus row.
    /// `#[serde(default)]` so we tolerate older server builds that returned
    /// only `mine` — they get a 0 here, the cache-version check then never
    /// short-circuits for the public scope and we always refetch (correct,
    /// just slightly more bandwidth).
    #[serde(default)]
    pub public: i64,
}

#[tauri::command]
pub async fn corpus_versions<R: Runtime>(
    app: AppHandle<R>,
) -> Result<VersionsResp, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let resp = client
        .get(format!("{}/corpus/versions", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http_{}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str::<VersionsResp>(&body).map_err(|e| e.to_string())
}
