pub mod port;
pub mod server;
pub mod routes;
pub mod handoff;

use actix_web::dev::ServerHandle;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;

/// Per-app state for the bridge. Holds the running server's
/// `ServerHandle` when active. `bridge_set_enabled` reads + replaces
/// this to flip the bridge on/off at runtime without an app restart.
#[derive(Default)]
pub struct BridgeState {
    pub handle: Mutex<Option<ServerHandle>>,
}

/// Spawn the actix-web bridge on a new `std::thread` running its own
/// `actix_web::rt::System`. Blocks the spawning thread up to ~3s
/// waiting for the server to bind + send back its `ServerHandle`.
/// Returns `Some(handle)` on success; `None` if the bridge failed to
/// start (no free port / late panic).
pub fn start_bridge(app: AppHandle) -> Option<ServerHandle> {
    let (tx, rx) = std::sync::mpsc::channel::<ServerHandle>();
    std::thread::spawn(move || {
        let sys = actix_web::rt::System::new();
        sys.block_on(async move {
            match server::run(app, tx).await {
                Ok(()) => println!("[whatsub-bridge] stopped"),
                Err(e) => eprintln!("[whatsub-bridge] error: {e}"),
            }
        });
    });
    rx.recv_timeout(Duration::from_secs(3)).ok()
}

/// Runtime toggle for the bridge. Stops the running server (graceful)
/// when `enabled = false`; spawns a fresh server thread when
/// `enabled = true` and not already running. Returns the new state.
///
/// Idempotent: enabling an already-running bridge is a no-op,
/// disabling an already-stopped bridge is a no-op. The Settings UI
/// calls this after persisting `settings.bridgeEnabled`, so the
/// disk state + live state stay in sync.
#[tauri::command]
pub async fn bridge_set_enabled(
    app: AppHandle,
    state: tauri::State<'_, BridgeState>,
    enabled: bool,
) -> Result<bool, String> {
    if enabled {
        // Take a peek without holding the lock across the start_bridge
        // (which spawns a thread + waits up to 3s on channel recv).
        let already_running = state
            .handle
            .lock()
            .map_err(|e| e.to_string())?
            .is_some();
        if already_running {
            println!("[whatsub-bridge] already running, ignored");
            return Ok(true);
        }
        println!("[whatsub-bridge] starting (via toggle)...");
        let handle = start_bridge(app)
            .ok_or_else(|| "桥接启动失败:可能 4 个候选端口都被占用".to_string())?;
        let mut g = state.handle.lock().map_err(|e| e.to_string())?;
        *g = Some(handle);
        Ok(true)
    } else {
        // Take the handle OUT of the lock guard before awaiting stop()
        // — std::sync::Mutex guards aren't Send across await points.
        let handle_opt = {
            let mut g = state.handle.lock().map_err(|e| e.to_string())?;
            g.take()
        };
        match handle_opt {
            Some(handle) => {
                println!("[whatsub-bridge] stopping (via toggle)...");
                handle.stop(true).await; // graceful: drains in-flight reqs
                Ok(false)
            }
            None => {
                println!("[whatsub-bridge] already stopped, ignored");
                Ok(false)
            }
        }
    }
}
