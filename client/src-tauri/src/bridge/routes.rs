use actix_web::{web, HttpResponse, Responder};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::vocabulary::VocabEntry;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/ping").to(ping))
        .service(
            web::resource("/vocab")
                .route(web::post().to(post_vocab))
                .route(web::get().to(get_vocab)),
        )
        .service(web::resource("/vocab/batch").route(web::post().to(post_vocab_batch)))
        .service(web::resource("/settings/llm").route(web::get().to(get_settings_llm)))
        .service(
            web::resource("/settings/llm/handoff")
                .route(web::post().to(post_handoff)),
        );
}

// ── /ping ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Ping {
    service: &'static str,
    version: String,
    desktop_version: String,
}

async fn ping(_app: web::Data<AppHandle>) -> impl Responder {
    let version = env!("CARGO_PKG_VERSION").to_string();
    HttpResponse::Ok().json(Ping {
        service: "whatsub-bridge",
        version: version.clone(),
        desktop_version: version,
    })
}

// ── Shared response type ─────────────────────────────────────────────────────

#[derive(Serialize)]
struct UpsertResult {
    ok: bool,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

// ── POST /vocab ───────────────────────────────────────────────────────────────

async fn post_vocab(
    _app: web::Data<AppHandle>,
    body: web::Json<VocabEntry>,
) -> impl Responder {
    let entry = body.into_inner();
    let id = entry.id.clone();
    match crate::commands::vocabulary::vocab_upsert(entry) {
        Ok(returned_id) => HttpResponse::Created().json(UpsertResult {
            ok: true,
            id: returned_id,
            reason: None,
        }),
        Err(e) => HttpResponse::BadRequest().json(UpsertResult {
            ok: false,
            id,
            reason: Some(e.to_string()),
        }),
    }
}

// ── POST /vocab/batch ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct VocabBatch {
    items: Vec<VocabEntry>,
}

async fn post_vocab_batch(
    _app: web::Data<AppHandle>,
    body: web::Json<VocabBatch>,
) -> impl Responder {
    let mut results: Vec<UpsertResult> = Vec::new();
    for entry in body.into_inner().items {
        let id = entry.id.clone();
        results.push(match crate::commands::vocabulary::vocab_upsert(entry) {
            Ok(returned_id) => UpsertResult {
                ok: true,
                id: returned_id,
                reason: None,
            },
            Err(e) => UpsertResult {
                ok: false,
                id,
                reason: Some(e.to_string()),
            },
        });
    }
    HttpResponse::Ok().json(serde_json::json!({ "results": results }))
}

// ── GET /vocab ────────────────────────────────────────────────────────────────

async fn get_vocab(_app: web::Data<AppHandle>) -> impl Responder {
    match crate::commands::vocabulary::vocab_load_all() {
        Ok(entries) => HttpResponse::Ok().json(serde_json::json!({ "entries": entries })),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

// ── /settings/llm helpers ─────────────────────────────────────────────────────

/// Load the raw settings Value from disk. Returns an error string on failure.
fn load_settings_value() -> Result<serde_json::Value, String> {
    crate::commands::settings::get_settings()
        .map(|v| if v.is_null() { serde_json::json!({}) } else { v })
        .map_err(|e| e.to_string())
}

/// Derive (model, baseUrl, apiKey) from the raw settings JSON.
///
/// Settings are persisted in camelCase (TypeScript convention):
///   llmProvider: "openai-compatible" | "claude" | "gemini"
///   openaiCompatible: { baseUrl, apiKey, model }
///   claude: { apiKey, model }
///   gemini: { apiKey, model }
fn extract_llm_fields(s: &serde_json::Value) -> (String, String, String, String) {
    let provider = s["llmProvider"].as_str().unwrap_or("openai-compatible").to_string();
    let (model, base_url, api_key) = match provider.as_str() {
        "claude" => (
            s["claude"]["model"].as_str().unwrap_or("").to_string(),
            String::new(),
            s["claude"]["apiKey"].as_str().unwrap_or("").to_string(),
        ),
        "gemini" => (
            s["gemini"]["model"].as_str().unwrap_or("").to_string(),
            String::new(),
            s["gemini"]["apiKey"].as_str().unwrap_or("").to_string(),
        ),
        // "openai-compatible" and any future providers
        _ => (
            s["openaiCompatible"]["model"].as_str().unwrap_or("").to_string(),
            s["openaiCompatible"]["baseUrl"].as_str().unwrap_or("").to_string(),
            s["openaiCompatible"]["apiKey"].as_str().unwrap_or("").to_string(),
        ),
    };
    (provider, model, base_url, api_key)
}

// ── GET /settings/llm ─────────────────────────────────────────────────────────

/// Returns LLM metadata (provider, model, baseUrl) without exposing the API key.
async fn get_settings_llm(_app: web::Data<AppHandle>) -> impl Responder {
    let s = match load_settings_value() {
        Ok(v) => v,
        Err(e) => return HttpResponse::InternalServerError().body(e),
    };
    let (provider, model, base_url, _api_key) = extract_llm_fields(&s);
    HttpResponse::Ok().json(serde_json::json!({
        "provider": provider,
        "model": model,
        "baseUrl": base_url,
    }))
}

// ── POST /settings/llm/handoff ────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandoffReq {
    extension_id: String,
}

/// Shows a native confirm dialog; if approved, returns the full LLM config
/// including the API key. Returns 403 if the user declines.
async fn post_handoff(
    app: web::Data<AppHandle>,
    body: web::Json<HandoffReq>,
) -> impl Responder {
    let req = body.into_inner();
    let approved = super::handoff::request_handoff(&app, &req.extension_id).await;
    if !approved {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "ok": false,
            "reason": "user_declined"
        }));
    }
    let s = match load_settings_value() {
        Ok(v) => v,
        Err(e) => return HttpResponse::InternalServerError().body(e),
    };
    let (provider, model, base_url, api_key) = extract_llm_fields(&s);
    HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
        "provider": provider,
        "model": model,
        "baseUrl": base_url,
        "apiKey": api_key,
    }))
}
