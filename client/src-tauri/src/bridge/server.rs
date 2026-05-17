use actix_web::{App, HttpServer};
use actix_cors::Cors;
use tauri::AppHandle;
use std::io;
use super::{port, routes};

pub async fn run(app: AppHandle) -> io::Result<()> {
    let (chosen, listener) = match port::bind_loopback() {
        Some(x) => x,
        None => {
            eprintln!("[whatsub-bridge] no free port — all 4 candidates busy. Skipping bridge.");
            return Ok(());
        }
    };
    println!("[whatsub-bridge] listening on 127.0.0.1:{chosen}");
    let data = actix_web::web::Data::new(app);
    HttpServer::new(move || {
        let cors = Cors::default()
            .allowed_origin_fn(|origin, _| {
                origin.as_bytes().starts_with(b"chrome-extension://")
                    || origin.as_bytes().starts_with(b"moz-extension://")
            })
            .allowed_methods(vec!["GET", "POST", "DELETE"])
            .allow_any_header()
            .max_age(600);
        App::new()
            .app_data(data.clone())
            .wrap(cors)
            .configure(routes::configure)
    })
    .listen(listener)?
    .run()
    .await
}
