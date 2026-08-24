/** Backend origin is production by default; local desktop verification can
 * set VITE_WHATSUB_API_ORIGIN=http://127.0.0.1:3002 without changing release
 * behavior or putting credentials in URLs. */
export const API_ORIGIN = (
  import.meta.env.VITE_WHATSUB_API_ORIGIN ?? "https://whatsub.eversay.cc"
).replace(/\/$/, "");

export const API_BASE = `${API_ORIGIN}/api`;
export const LICENSE_API_BASE = `${API_BASE}/license`;
