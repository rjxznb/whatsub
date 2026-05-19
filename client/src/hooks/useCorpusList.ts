import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  getCachedVersion, setCachedVersion,
  getCachedData, setCachedData,
} from '../lib/corpusCache';

export type Scope = { mode: 'mine' } | { mode: 'browse'; scene: string };

interface VersionsResp { mine: number; public: number }

function cacheKeyForScope(scope: Scope): string {
  return scope.mode === 'mine' ? 'mineData' : `publicData:${scope.scene}`;
}

function scopeId(scope: Scope): string {
  return scope.mode === 'mine' ? 'mine' : scope.scene;
}

export function useCorpusList<T>(scope: Scope) {
  const [data, setData] = useState<T | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const sid = scopeId(scope);

  const refresh = useCallback(async (force: boolean) => {
    setRefreshing(true);
    try {
      const serverV: VersionsResp = await invoke('corpus_versions');
      const versionKey = scope.mode === 'mine' ? 'mineVersion' : 'publicVersion';
      const cachedV = await getCachedVersion(versionKey);
      const serverVal = scope.mode === 'mine' ? serverV.mine : serverV.public;
      if (!force && cachedV === serverVal && cachedV > 0) {
        return;
      }
      const fresh = scope.mode === 'mine'
        ? await invoke<T>('corpus_mine', { pageSize: 100 })
        : await invoke<T>('corpus_browse', { scene: (scope as { mode: 'browse'; scene: string }).scene, pageSize: 100 });
      await setCachedData(cacheKeyForScope(scope), fresh);
      await setCachedVersion(versionKey, serverVal);
      setData(fresh);
    } catch {
      // Network/auth/license error → keep showing cached data if any.
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

  return { data, refreshing, refresh: () => refresh(true) };
}
