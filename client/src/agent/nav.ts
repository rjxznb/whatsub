// src/agent/nav.ts
//
// Tiny module-level bridge between the AI Agent's navigation tools and
// React Router. App.tsx (T26) calls `setNavigator(useNavigate())` once
// on mount; tools call `navigate("/library")` etc. without importing any
// React/Router internals.
//
// If `navigate` is called before the navigator is registered (e.g. during
// tests or before App.tsx has mounted), we warn and no-op rather than
// throwing so tools remain safe to invoke in any context.

let _navigate: ((to: string) => void) | null = null;

export function setNavigator(fn: ((to: string) => void) | null): void {
  _navigate = fn;
}

export function navigate(to: string): void {
  if (_navigate) {
    _navigate(to);
  } else {
    // eslint-disable-next-line no-console
    console.warn("[agent/nav] navigate called before setNavigator:", to);
  }
}
