import { invoke } from '@tauri-apps/api/core';

// Corpus SWR cache. Backed by a plain JSON file at %APPDATA%/whatsub/
// corpus_cache.json (via the corpus_cache_load/save Rust commands) so it lives
// in the same unified dir as settings/license/auth — NOT the tauri-plugin-store
// bundle-identifier dir (com.whatsub.app/) it used to use. The Rust side
// migrates the legacy plugin-store file on first load.
//
// The whole cache is a small {key: value} map; we hold it in memory after a
// one-time load and persist the full map on every mutation (file is a few KB).

let _cache: Record<string, unknown> | null = null;
let _loading: Promise<Record<string, unknown>> | null = null;

async function load(): Promise<Record<string, unknown>> {
  if (_cache) return _cache;
  if (!_loading) {
    _loading = (async () => {
      try {
        const raw = await invoke<string>('corpus_cache_load');
        _cache = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        _cache = {};
      }
      return _cache;
    })();
  }
  return _loading;
}

async function persist(): Promise<void> {
  if (!_cache) return;
  try {
    await invoke('corpus_cache_save', { contents: JSON.stringify(_cache) });
  } catch {
    /* best-effort cache write — a failed persist just means a stale-cache
       refetch next launch, never a user-visible error */
  }
}

export type VersionKey = 'mineVersion' | 'publicVersion';

export async function getCachedVersion(key: VersionKey): Promise<number> {
  const c = await load();
  const v = c[key];
  return typeof v === 'number' ? v : 0;
}

export async function setCachedVersion(key: VersionKey, v: number): Promise<void> {
  const c = await load();
  c[key] = v;
  await persist();
}

export async function getCachedData<T>(key: string): Promise<T | null> {
  const c = await load();
  return (c[key] as T | undefined) ?? null;
}

export async function setCachedData<T>(key: string, data: T): Promise<void> {
  const c = await load();
  c[key] = data;
  await persist();
}

export async function invalidate(...keys: string[]): Promise<void> {
  const c = await load();
  for (const k of keys) delete c[k];
  await persist();
}

export async function invalidateAll(): Promise<void> {
  _cache = {};
  await persist();
}
