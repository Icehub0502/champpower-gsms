import { useEffect, useSyncExternalStore } from 'react';
import type { AuthUser, Role, ShopMembership } from '@gsms/contracts/index.js';
import {
  ApiError, api, authFetch, beginLogout, endLogout, getSessionEpoch, invalidateSession, isSessionCancelled, refreshAccessToken,
  setAccessToken, setRefreshResultHandler,
} from '../lib/api/client';
import { reconnectSocket } from '../lib/api/socket';
import { SessionCancelledError } from '../lib/api/sessionCancelled';

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
  /** Set when the last logout could not be confirmed by the server. The local
   * session is gone either way; this tells the person at the login screen that
   * the server-side session may still be alive. Cleared by the next login. */
  logoutError: string | null;
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
let currentState: AuthState = { loading: true, user: null, shop: null, shops: [], role: null, logoutError: null };
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

const LOGOUT_FAILED_MESSAGE = 'ออกจากระบบไม่สำเร็จ กรุณาปิดเบราว์เซอร์';

function clearSignedIn(logoutError: string | null = null): void {
  // Ends the session generation first: nothing still in flight for the user
  // who is leaving may install a token or sign the next user out.
  invalidateSession();
  setAccessToken(null);
  setState({ loading: false, user: null, shop: null, shops: [], role: null, logoutError });
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
  const epoch = getSessionEpoch();
  const ok = await refreshAccessToken();
  // Someone logged in (or out) while the boot refresh was on the wire — that
  // newer state wins; this answer is about a session that no longer applies.
  if (epoch !== getSessionEpoch()) return;
  if (!ok) {
    setState({ loading: false, user: null, shop: null, shops: [], role: null, logoutError: null });
    return;
  }
  try {
    const me = await api.get<{ user: AuthUser; shop: ShopMembership; shops: ShopMembership[] }>('/api/auth/me');
    if (epoch !== getSessionEpoch()) return;
    setState({
      loading: false, user: me.user, shop: me.shop, shops: me.shops, role: me.shop.role, logoutError: null,
    });
  } catch (err) {
    if (isSessionCancelled(err)) return;
    clearSignedIn();
  }
}

// Wired once so that a 401-triggered background refresh (apps/web/src/lib/api/
// client.ts, mid-session, not at boot) that comes back negative also signs the
// user out here — otherwise the UI would keep showing a "signed in" shell
// against a server that has already forgotten the session.
// (client.ts installs the new token itself before reporting success, so only the
// failure case needs handling here.)
setRefreshResultHandler((ok) => {
  if (ok) return;
  clearSignedIn();
  reconnectSocket();
});

async function login(loginId: string, password: string, shopId?: string): Promise<void> {
  // A logout still on the wire must finish first: its cookie-clearing response
  // arriving after this login's Set-Cookie would wipe the NEW session's cookie.
  if (logoutPromise) await logoutPromise;
  const res = await authFetch('POST', '/api/auth/login', {
    body: { loginId, password, shopId },
    auth: false,
  });
  if (!res.ok) throw await parseAuthError(res);
  const data = (await res.json()) as AuthPayload;
  // New identity: cancel whatever the previous one still has in flight before
  // its token is replaced.
  invalidateSession();
  setAccessToken(data.accessToken);
  reconnectSocket();
  setState({
    loading: false,
    user: data.user ?? null,
    shop: data.shop,
    shops: data.shops ?? [data.shop],
    role: data.shop.role,
    logoutError: null,
  });
}

/**
 * WO-004/T6 condition 4. This function only changes which branch the
 * session acts for and updates the store — it does not know about, and must
 * not need to know about, every useCollection/useDocument instance mounted
 * under it. App.tsx keys the authed route tree on `user.id:shop.id` (see the
 * comment there), so the state change this triggers unmounts and remounts the
 * whole tree, which is what actually discards every component's cached rows:
 * there is no separate query cache object in this codebase to clear by hand.
 *
 * Like login/logout it is guarded by the session epoch: if the session changed
 * while the request was on the wire (logout, another login), the answer belongs
 * to a session that no longer exists and is dropped with SessionCancelledError.
 */
async function switchShop(shopId: string): Promise<void> {
  const epoch = getSessionEpoch();
  const res = await authFetch('POST', '/api/auth/switch-shop', {
    body: { shopId },
  });
  if (epoch !== getSessionEpoch()) throw new SessionCancelledError();
  if (!res.ok) throw await parseAuthError(res);
  const data = (await res.json()) as AuthPayload;
  if (epoch !== getSessionEpoch()) throw new SessionCancelledError();
  invalidateSession();
  setAccessToken(data.accessToken);
  reconnectSocket();
  setState({
    ...currentState,
    loading: false,
    shop: data.shop,
    role: data.shop.role,
  });
}

// One logout at a time: a second press while one is pending joins it instead of
// starting another POST. login() awaits this too.
let logoutPromise: Promise<void> | null = null;

function logout(): Promise<void> {
  if (!logoutPromise) {
    logoutPromise = runLogout().finally(() => {
      logoutPromise = null;
    });
  }
  return logoutPromise;
}

async function runLogout(): Promise<void> {
  // Sign out LOCALLY first, before any await. Otherwise the UI stays "signed in"
  // while the session is already invalidated, and a check-in that was saving
  // would surface as "บันทึกไม่สำเร็จ" even though the server may have saved it —
  // staff re-enter the car and create a duplicate job. Now that request is
  // cancelled silently and the screen is already the login page.
  // beginLogout() bumps the epoch, blocks every scoped request/refresh from
  // reaching the network (a poll firing now would carry a token about to be
  // revoked and could refresh a cookie that is being revoked), takes the token
  // out of memory, and hands it back so the POST alone can still send it.
  const heldToken = beginLogout();
  setState({ loading: false, user: null, shop: null, shops: [], role: null, logoutError: null });
  reconnectSocket();
  // Revoke server-side (condition 5). Raw fetch with credentials so the refresh
  // cookie travels: the server authenticates logout by that cookie and does not
  // need a still-valid access token. The captured bearer is sent only if held.
  let confirmed = false;
  try {
    const res = await authFetch('POST', '/api/auth/logout', { body: {}, _bearer: heldToken });
    confirmed = res.ok;
  } catch {
    // Network failure — handled below like any other unconfirmed logout.
  } finally {
    endLogout();
  }
  // The local session is already gone either way, so a failing call can never
  // trap someone who is trying to sign out — but an unconfirmed logout is NOT
  // reported as clean: the server-side session may still be alive.
  if (!confirmed && currentState.user === null) {
    setState({ ...currentState, logoutError: LOGOUT_FAILED_MESSAGE });
  }
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
