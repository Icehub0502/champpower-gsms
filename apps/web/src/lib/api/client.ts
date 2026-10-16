// The one place apps/web talks HTTP to apps/api.
//
// WO-004/T6 condition 1: the access token lives ONLY in this module's memory
// (a plain variable, not React state, not localStorage, not sessionStorage) —
// a page reload always starts from nothing here and useAuth.ts re-establishes
// the session by calling /api/auth/refresh, which reads the httpOnly refresh
// cookie the browser attaches by itself (condition 2). Nothing in this file
// ever reads or writes that cookie directly; it cannot — httpOnly means
// JavaScript has no access to it at all, which is the entire point.
//
// Paths are relative ('/api/...'), never an absolute VITE_API_URL host: see
// apps/web/vite.config.ts for why same-origin is what makes SameSite=Strict
// work at all in dev, and CORS unnecessary.

import { SessionCancelledError, isSessionCancelled } from './sessionCancelled';

let accessToken: string | null = null;

/** Only useAuth.ts (login/refresh/switch-shop/logout) may call this. Every
 * other module reaches the token through `request()` below, never directly —
 * that is what keeps "in memory only" true by construction instead of by
 * convention. */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Thrown on any non-2xx response. `status` lets callers branch on 401/403/404/etc
 * without parsing the message string. Never carries the JWT itself.
 *
 * `body` is the parsed JSON of the error response, or undefined when the body
 * was not JSON. Refusals carry their data there (a 409's candidates, owner
 * names, missing fields); `message` stays the `error` code exactly as before,
 * so no existing caller changes. It is `unknown` on purpose: narrow it with the
 * matching @gsms/contracts schema's safeParse, and treat a mismatch as an
 * unknown error — never cast it. NEVER log it: a refusal body can hold customer
 * names (CLAUDE.md §12). */
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  body?: unknown;
  /** Set false for the public, no-login endpoints (/api/public/*) — never attaches
   * Authorization even if a staff access token happens to be sitting in memory. */
  auth?: boolean;
  /** Internal: set on the retry after a refresh, so a second 401 is reported
   * as-is instead of triggering another refresh attempt (see `request` below). */
  _isRetry?: boolean;
  /** Multipart upload (api.upload). Sent as-is, never JSON.stringify'd, and
   * with NO Content-Type header so the browser writes the multipart boundary.
   * A FormData can be sent twice, so the one retry after a refresh resends it. */
  formData?: FormData;
  /** Internal: aborts the fetch (used for the refresh call only). */
  signal?: AbortSignal;
  /** Internal: epoch of the original call, carried onto the post-refresh retry. */
  _epoch?: number;
  /** Internal: bearer to send instead of the in-memory token (logout captures
   * the token, clears memory, and still sends it once). */
  _bearer?: string | null;
}

async function rawFetch(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const { body, auth = true, formData, signal } = opts;
  const headers: Record<string, string> = formData ? {} : { 'Content-Type': 'application/json' };
  const bearer = opts._bearer !== undefined ? opts._bearer : auth ? accessToken : null;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  return fetch(path, {
    method,
    headers,
    // The refresh cookie is scoped to /api/auth (apps/api/src/routes/auth.ts)
    // so it is only ever sent there, but every request still needs
    // credentials: 'include' or the browser withholds ALL cookies, auth ones
    // included, on a same-origin fetch that doesn't ask for them explicitly.
    credentials: 'include',
    signal,
    body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

/**
 * One shared in-flight refresh, however many callers ask for it at once.
 *
 * WO-004/T6 condition 3: the API rotates the refresh token on every use and
 * treats a replayed one as theft (apps/api/src/routes/auth.ts). Several
 * requests can independently notice an expired access token at the same
 * moment — e.g. the queue board's poll and a user click land together — and
 * without this guard each would call /api/auth/refresh separately. The first
 * to land rotates the cookie; the second then presents the now-stale token
 * and gets treated as a stolen-token replay, which revokes the WHOLE session
 * chain and signs the user out. Collapsing every concurrent caller onto one
 * shared promise (rather than, say, a mutex the second caller waits on and
 * then re-issues its own call) is what keeps this at exactly one HTTP call to
 * /api/auth/refresh no matter how many callers arrive together.
 */
let refreshInFlight: Promise<boolean> | null = null;

/** Set by useAuth.ts; kept out of this module's own state so there is a
 * single source of truth for "who is signed in" (useAuth's module-level
 * store), not two that could disagree. */
let onRefreshResult: ((ok: boolean, accessToken?: string) => void) | null = null;
export function setRefreshResultHandler(handler: typeof onRefreshResult): void {
  onRefreshResult = handler;
}

/**
 * Session epoch. Bumped whenever the identity behind the in-memory token
 * changes (login, logout, switch-shop, forced sign-out). Every authenticated
 * request and every refresh remembers the epoch it started under; once that no
 * longer matches, its outcome belongs to a session that no longer exists and
 * it must not install a token, sign anyone out, retry, or hand data back.
 * Without this, a 401 that user A's request got just before logout could
 * refresh, retry (under user B's token) or sign B out after B logged in.
 */
let sessionEpoch = 0;
let refreshAbort: AbortController | null = null;

export function getSessionEpoch(): number {
  return sessionEpoch;
}

export { SessionCancelledError, isSessionCancelled };

/** Ends the current session generation: bumps the epoch, aborts any refresh
 * still on the wire and forgets it so nobody can join it. Only useAuth.ts calls
 * this (login / logout / switch-shop / forced sign-out). */
export function invalidateSession(): void {
  sessionEpoch += 1;
  refreshAbort?.abort();
  refreshAbort = null;
  refreshInFlight = null;
}

/** True from the moment logout starts until it has finished. While set, every
 * identity-scoped request and every refresh fails locally and never reaches the
 * network: a poll that fired now would carry a token about to be revoked, could
 * get a 401 and start a refresh with a cookie that is being revoked. */
let logoutInFlight = false;

/** Starts a logout: blocks scoped traffic, ends the session generation, takes the
 * token OUT of memory and returns it so the logout POST alone can still send it.
 * Pair with endLogout() in a finally. Only useAuth.ts calls this. */
export function beginLogout(): string | null {
  logoutInFlight = true;
  const held = accessToken;
  invalidateSession();
  accessToken = null;
  return held;
}

export function endLogout(): void {
  logoutInFlight = false;
}

async function refreshOnce(epoch: number, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await rawFetch('POST', '/api/auth/refresh', { body: {}, auth: false, signal });
    if (epoch !== sessionEpoch) return false;
    if (!res.ok) {
      onRefreshResult?.(false);
      return false;
    }
    const data = (await res.json()) as { accessToken: string };
    if (epoch !== sessionEpoch) return false;
    setAccessToken(data.accessToken);
    onRefreshResult?.(true, data.accessToken);
    return true;
  } catch {
    // An aborted or stale refresh says nothing about the CURRENT session, so
    // it must not sign it out.
    if (epoch !== sessionEpoch) return false;
    onRefreshResult?.(false);
    return false;
  }
}

function refresh(): Promise<boolean> {
  if (logoutInFlight) return Promise.resolve(false);
  if (!refreshInFlight) {
    const epoch = sessionEpoch;
    const controller = new AbortController();
    refreshAbort = controller;
    const p: Promise<boolean> = refreshOnce(epoch, controller.signal).finally(() => {
      // Identity check: invalidateSession() may already have replaced this
      // slot with a newer refresh that must not be cleared from under it.
      if (refreshInFlight === p) {
        refreshInFlight = null;
        refreshAbort = null;
      }
    });
    refreshInFlight = p;
  }
  return refreshInFlight;
}

async function parseError(res: Response): Promise<never> {
  let message = res.statusText || `Request failed (${res.status})`;
  let body: unknown;
  try {
    const data = (await res.json()) as { error?: string };
    body = data;
    if (data && typeof data.error === 'string' && data.error) message = data.error;
  } catch {
    // Non-JSON error body — keep the status-text fallback above; body stays undefined.
  }
  throw new ApiError(res.status, message, body);
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  // Public calls (auth:false) carry no identity, so they are never cancelled.
  const scoped = opts.auth !== false;
  const epoch = opts._epoch ?? sessionEpoch;
  const stale = () => scoped && epoch !== sessionEpoch;

  // Nothing tied to an identity goes out while that identity is being revoked.
  if (scoped && logoutInFlight) throw new SessionCancelledError();

  let res: Response;
  try {
    res = await rawFetch(method, path, opts);
  } catch (err) {
    if (stale()) throw new SessionCancelledError();
    throw err;
  }
  if (stale()) throw new SessionCancelledError();

  if (res.status === 401 && scoped && !opts._isRetry) {
    // Expired access token, not necessarily a dead session — try once to
    // recover it through the shared single-flight refresh, then replay this
    // one request exactly once. A second 401 after that is a real
    // "sign in again", not retried further. If the session changed while we
    // waited, the replay would go out under the NEW user's token — never do that.
    const ok = await refresh();
    if (stale()) throw new SessionCancelledError();
    if (ok) return request<T>(method, path, { ...opts, _isRetry: true, _epoch: epoch });
  }

  if (!res.ok) return parseError(res);

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (stale()) throw new SessionCancelledError();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Authenticated REST helpers — attach the in-memory access token when present,
 * and transparently refresh-and-retry once on a 401. */
export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** Multipart POST (e.g. /api/files). Same path as every call above — token,
   * single-flight refresh, one retry after a 401 — only the body differs. */
  upload: <T>(path: string, formData: FormData) => request<T>('POST', path, { formData }),
};

/** Public REST helpers for /api/public/* — deliberately never send Authorization,
 * even when a staff session exists (BoardPage/LookupPage are reachable by anyone). */
export const publicApi = {
  get: <T>(path: string) => request<T>('GET', path, { auth: false }),
};

/** Exposed for useAuth.ts only, which owns the actual login/refresh/switch-shop/
 * logout calls (they need the raw response, e.g. the `shop`/`shops` fields
 * that a plain `api.post` call would otherwise just return as T). */
export { rawFetch as authFetch, refresh as refreshAccessToken };
