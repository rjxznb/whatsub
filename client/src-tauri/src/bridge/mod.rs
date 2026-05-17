pub mod port;
pub mod server;
pub mod routes;
pub mod handoff;

use tauri::AppHandle;

pub fn start_bridge(app: AppHandle) {
    std::thread::spawn(move || {
        let sys = actix_web::rt::System::new();
        sys.block_on(async move {
            if let Err(e) = server::run(app).await {
                eprintln!("[whatsub-bridge] server stopped: {e}");
            }
        });
    });
}
