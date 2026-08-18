import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from '../lib/firebase/client';

export type Role = 'admin' | 'staff';

export interface AuthState {
  loading: boolean;
  user: User | null;
  role: Role | null;
}

/**
 * Role comes from the ID token's custom claims (set by the createUser Cloud Function),
 * never from a client-writable Firestore document — see firebase/firestore.rules,
 * where users/{uid} is read-only from the client for exactly this reason.
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ loading: true, user: null, role: null });

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setState({ loading: false, user: null, role: null });
        return;
      }
      const token = await user.getIdTokenResult();
      const role = (token.claims.role as Role | undefined) ?? 'staff';
      setState({ loading: false, user, role });
    });
  }, []);

  return state;
}

export function isAdmin(state: Pick<AuthState, 'role'>): boolean {
  return state.role === 'admin';
}
