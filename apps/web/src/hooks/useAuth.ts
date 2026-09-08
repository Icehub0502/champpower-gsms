import { useEffect, useSyncExternalStore } from 'react';
import { api, ApiError, TOKEN_KEY } from '../lib/api/client';
import { reconnectSocket } from '../lib/api/socket';

export type Role = 'admin' | 'staff';

/** Replaces firebase/auth's `User` as the type every consumer (AppShell, App.tsx)
 * uses for the current staff member. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  name?: string;
}

export interface AuthState {
  loading: boolean;
  user: AuthUser | null;
  role: Role | null;
}

export interface UseAuthResult extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

// Module-level store so every call site of useAuth() (App.tsx's shell, LoginPage,
// anything else) observes the same session instead of each keeping its own copy —
// this is what firebase's onAuthStateChanged gave us for free before; login()/logout()
// below are the only writers.
let currentState: AuthState = { loading: true, user: null, role: null };
let listeners: Array<() => void> = [];
let initialized = false;

function setState(next: AuthState): void {
  currentState = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners = [...listeners, listener];
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): AuthState {
  return currentState;
}

async function refreshAuth(): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    setState({ loading: false, user: null, role: null });
    return;
  }
  try {
    const user = await api.get<AuthUser>('/api/auth/me');
    setState({ loading: false, user, role: user.role });
  } catch {
    // Token missing/expired/invalid — drop it rather than keep retrying with it.
    localStorage.removeItem(TOKEN_KEY);
    setState({ loading: false, user: null, role: null });
  }
}

async function login(email: string, password: string): Promise<void> {
  const res = await api.post<{ token: string; user: AuthUser }>('/api/auth/login', { email, password });
  localStorage.setItem(TOKEN_KEY, res.token);
  reconnectSocket();
  setState({ loading: false, user: res.user, role: res.user.role });
}

function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  reconnectSocket();
  setState({ loading: false, user: null, role: null });
}

/**
 * Role comes back from GET /api/auth/me (trusting the server, not a client-decoded
 * JWT payload) every time a tab loads with a token in localStorage.
 */
export function useAuth(): UseAuthResult {
  const state = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (initialized) return;
    initialized = true;
    void refreshAuth();
  }, []);

  return { ...state, login, logout };
}

export function isAdmin(state: Pick<AuthState, 'role'>): boolean {
  return state.role === 'admin';
}

export { ApiError };
