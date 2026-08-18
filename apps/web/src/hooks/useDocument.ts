import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../lib/firebase/client';

export interface DocumentState<T> {
  loading: boolean;
  data: T | null;
}

/** Real-time subscription to a single document, e.g. config/main. */
export function useDocument<T>(path: string, id: string): DocumentState<T> {
  const [state, setState] = useState<DocumentState<T>>({ loading: true, data: null });

  useEffect(() => {
    const ref = doc(db, path, id);
    const unsub = onSnapshot(ref, (snap) => {
      setState({ loading: false, data: snap.exists() ? (snap.data() as T) : null });
    });
    return unsub;
  }, [path, id]);

  return state;
}
