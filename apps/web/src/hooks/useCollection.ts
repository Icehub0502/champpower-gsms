import { useEffect, useState } from 'react';
import { api } from '../lib/api/client';
import { getSocket } from '../lib/api/socket';

export interface CollectionState<T> {
  loading: boolean;
  rows: T[];
  fromCache: boolean;
}

/** '/api/master-parts' -> 'master-part', '/api/jobs' -> 'job', '/api/models?x=1' -> 'model' */
function resourceSlug(path: string): string {
  const seg = path.split('?')[0]?.split('/').filter(Boolean).pop() ?? '';
  if (seg.endsWith('ies')) return `${seg.slice(0, -3)}y`;
  if (seg.endsWith('s')) return seg.slice(0, -1);
  return seg;
}

function toCamel(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Generic collection fetch + live patching over Socket.io, replacing the old
 * Firestore onSnapshot subscription. `fromCache` is always false post-migration —
 * there's no offline cache layer anymore, kept only so callers don't need touching.
 *
 * Socket payload contract (locked for `job:changed` as `{ id, job }`; assumed to
 * generalize the same way for vehicle/customer/model/master-part per the backend
 * spec's "every mutation handler emits the full changed row" rule). If an event
 * payload doesn't carry the expected `{ id, <resource> }` shape (e.g. a hard delete,
 * or a resource this guess doesn't match), we fall back to a full refetch instead of
 * guessing — safer than silently corrupting local state.
 */
export function useCollection<T extends { id: string }>(path: string, socketEvent?: string): CollectionState<T> {
  const [state, setState] = useState<CollectionState<T>>({ loading: true, rows: [], fromCache: false });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));

    function refetch() {
      api
        .get<T[]>(path)
        .then((rows) => {
          if (!cancelled) setState({ loading: false, rows, fromCache: false });
        })
        .catch(() => {
          if (!cancelled) setState({ loading: false, rows: [], fromCache: false });
        });
    }

    refetch();

    const slug = resourceSlug(path);
    const event = socketEvent ?? `${slug}:changed`;
    const payloadKey = toCamel(slug);
    const socket = getSocket();

    function onChanged(payload: unknown) {
      const p = payload as Record<string, unknown> | undefined;
      const id = p && typeof p.id === 'string' ? p.id : undefined;
      const changed = p ? (p[payloadKey] as T | undefined) : undefined;
      if (id && changed) {
        setState((s) => {
          const idx = s.rows.findIndex((r) => r.id === id);
          const rows = idx >= 0 ? s.rows.map((r, i) => (i === idx ? changed : r)) : [...s.rows, changed];
          return { ...s, rows };
        });
        return;
      }
      // Unrecognized/removal payload — refetch to stay correct instead of guessing.
      refetch();
    }

    socket.on(event, onChanged);
    return () => {
      cancelled = true;
      socket.off(event, onChanged);
    };
  }, [path, socketEvent]);

  return state;
}
