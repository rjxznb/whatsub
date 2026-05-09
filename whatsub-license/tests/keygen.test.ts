import { describe, it, expect } from 'vitest';
import {
  generateLicenseKey,
  looksLikeKey,
  normalizeKey,
} from '../src/lib/keygen.js';

describe('keygen', () => {
  it('generateLicenseKey returns a WHATSUB-XXXX-XXXX-XXXX-XXXX shape', () => {
    const k = generateLicenseKey();
    expect(k).toMatch(/^WHATSUB(-[2-9A-HJ-NP-Z]{4}){4}$/);
  });

  it('generateLicenseKey is non-deterministic across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateLicenseKey());
    expect(seen.size).toBe(100); // 31^16 collision space → 100 must all differ
  });

  it('looksLikeKey accepts canonical, rejects junk', () => {
    expect(looksLikeKey('WHATSUB-ABCD-EFGH-JKMN-PQRS')).toBe(true);
    expect(looksLikeKey('whatsub-abcd-efgh-jkmn-pqrs')).toBe(true); // case-insensitive
    expect(looksLikeKey(' WHATSUB-ABCD-EFGH-JKMN-PQRS ')).toBe(true); // trims
    expect(looksLikeKey('GARBAGE')).toBe(false);
    expect(looksLikeKey('WHATSUB-ABCD-EFGH-JKMN')).toBe(false); // missing group
    expect(looksLikeKey('WHATSUB-ABC1-EFGH-JKMN-PQRS')).toBe(false); // '1' excluded
  });

  it('normalizeKey trims + uppercases', () => {
    expect(normalizeKey('  whatsub-abcd-efgh-jkmn-pqrs  ')).toBe(
      'WHATSUB-ABCD-EFGH-JKMN-PQRS',
    );
  });
});
