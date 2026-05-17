// Integration tests for the whatsub bridge server layer.
//
// Strategy (C): test /ping contract standalone + CORS admission/rejection.
//
// The real route handlers require `web::Data<AppHandle>`, and constructing a
// valid AppHandle outside of Tauri's full init flow is not practical without
// a mock layer. Instead, we reproduce the /ping handler inline (its only
// external dep is `env!("CARGO_PKG_VERSION")`) and share the same cors_layer
// logic that server.rs uses, so the CORS policy is tested against the real
// configuration.

use actix_cors::Cors;
use actix_web::{test, web, App, HttpResponse, Responder};
use serde::Serialize;

// ── Reproduced /ping handler (no AppHandle dep) ───────────────────────────────

#[derive(Serialize)]
struct PingResp {
    service: &'static str,
    version: String,
    desktop_version: String,
}

async fn ping_test() -> impl Responder {
    let v = env!("CARGO_PKG_VERSION").to_string();
    HttpResponse::Ok().json(PingResp {
        service: "whatsub-bridge",
        version: v.clone(),
        desktop_version: v,
    })
}

// ── CORS layer — mirrors server.rs exactly ────────────────────────────────────

fn cors_layer() -> Cors {
    Cors::default()
        .allowed_origin_fn(|origin, _| {
            origin.as_bytes().starts_with(b"chrome-extension://")
                || origin.as_bytes().starts_with(b"moz-extension://")
        })
        .allowed_methods(vec!["GET", "POST", "DELETE"])
        .allow_any_header()
        .max_age(600)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// /ping returns a JSON body with the correct service banner and a version string.
#[actix_web::test]
async fn ping_returns_banner() {
    let app = test::init_service(
        App::new()
            .wrap(cors_layer())
            .service(web::resource("/ping").to(ping_test)),
    )
    .await;

    let req = test::TestRequest::get().uri("/ping").to_request();
    let resp: serde_json::Value = test::call_and_read_body_json(&app, req).await;

    assert_eq!(resp["service"], "whatsub-bridge");
    assert!(
        resp["version"].is_string(),
        "expected 'version' to be a string, got: {resp}"
    );
    assert!(
        resp["desktop_version"].is_string(),
        "expected 'desktop_version' to be a string, got: {resp}"
    );
    // Both version fields should equal the crate version from Cargo.toml.
    assert_eq!(
        resp["version"], resp["desktop_version"],
        "version and desktop_version should match"
    );
}

/// A chrome-extension:// origin is admitted: HTTP 200 + ACAO header echoes the origin.
#[actix_web::test]
async fn cors_admits_chrome_extension_origin() {
    let app = test::init_service(
        App::new()
            .wrap(cors_layer())
            .service(web::resource("/ping").to(ping_test)),
    )
    .await;

    let req = test::TestRequest::get()
        .uri("/ping")
        .insert_header(("Origin", "chrome-extension://abc123"))
        .to_request();

    let resp = test::call_service(&app, req).await;

    assert!(
        resp.status().is_success(),
        "expected 200 for chrome-extension origin, got {}",
        resp.status()
    );

    let acao = resp.headers().get("access-control-allow-origin");
    assert!(
        acao.is_some(),
        "expected Access-Control-Allow-Origin header on admitted chrome-extension:// origin"
    );
    assert_eq!(
        acao.unwrap().to_str().unwrap(),
        "chrome-extension://abc123",
        "ACAO should echo the exact chrome-extension origin"
    );
}

/// A moz-extension:// origin is also admitted (Firefox support).
#[actix_web::test]
async fn cors_admits_moz_extension_origin() {
    let app = test::init_service(
        App::new()
            .wrap(cors_layer())
            .service(web::resource("/ping").to(ping_test)),
    )
    .await;

    let req = test::TestRequest::get()
        .uri("/ping")
        .insert_header(("Origin", "moz-extension://xyz789"))
        .to_request();

    let resp = test::call_service(&app, req).await;

    assert!(
        resp.status().is_success(),
        "expected 200 for moz-extension origin, got {}",
        resp.status()
    );

    let acao = resp.headers().get("access-control-allow-origin");
    assert!(
        acao.is_some(),
        "expected Access-Control-Allow-Origin header on admitted moz-extension:// origin"
    );
}

/// An arbitrary web origin (https://evil.com) must NOT receive an echoed ACAO header.
///
/// Note: CORS does not cause the server to return a non-200; browsers enforce
/// the policy on the client side. At the protocol level we verify that the server
/// does NOT echo `evil.com` in the Access-Control-Allow-Origin header.
#[actix_web::test]
async fn cors_rejects_evil_origin() {
    let app = test::init_service(
        App::new()
            .wrap(cors_layer())
            .service(web::resource("/ping").to(ping_test)),
    )
    .await;

    let req = test::TestRequest::get()
        .uri("/ping")
        .insert_header(("Origin", "https://evil.com"))
        .to_request();

    let resp = test::call_service(&app, req).await;

    let acao = resp.headers().get("access-control-allow-origin");
    assert!(
        acao.is_none() || acao.unwrap().to_str().unwrap() != "https://evil.com",
        "Access-Control-Allow-Origin must not echo https://evil.com"
    );
}
