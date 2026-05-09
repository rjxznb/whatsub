import { webcrypto } from 'node:crypto';

/**
 * License key generator.
 *
 * Format: WHATSUB-XXXX-XXXX-XXXX-XXXX
 *   - 4 groups of 4 chars from a 31-char alphabet (excludes 0/O/1/I/L)
 *   - 31^16 ≈ 10^24 combinations → trivially unguessable
 *   - "WHATSUB-" prefix makes keys self-identifying when pasted
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const GROUP_LEN = 4;
const NUM_GROUPS = 4;

export function generateLicenseKey(): string {
  const bytes = new Uint8Array(GROUP_LEN * NUM_GROUPS);
  webcrypto.getRandomValues(bytes);

  const chars: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    // Non-null assert is safe: i is bounded by bytes.length above.
    chars.push(ALPHABET[bytes[i]! % ALPHABET.length]!);
  }
  const groups: string[] = [];
  for (let g = 0; g < NUM_GROUPS; g++) {
    groups.push(chars.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN).join(''));
  }
  return `WHATSUB-${groups.join('-')}`;
}

/** Lightweight format check before hitting the database. */
export function looksLikeKey(s: string): boolean {
  return /^WHATSUB(-[2-9A-HJ-NP-Z]{4}){4}$/i.test(s.trim());
}

/** Normalize for storage / lookup. Uppercase + trim. */
export function normalizeKey(s: string): string {
  return s.trim().toUpperCase();
}
