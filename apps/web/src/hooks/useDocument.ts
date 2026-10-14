import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api/client';
import { getSocket } from '../lib/api/socket';
import { isSessionCancelled } from '../lib/api/sessionCancelled';

export interface DocumentState<T> {
  loading: boolean;
  data: T | null;
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
 */
export function useDocument<T>(path: string, socketEvent?: string): DocumentState<T> {
  const [state, setState] = useState<{ loading: boolean; data: T | null }>({ loading: true, data: null });
  // The current effect's loader, so reload() always fetches the CURRENT path
  // under the current effect's cancellation flag.
  const loadRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;

    function load() {
      setState((s) => ({ ...s, loading: true }));
      api
        .get<T>(path)
        .then((data) => {
          if (!cancelled) setState({ loading: false, data });
        })
        .catch((err: unknown) => {
          if (!cancelled && !isSessionCancelled(err)) setState({ loading: false, data: null });
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
