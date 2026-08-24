/// Compile-time backend origin. Release builds default to production; local
/// desktop verification can set WHATSUB_API_ORIGIN=http://127.0.0.1:3002.
pub const API_ORIGIN: &str = env!("WHATSUB_API_ORIGIN");
pub const API_BASE: &str = concat!(env!("WHATSUB_API_ORIGIN"), "/api");
pub const LICENSE_API_BASE: &str = env!("WHATSUB_LICENSE_API_BASE");
