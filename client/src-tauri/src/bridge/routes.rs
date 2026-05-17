use actix_web::{web, HttpResponse, Responder};
use serde::Serialize;
use tauri::AppHandle;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/ping").to(ping));
}

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
