import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface TagCount {
  tag: string;
  count: number;
}

interface TagsResp { tags: TagCount[] }

export type TagScope = 'public' | 'mine';

/** Fetch the corpus tag-chip list for the given scope. No persistent cache:
 *  tag counts are small (≤ few KB) and only used while the user is on the
 *  Corpus page. Reloads whenever scope or invalidateNonce changes. */
export function useCorpusTags(scope: TagScope, invalidateNonce: number) {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await invoke<TagsResp>('corpus_tags', { scope });
        if (!cancelled) setTags(r.tags);
      } catch {
        if (!cancelled) setTags([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scope, invalidateNonce]);

  return { tags, loading };
}
