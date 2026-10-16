import { useEffect, useRef, useState } from 'react';
import type { CatalogSearchResult } from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';

const DEBOUNCE_MS = 200;
/** The API answers from the 2nd character (CatalogSearchQuery.q min 2, owner decision 16). */
export const MIN_QUERY = 2;

export interface CatalogSearchState {
  result: CatalogSearchResult | null;
  loading: boolean;
  error: boolean;
}

/**
 * GET /api/catalog/search for what is typed, a moment after typing stops.
 * Sequence-numbered so a slow answer to "ลูก" can never replace the answer to
 * "ลูกหมาก". The ranking (sets, shop favourites, this car's offered items) and
 * the price for THIS car are the server's (v2 §7, §4.3) — nothing is re-sorted
 * or priced here.
 */
export function useCatalogSearch(jobId: string, query: string): CatalogSearchState {
  // The last answer, tagged with the query it answers. "Loading" is derived —
  // an answer for a different query than the one typed now — so the effect
  // never has to set state synchronously.
  const [answer, setAnswer] = useState<{ q: string; result: CatalogSearchResult | null; error: boolean } | null>(null);
  const seq = useRef(0);
  const q = query.trim();

  useEffect(() => {
    const mine = ++seq.current;
    if (q.length < MIN_QUERY) return;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q, jobId });
      api
        .get<CatalogSearchResult>(`/api/catalog/search?${params.toString()}`)
        .then((result) => {
          if (mine === seq.current) setAnswer({ q, result, error: false });
        })
        .catch((err: unknown) => {
          if (isSessionCancelled(err) || mine !== seq.current) return;
          setAnswer({ q, result: null, error: true });
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [jobId, q]);

  if (q.length < MIN_QUERY) return { result: null, loading: false, error: false };
  if (!answer || answer.q !== q) return { result: answer?.result ?? null, loading: true, error: false };
  return { result: answer.result, loading: false, error: answer.error };
}
