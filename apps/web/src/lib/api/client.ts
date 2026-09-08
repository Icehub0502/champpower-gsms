const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

const TOKEN_KEY = 'cp_token';

/** Thrown on any non-2xx response. `status` lets callers branch on 401/403/404/etc
 * without parsing the message string. Never carries the JWT itself. */
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface RequestOptions {
  body?: unknown;
  /** Set false for the public, no-login endpoints (/api/public/*) — never attaches
   * Authorization even if a staff JWT happens to be sitting in localStorage. */
  auth?: boolean;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, auth = true } = opts;
  // Harmless when the API isn't behind ngrok — only matters when VITE_API_URL points
  // at a free ngrok tunnel, whose browser-warning interstitial otherwise swallows
  // every XHR/fetch (surfaces to the browser as an opaque CORS failure, not a 200
  // with a warning page) unless this header is present.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'ngrok-skip-browser-warning': '1',
  };
  if (auth) Object.assign(headers, authHeaders());

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data && typeof data.error === 'string' && data.error) message = data.error;
    } catch {
      // Non-JSON error body — keep the status-text fallback above.
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Authenticated REST helpers — attach the staff JWT from localStorage when present. */
export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body }),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Public REST helpers for /api/public/* — deliberately never send Authorization,
 * even when a staff session token exists (BoardPage/LookupPage are reachable by anyone). */
export const publicApi = {
  get: <T>(path: string) => request<T>('GET', path, { auth: false }),
};

export { TOKEN_KEY };
