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
}

async function rawFetch(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const { body, auth = true } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  return fetch(path, {
    method,
    headers,
    // The refresh cookie is scoped to /api/auth (apps/api/src/routes/auth.ts)
    // so it is only ever sent there, but every request still needs
    // credentials: 'include' or the browser withholds ALL cookies, auth ones
    // included, on a same-origin fetch that doesn't ask for them explicitly.
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
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

async function refreshOnce(): Promise<boolean> {
  try {
    const res = await rawFetch('POST', '/api/auth/refresh', { body: {}, auth: false });
    if (!res.ok) {
      onRefreshResult?.(false);
      return false;
    }
    const data = (await res.json()) as { accessToken: string };
    setAccessToken(data.accessToken);
    onRefreshResult?.(true, data.accessToken);
    return true;
  } catch {
    onRefreshResult?.(false);
    return false;
  }
}

function refresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = refreshOnce().finally(() => {
      refreshInFlight = null;
    });
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
  const res = await rawFetch(method, path, opts);

  if (res.status === 401 && opts.auth !== false && !opts._isRetry) {
    // Expired access token, not necessarily a dead session — try once to
    // recover it through the shared single-flight refresh, then replay this
    // one request exactly once. A second 401 after that is a real
    // "sign in again", not retried further.
    const ok = await refresh();
    if (ok) return request<T>(method, path, { ...opts, _isRetry: true });
  }

  if (!res.ok) return parseError(res);

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Authenticated REST helpers — attach the in-memory access token when present,
 * and transparently refresh-and-retry once on a 401. */
export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  del: <T>(path: string) => request<T>('DELETE', path),
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
