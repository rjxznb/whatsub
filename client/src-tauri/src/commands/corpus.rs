//! Corpus Tauri commands — wrap server HTTP calls with the session token.

use crate::auth;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

const SERVER_BASE: &str = "https://whatsub.eversay.cc/api/license";

#[derive(Serialize, Deserialize, Debug)]
pub struct BrowseItem {
    #[serde(rename = "phraseNormalized")]
    pub phrase_normalized: String,
    #[serde(rename = "phraseRaw")]
    pub phrase_raw: String,
    #[serde(rename = "meaningZh")]
    pub meaning_zh: Option<String>,
    pub tags: serde_json::Value,
    #[serde(rename = "contributionCount")]
    pub contribution_count: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BrowseResponse {
    pub items: Vec<BrowseItem>,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MineItem {
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
    #[serde(rename = "contextSentence")]
    pub context_sentence: String,
    pub source: serde_json::Value,
    #[serde(rename = "contributedAt")]
    pub contributed_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PhraseDetail {
    pub phrase: BrowseItem,
    #[serde(rename = "publicContributions")]
    pub public_contributions: Vec<ContributionDetail>,
    #[serde(rename = "personalContributions")]
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

#[tauri::command]
pub async fn corpus_mine<R: Runtime>(
    app: AppHandle<R>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Result<MineResponse, String> {
    let token = require_token(&app)?;
    let client = Client::new();
    let mut req = client
        .get(format!("{}/corpus/mine", SERVER_BASE))
        .header("Authorization", format!("Bearer {}", token));
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
