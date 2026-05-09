'use client';

import { useEffect, useState } from 'react';

export interface LatestVersion {
  version: string | null;
  pubDate: string | null;
  winUrl: string | null;
  macUrl: string | null;
}

const FALLBACK: LatestVersion = {
  version: '0.1.26',
  pubDate: null,
  winUrl: null,
  macUrl: null,
};

/**
 * Fetches /api/license/latest (same-origin, served by the whatsub-license
 * backend on Aliyun). Returns the latest published version + asset URLs
 * for the version chip and the Download section.
 *
 * Falls back to a hardcoded version on error so the page never breaks
 * even when the API is unavailable. Hardcoded value should be bumped
 * alongside each release (cheap insurance — the page is already
 * shipped a moment later anyway).
 *
 * Returns `null` on first render (no flicker of stale fallback) and
 * the resolved data thereafter.
 */
export function useLatestVersion(): LatestVersion | null {
  const [data, setData] = useState<LatestVersion | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/license/latest')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        setData({
          version: json.version ?? FALLBACK.version,
          pubDate: json.pubDate ?? null,
          winUrl: json.winUrl ?? null,
          macUrl: json.macUrl ?? null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setData(FALLBACK);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return data;
}
