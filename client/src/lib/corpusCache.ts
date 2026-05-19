import { LazyStore } from '@tauri-apps/plugin-store';

const CACHE_FILE = 'corpus_cache.json';
let _store: LazyStore | null = null;

function store(): LazyStore {
  if (!_store) _store = new LazyStore(CACHE_FILE);
  return _store;
}

export type VersionKey = 'mineVersion' | 'publicVersion';

export async function getCachedVersion(key: VersionKey): Promise<number> {
  const v = await store().get<number>(key);
  return typeof v === 'number' ? v : 0;
}

export async function setCachedVersion(key: VersionKey, v: number): Promise<void> {
  await store().set(key, v);
  await store().save();
}

export async function getCachedData<T>(key: string): Promise<T | null> {
  const v = await store().get<T>(key);
  return v ?? null;
}

export async function setCachedData<T>(key: string, data: T): Promise<void> {
  await store().set(key, data);
  await store().save();
}

export async function invalidate(...keys: string[]): Promise<void> {
  for (const k of keys) await store().delete(k);
  await store().save();
}

export async function invalidateAll(): Promise<void> {
  await store().clear();
  await store().save();
}
