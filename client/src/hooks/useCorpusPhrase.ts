import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCachedData, setCachedData, invalidate } from '../lib/corpusCache';

const KEY_PREFIX = 'phrase:';

export function useCorpusPhrase<T>(phraseNormalized: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!phraseNormalized) { setData(null); setError(null); return; }
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await invoke<T>('corpus_phrase_detail', { phrase: phraseNormalized });
      await setCachedData(`${KEY_PREFIX}${phraseNormalized}`, fresh);
      setData(fresh);
    } catch (e) {
      console.error('[useCorpusPhrase] refresh failed', phraseNormalized, e);
      setError(String(e));
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

  return { data, refreshing, error, refresh };
}

export async function invalidatePhrase(phraseNormalized: string): Promise<void> {
  await invalidate(`${KEY_PREFIX}${phraseNormalized}`);
}
