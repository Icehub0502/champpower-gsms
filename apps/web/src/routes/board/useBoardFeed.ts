import { useEffect, useState } from 'react';
import type { PublicBoardResponse } from '@gsms/contracts/index.js';
import { ApiError, publicApi } from '../../lib/api/client';

// GET /api/public/board/:token, polled. See BoardPage.tsx for what this screen
// must never do; this file is only the fetching.

const POLL_MS = 20_000;
/** A 404 means the link is wrong or was rotated. It will not fix itself soon,
 * but checking rarely costs nothing and recovers if it was a blip. */
const NOT_FOUND_POLL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Delay before the next request after `failures` consecutive errors:
 * 20s, then 40s, 80s, 160s, capped at 5 minutes — never hammering a server
 * that is already struggling. Exported for the test. */
export function nextDelayMs(failures: number): number {
  if (failures <= 0) return POLL_MS;
  return Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
}

export type FeedState =
  | { kind: 'loading' }
  | { kind: 'ok'; data: PublicBoardResponse }
  | { kind: 'not_found' }
  | { kind: 'error'; data: PublicBoardResponse | null };

export function useBoardFeed(token: string | undefined): FeedState {
  const [state, setState] = useState<FeedState>({ kind: 'loading' });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;

    // One request at a time: the next is scheduled only after this one settles,
    // so a slow server never has several polls from the same TV stacked on it.
    async function tick() {
      let delay = POLL_MS;
      try {
        const data = await publicApi.get<PublicBoardResponse>(`/api/public/board/${encodeURIComponent(token!)}`);
        if (cancelled) return;
        failures = 0;
        setState({ kind: 'ok', data });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // A dead link must not keep showing the last board it loaded.
          failures = 0;
          delay = NOT_FOUND_POLL_MS;
          setState({ kind: 'not_found' });
        } else {
          failures += 1;
          delay = nextDelayMs(failures);
          setState((prev) => ({ kind: 'error', data: prev.kind === 'ok' || prev.kind === 'error' ? prev.data : null }));
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), delay);
    }

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [token]);

  return state;
}

