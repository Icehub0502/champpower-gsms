import { useEffect, useSyncExternalStore } from 'react';
import type { AuthUser, Role, ShopMembership } from '@gsms/contracts/index.js';
import { ApiError, api, authFetch, getAccessToken, refreshAccessToken, setAccessToken, setRefreshResultHandler } from '../lib/api/client';
import { reconnectSocket } from '../lib/api/socket';

export type { AuthUser, Role, ShopMembership };

export interface AuthState {
  /** "Checking" — WO-004/T6 condition 7. True only while the very first
   * silent refresh (from the httpOnly cookie) is in flight, at app boot.
   * App.tsx must render neither the login page nor an authed page while this
   * is true, or an authenticated page flashes before a redirect (or a
   * signed-in user flashes the login form) on every reload. */
  loading: boolean;
  user: AuthUser | null;
  shop: ShopMembership | null;
  shops: ShopMembership[];
  role: Role | null;
}

export interface UseAuthResult extends AuthState {
  login: (loginId: string, password: string, shopId?: string) => Promise<void>;
  switchShop: (shopId: string) => Promise<void>;
  logout: () => Promise<void>;
}

interface AuthPayload {
  accessToken: string;
  user?: AuthUser;
  shop: ShopMembership;
  shops?: ShopMembership[];
}

// Module-level store so every call site of useAuth() (App.tsx's shell, LoginPage,
// anything else) observes the same session instead of each keeping its own copy —
// login()/switchShop()/logout() below are the only writers.
let currentState: AuthState = { loading: true, user: null, shop: null, shops: [], role: null };
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

function clearSignedIn(): void {
  setAccessToken(null);
  setState({ loading: false, user: null, shop: null, shops: [], role: null });
}

async function parseAuthError(res: Response): Promise<ApiError> {
  let message = res.statusText || `Request failed (${res.status})`;
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === 'string' && data.error) message = data.error;
  } catch {
    // Non-JSON body — keep the status-text fallback.
  }
  return new ApiError(res.status, message);
}

/**
 * The very first thing the app does. There is no token anywhere in the
 * browser's own storage to read (condition 1) — the only way to find out
 * "is someone signed in" is to ask the server, and the only thing the server
 * can go on is the httpOnly refresh cookie it may or may not receive back.
 * A missing/expired/revoked cookie is not an error here, just "signed out".
 */
async function bootstrap(): Promise<void> {
  const ok = await refreshAccessToken();
  if (!ok) {
    setState({ loading: false, user: null, shop: null, shops: [], role: null });
    return;
  }
  // refreshAccessToken() only rotates the token; /me fills in who + which shop.
  try {
    const me = await api.get<{ user: AuthUser; shop: ShopMembership; shops: ShopMembership[] }>('/api/auth/me');
    setState({ loading: false, user: me.user, shop: me.shop, shops: me.shops, role: me.shop.role });
  } catch {
    clearSignedIn();
  }
}

// Wired once so that a 401-triggered background refresh (apps/web/src/lib/api/
// client.ts, mid-session, not at boot) that comes back negative also signs the
// user out here — otherwise the UI would keep showing a "signed in" shell
// against a server that has already forgotten the session.
setRefreshResultHandler((ok, accessToken) => {
  if (!ok) {
    clearSignedIn();
    reconnectSocket();
    return;
  }
  if (accessToken) setAccessToken(accessToken);
});

async function login(loginId: string, password: string, shopId?: string): Promise<void> {
  const res = await authFetch('POST', '/api/auth/login', {
    body: { loginId, password, shopId },
    auth: false,
  });
  if (!res.ok) throw await parseAuthError(res);
  const data = (await res.json()) as AuthPayload;
  setAccessToken(data.accessToken);
  reconnectSocket();
  setState({
    loading: false,
    user: data.user ?? null,
    shop: data.shop,
    shops: data.shops ?? [data.shop],
    role: data.shop.role,
  });
}

/**
 * WO-004/T6 condition 4. This function only changes which branch the
 * session acts for and updates the store — it does not know about, and must
 * not need to know about, every useCollection/useDocument instance mounted
 * under it. App.tsx keys the authed route tree on `shop.id` (see the comment
 * there), so the state change this triggers unmounts and remounts the whole
 * tree, which is what actually discards every component's cached rows: there
 * is no separate query cache object in this codebase to clear by hand.
 */
async function switchShop(shopId: string): Promise<void> {
  const res = await authFetch('POST', '/api/auth/switch-shop', {
    body: { shopId },
  });
  if (!res.ok) throw await parseAuthError(res);
  const data = (await res.json()) as AuthPayload;
  setAccessToken(data.accessToken);
  reconnectSocket();
  setState({
    ...currentState,
    loading: false,
    shop: data.shop,
    role: data.shop.role,
  });
}

async function logout(): Promise<void> {
  // Revoke server-side first (condition 5) — a local-only "forget the token"
  // would leave the session (and the refresh cookie) alive, so it could keep
  // renewing itself from another tab or a copied cookie.
  try {
    if (getAccessToken()) {
      await authFetch('POST', '/api/auth/logout', { body: {} });
    }
  } catch {
    // Best-effort: whether or not the server call lands, the client forgets
    // its side of the session below. A network failure here must not trap a
    // user who is trying to sign out.
  }
  clearSignedIn();
  reconnectSocket();
}

/**
 * Role and shop come back from GET /api/auth/me (trusting the server, not a
 * client-decoded JWT payload) once per app load, right after the boot-time
 * cookie-based refresh.
 */
export function useAuth(): UseAuthResult {
  const state = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (initialized) return;
    initialized = true;
    void bootstrap();
  }, []);

  return { ...state, login, switchShop, logout };
}

/**
 * Kept as `isAdmin` — the name every call site (ModelsPage, JobListPage,
 * UsersPage, ...) already imports — but the check underneath is now honest
 * against the real seven-role set (CLAUDE.md §12.1) instead of the old
 * `'admin' | 'staff'` fiction. CLAUDE.md §12.1's matrix draws the "can manage
 * catalog/settings" line at `owner`/`manager`; `assistant_manager` is
 * deliberately excluded here even though it can approve stock adjustments and
 * evaluate staff, because user administration and shop settings are the two
 * things §12.2 carves out as manager-and-above-only, not
 * assistant-manager-and-above.
 *
 * Every current call site is on a page WO-004/T6 has not ported yet (catalog,
 * settings, stuck-jobs) or has not fully ported (JobListPage/JobDetailPage) —
 * see App.tsx's placeholder routes — so this cannot be proven against a live
 * screen yet. It is still correct to fix now rather than leave the old
 * `'admin'` string comparison (which can never be true against any real role
 * and would silently hide these controls from every owner and manager).
 */
export function isAdmin(state: Pick<AuthState, 'role'>): boolean {
  return state.role === 'owner' || state.role === 'manager';
}

export { ApiError };
