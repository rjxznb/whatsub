import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCachedData, setCachedData, invalidate } from '../lib/corpusCache';

const KEY_PREFIX = 'phrase:';

export function useCorpusPhrase<T>(phraseNormalized: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!phraseNormalized) { setData(null); return; }
    setRefreshing(true);
    try {
      const fresh = await invoke<T>('corpus_phrase_detail', { phrase: phraseNormalized });
      await setCachedData(`${KEY_PREFIX}${phraseNormalized}`, fresh);
      setData(fresh);
    } catch {
      // keep stale
    } finally {
      setRefreshing(false);
    }
  }, [phraseNormalized]);

  useEffect(() => {
    let cancelled = false;
    if (!phraseNormalized) { setData(null); return; }
    (async () => {
      const cached = await getCachedData<T>(`${KEY_PREFIX}${phraseNormalized}`);
      if (cached && !cancelled) setData(cached);
      if (!cancelled) await refresh();
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phraseNormalized]);

  return { data, refreshing, refresh };
}

export async function invalidatePhrase(phraseNormalized: string): Promise<void> {
  await invalidate(`${KEY_PREFIX}${phraseNormalized}`);
}
