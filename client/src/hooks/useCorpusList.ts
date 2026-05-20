import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  getCachedVersion, setCachedVersion,
  getCachedData, setCachedData,
} from '../lib/corpusCache';

export type Scope =
  | { mode: 'mine'; tags: string[] }
  | { mode: 'browse'; tags: string[] };

interface VersionsResp { mine: number; public: number }

function scopeId(scope: Scope): string {
  // Sorted so [a,b] and [b,a] hit the same cache slot.
  const tagSig = [...scope.tags].sort().join(',');
  return `${scope.mode}:${tagSig}`;
}

function cacheKeyForScope(scope: Scope): string {
  return scope.mode === 'mine'
    ? `mineData:${[...scope.tags].sort().join(',')}`
    : `publicData:${[...scope.tags].sort().join(',')}`;
}

export function useCorpusList<T>(scope: Scope) {
  const [data, setData] = useState<T | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sid = scopeId(scope);

  const refresh = useCallback(async (force: boolean) => {
    setRefreshing(true);
    setError(null);
    try {
      const serverV: VersionsResp = await invoke('corpus_versions');
      const versionKey = scope.mode === 'mine' ? 'mineVersion' : 'publicVersion';
      const cachedV = await getCachedVersion(versionKey);
      const serverVal = scope.mode === 'mine' ? serverV.mine : serverV.public;
      if (!force && cachedV === serverVal && cachedV > 0) {
        return;
      }
      const fresh = scope.mode === 'mine'
        ? await invoke<T>('corpus_mine', { tags: scope.tags, pageSize: 100 })
        : await invoke<T>('corpus_browse', { tags: scope.tags, pageSize: 100 });
      await setCachedData(cacheKeyForScope(scope), fresh);
      await setCachedVersion(versionKey, serverVal);
      setData(fresh);
    } catch (e) {
      console.error('[useCorpusList] refresh failed', scope, e);
      setError(String(e));
    } finally {
      setRefreshing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await getCachedData<T>(cacheKeyForScope(scope));
      if (cached && !cancelled) setData(cached);
      if (!cancelled) await refresh(false);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  return { data, refreshing, error, refresh: () => refresh(true) };
}
