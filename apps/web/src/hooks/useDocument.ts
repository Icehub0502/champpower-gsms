import { useEffect, useState } from 'react';
import { api } from '../lib/api/client';
import { getSocket } from '../lib/api/socket';

export interface DocumentState<T> {
  loading: boolean;
  data: T | null;
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
  const [state, setState] = useState<DocumentState<T>>({ loading: true, data: null });

  useEffect(() => {
    let cancelled = false;

    function load() {
      setState((s) => ({ ...s, loading: true }));
      api
        .get<T>(path)
        .then((data) => {
          if (!cancelled) setState({ loading: false, data });
        })
        .catch(() => {
          if (!cancelled) setState({ loading: false, data: null });
        });
    }

    load();

    const event = socketEvent ?? `${resourceSlug(path)}:changed`;
    const socket = getSocket();
    socket.on(event, load);
    return () => {
      cancelled = true;
      socket.off(event, load);
    };
  }, [path, socketEvent]);

  return state;
}
