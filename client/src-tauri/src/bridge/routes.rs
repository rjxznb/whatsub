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
        .service(web::resource("/vocab/batch").route(web::post().to(post_vocab_batch)));
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
