import { useEffect, useState } from 'react';
import {
  collection,
  onSnapshot,
  query,
  type QueryConstraint,
} from 'firebase/firestore';
import { db } from '../lib/firebase/client';

export interface CollectionState<T> {
  loading: boolean;
  rows: T[];
  fromCache: boolean;
}

/**
 * Generic real-time collection subscription. `fromCache` is exposed (not hidden) so a
 * page can show an "offline — showing saved data" indicator instead of pretending the
 * data is fresh — the same signal the original app read off snapshot.metadata.
 */
export function useCollection<T extends { id: string }>(
  collectionPath: string,
  constraints: QueryConstraint[] = [],
): CollectionState<T> {
  const [state, setState] = useState<CollectionState<T>>({ loading: true, rows: [], fromCache: false });

  // Deliberately only re-subscribes on collectionPath. QueryConstraint objects aren't
  // stable across renders, so tracking them properly would need callers to memoize —
  // for now, pass a `key={...}` on the component using this hook if the filter changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const q = query(collection(db, collectionPath), ...constraints);
    const unsub = onSnapshot(q, (snap) => {
      const rows = snap.docs.map((d) => ({ ...(d.data() as Omit<T, 'id'>), id: d.id }) as T);
      setState({ loading: false, rows, fromCache: snap.metadata.fromCache });
    });
    return unsub;
  }, [collectionPath]);

  return state;
}
