use actix_web::{dev::ServerHandle, App, HttpServer};
use actix_cors::Cors;
use tauri::AppHandle;
use std::io;
use std::sync::mpsc::Sender;
use super::{port, routes};

/// Run the bridge HTTP server. Sends the `ServerHandle` back through
/// the provided channel as soon as the server is bound + running, so
/// the caller can hold it and later call `handle.stop(true).await` to
/// gracefully shut the server down at runtime (e.g. when the user
/// toggles `bridgeEnabled` off in Settings).
///
/// The channel is one-shot semantics: caller does `rx.recv_timeout()`
/// to grab the handle, then drops the rx. Server.await blocks until
/// stop() is called or the process exits.
pub async fn run(app: AppHandle, handle_tx: Sender<ServerHandle>) -> io::Result<()> {
    let (chosen, listener) = match port::bind_loopback() {
        Some(x) => x,
        None => {
            eprintln!("[whatsub-bridge] no free port — all 4 candidates busy. Skipping bridge.");
            return Ok(());
        }
    };
    println!("[whatsub-bridge] listening on 127.0.0.1:{chosen}");
    let data = actix_web::web::Data::new(app);
    let server = HttpServer::new(move || {
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
    .run();

    // Hand the controller back to the spawning thread BEFORE we await
    // the server (await consumes it). If the caller already dropped
    // the rx, send fails silently — the server still runs, we just
    // can't stop it gracefully (process exit is the fallback).
    let _ = handle_tx.send(server.handle());

    server.await
}
