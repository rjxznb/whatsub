use std::net::{SocketAddr, TcpListener};

/// IANA Dynamic/Private range, sparse — see spec §6.1.
pub const BRIDGE_PORTS: &[u16] = &[51737, 53401, 59283, 62015];

/// Try each candidate in order; return (port, listener) for the first one that binds.
pub fn bind_loopback() -> Option<(u16, TcpListener)> {
    for &p in BRIDGE_PORTS {
        let addr: SocketAddr = ([127, 0, 0, 1], p).into();
        if let Ok(l) = TcpListener::bind(addr) {
            l.set_nonblocking(true).ok()?;
            return Some((p, l));
        }
    }
    None
}
