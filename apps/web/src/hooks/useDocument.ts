import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api/client';
import { getSocket } from '../lib/api/socket';
import { isSessionCancelled } from '../lib/api/sessionCancelled';

export interface DocumentState<T> {
  loading: boolean;
  data: T | null;
  /**
   * The LAST load failed. On a reload `data` is then the previous answer, kept
   * on purpose (a dropped refetch must not blank a screen mid-task); on the
   * first load it is null, exactly as before this flag existed.
   */
  error: boolean;
  /**
   * Fetch again now. For a screen whose own action changed the resource and
   * which cannot wait for a socket event (none is emitted for some resources —
   * e.g. a job moved by the quotation doors). Callers that ignore it behave
   * exactly as before.
   */
  reload?: () => void;
}

function resourceSlug(path: string): string {
  const seg = path.split('?')[0]?.split('/').filter(Boolean).pop() ?? '';
  return seg.endsWith('s') ? seg.slice(0, -1) : seg;
}

/**
 * Single-resource fetch + live refresh over Socket.io, replacing a Firestore doc
 * onSnapshot subscription (e.g. GET /api/config, the ShopConfig singleton). Singleton
 * resources have no `id`, so unlike useCollection we don't try to patch a specific
 * row — any `*:changed` event just triggers a refetch, which is correct regardless
 * of the exact payload shape the backend emits.
 *
 * Only the newest request's answer is applied: a slow earlier response (an
 * old socket refetch, a double reload) can never overwrite a later one.
 */
export function useDocument<T>(path: string, socketEvent?: string): DocumentState<T> {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: boolean }>({
    loading: true, data: null, error: false,
  });
  // The current effect's loader, so reload() always fetches the CURRENT path
  // under the current effect's cancellation flag.
  const loadRef = useRef<() => void>(() => {});
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Whether THIS path has answered once. Only then is there data worth
    // keeping through a failed refetch; a first load that fails stays null.
    let loadedOnce = false;

    function load() {
      const mine = ++seq.current;
      setState((s) => ({ ...s, loading: true }));
      api
        .get<T>(path)
        .then((data) => {
          if (cancelled || mine !== seq.current) return;
          loadedOnce = true;
          setState({ loading: false, data, error: false });
        })
        .catch((err: unknown) => {
          if (cancelled || mine !== seq.current || isSessionCancelled(err)) return;
          setState((s) => ({ loading: false, data: loadedOnce ? s.data : null, error: true }));
        });
    }

    loadRef.current = load;
    load();

    const event = socketEvent ?? `${resourceSlug(path)}:changed`;
    const socket = getSocket();
    socket.on(event, load);
    return () => {
      cancelled = true;
      loadRef.current = () => {};
      socket.off(event, load);
    };
  }, [path, socketEvent]);

  const reload = useCallback(() => loadRef.current(), []);

  return { ...state, reload };
}
