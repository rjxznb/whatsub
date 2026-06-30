import { invoke } from "@tauri-apps/api/core";

export interface CookieSiteStatus {
  siteKey: string;
  label: string;
  exists: boolean;
  expired: boolean;
  expiringSoon: boolean;
  expiresAt: number | null;
}

export function cookieStatusFor(siteKey: string): Promise<CookieSiteStatus> {
  return invoke<CookieSiteStatus>("cookies_status", { siteKey });
}
