// whatsub-license/src/lib/types.ts

/** One issued license key. */
export interface LicenseRow {
  key: string;
  max_devices: number;
  created_at: number; // unix ms
  buyer_note: string | null;
  email: string | null;
}

/** One (license, device) activation slot. */
export interface ActivationRow {
  id: number; // BIGSERIAL — fits in JS number for the foreseeable future
  license_key: string;
  fingerprint: string;
  device_label: string | null;
  activated_at: number; // unix ms
  last_seen_at: number; // unix ms
  deactivated_at: number | null; // unix ms; null = slot still active
}

/** A license + an aggregate count, for the admin license-list endpoint. */
export interface LicenseListItem extends LicenseRow {
  active_devices: number;
}
