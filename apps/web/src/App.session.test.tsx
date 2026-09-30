// @vitest-environment happy-dom
/**
 * Logout -> login as someone else. Real App, real useAuth, real client.ts; only
 * the network (fetch), the socket and two heavy pages are stubbed.
 *
 * What these pin down:
 *  - the URL never outlives the identity (logout on /checkin -> "/", and the
 *    next login shows the launcher, not the page the previous user was on);
 *  - after A logs out and B logs in, requests carry B's token and nothing of
 *    A's is on screen;
 *  - anything A's session still had in flight (a 401, a refresh) can neither
 *    sign B out, install A's token, nor be retried as B;
 *  - a logout the server did not confirm is never reported as clean.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useAuth, type UseAuthResult } from './hooks/useAuth';
import { api, getAccessToken, isSessionCancelled } from './lib/api/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./lib/api/socket', () => ({
  getSocket: () => ({ on: () => {}, off: () => {} }),
  reconnectSocket: () => {},
}));

// Stand-ins for the real pages: each just lists what GET /api/rows returned
// for the token in use, which is exactly what "no row from A is rendered"
// needs. The launcher and the shell are the real components.
vi.mock('./routes/checkin/CheckInPage', async () => {
  const { useCollection } = await import('./hooks/useCollection');
  return {
    CheckInPage: () => {
      const { rows } = useCollection<{ id: string }>('/api/rows');
      return <div data-testid="checkin">{rows.map((r) => r.id).join(',')}</div>;
    },
  };
});
vi.mock('./routes/today/TodayPage', () => ({ TodayPage: () => <div data-testid="today" /> }));

const SHOP = { id: '00000000-0000-4000-8000-0000000000aa', name: 'สมุทรปราการ', slug: 'spk' };
const USERS = {
  A: { id: '00000000-0000-4000-8000-000000000001', loginId: 'office.spk', name: 'A' },
  B: { id: '00000000-0000-4000-8000-000000000002', loginId: 'owner.b', name: 'B' },
} as const;
const ROLES = { A: 'advisor', B: 'owner' } as const;

type Who = keyof typeof USERS;
type Handler = (init: RequestInit) => Promise<Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let routes: Record<string, Handler>;
let calls: Array<{ url: string; auth: string | null; signal?: AbortSignal | null }>;

function loginHandler(): Handler {
  return async (init) => {
    const who: Who = (JSON.parse(String(init.body)) as { loginId: string }).loginId === 'owner.b' ? 'B' : 'A';
    return json(200, {
      accessToken: `tok-${who}`,
      user: USERS[who],
      shop: { ...SHOP, role: ROLES[who] },
      shops: [{ ...SHOP, role: ROLES[who] }],
    });
  };
}

function defaultRoutes(): Record<string, Handler> {
  return {
    '/api/auth/refresh': async () => json(401, { error: 'session_revoked' }),
    '/api/auth/login': loginHandler(),
    '/api/auth/logout': async () => json(200, { ok: true }),
    '/api/rows': async (init) => {
      const tok = new Headers(init.headers).get('Authorization');
      return json(200, [{ id: tok === 'Bearer tok-A' ? 'row-of-A' : 'row-of-B' }]);
    },
  };
}

let auth: UseAuthResult;
let nav: ReturnType<typeof useNavigate>;
let pathname = '';
function Ctl() {
  auth = useAuth();
  nav = useNavigate();
  pathname = useLocation().pathname;
  return null;
}

let container: HTMLDivElement;
let root: Root;

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const loginAs = (who: Who) => act(async () => { await auth.login(who === 'A' ? 'office.spk' : 'owner.b', 'x'); });
const goto = (to: string) => act(async () => { nav(to); await new Promise((r) => setTimeout(r, 0)); });

beforeEach(async () => {
  routes = defaultRoutes();
  calls = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url: url.split('?')[0]!, auth: new Headers(init.headers).get('Authorization'), signal: init.signal });
    const h = routes[url.split('?')[0]!];
    if (!h) return Promise.reject(new Error(`unrouted ${url}`));
    return h(init);
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={['/checkin']}><Ctl /><App /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 0));
  });
});

afterEach(async () => {
  // useAuth is a module-level singleton shared by every test: leave it signed out.
  routes['/api/auth/logout'] = async () => json(200, { ok: true });
  if (auth.user) await act(async () => { await auth.logout(); });
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('routing: the URL does not outlive the identity', () => {
  it('signed out on a deep URL is sent to "/" and shows the login form', () => {
    expect(pathname).toBe('/');
    expect(container.querySelector('.login-card')).not.toBeNull();
  });

  it('logout on /checkin lands on "/", and logging in as B shows the launcher, not /checkin', async () => {
    await loginAs('A');
    await goto('/checkin');
    expect(pathname).toBe('/checkin');
    expect(container.querySelector('[data-testid="checkin"]')).not.toBeNull();

    await act(async () => { await auth.logout(); });
    await flush();
    expect(pathname).toBe('/');
    expect(container.querySelector('.login-card')).not.toBeNull();

    await loginAs('B');
    await flush();
    expect(pathname).toBe('/');
    expect(container.querySelector('.launcher-page')).not.toBeNull();
    expect(container.querySelector('[data-testid="checkin"]')).toBeNull();
    expect(auth.user?.loginId).toBe('owner.b');
  });
});

describe('data: nothing of A is shown to B', () => {
  it('B fetches with B\'s token and A\'s row is gone from the screen', async () => {
    await loginAs('A');
    await goto('/checkin');
    await flush();
    expect(container.querySelector('[data-testid="checkin"]')?.textContent).toBe('row-of-A');

    await act(async () => { await auth.logout(); });
    await loginAs('B');
    await goto('/checkin');
    await flush();

    expect(container.querySelector('[data-testid="checkin"]')?.textContent).toBe('row-of-B');
    expect(container.textContent).not.toContain('row-of-A');
    const rowCalls = calls.filter((c) => c.url === '/api/rows').map((c) => c.auth);
    expect(rowCalls).toEqual(['Bearer tok-A', 'Bearer tok-B']);
  });
});

describe('races: what A left in flight cannot touch B', () => {
  it('a 401 from A that resolves after B logs in is cancelled: no refresh, no retry, B stays signed in', async () => {
    await loginAs('A');
    const late = deferred<Response>();
    routes['/api/slow'] = () => late.promise;
    let outcome: unknown;
    const pending = api.get('/api/slow').then((v) => { outcome = v; }, (e: unknown) => { outcome = e; });

    await act(async () => { await auth.logout(); });
    await loginAs('B');
    const refreshCallsBefore = calls.filter((c) => c.url === '/api/auth/refresh').length;

    await act(async () => { late.resolve(json(401, { error: 'unauthorized' })); await pending; });

    expect(isSessionCancelled(outcome)).toBe(true);
    expect(calls.filter((c) => c.url === '/api/auth/refresh').length).toBe(refreshCallsBefore);
    expect(calls.filter((c) => c.url === '/api/slow')).toHaveLength(1); // never retried as B
    expect(getAccessToken()).toBe('tok-B');
    expect(auth.user?.loginId).toBe('owner.b');
  });

  it('a refresh started by A that resolves after B logs in never installs A\'s token', async () => {
    await loginAs('A');
    const refresh = deferred<Response>();
    routes['/api/auth/refresh'] = () => refresh.promise;
    routes['/api/slow'] = async () => json(401, { error: 'unauthorized' });
    let outcome: unknown;
    const pending = api.get('/api/slow').then((v) => { outcome = v; }, (e: unknown) => { outcome = e; });
    await flush();
    const refreshCall = calls.find((c) => c.url === '/api/auth/refresh')!;
    expect(refreshCall).toBeDefined();

    await act(async () => { await auth.logout(); });
    expect(refreshCall.signal?.aborted).toBe(true); // aborted, not just ignored
    await loginAs('B');

    // The (stubbed) network ignores the abort and answers anyway — the epoch
    // check is the backstop.
    await act(async () => { refresh.resolve(json(200, { accessToken: 'tok-A-refreshed' })); await pending; });

    expect(isSessionCancelled(outcome)).toBe(true);
    expect(getAccessToken()).toBe('tok-B');
    expect(auth.user?.loginId).toBe('owner.b');
    expect(calls.filter((c) => c.url === '/api/slow')).toHaveLength(1);
  });

  it('a refresh that FAILS for A after B logs in does not sign B out', async () => {
    await loginAs('A');
    const refresh = deferred<Response>();
    routes['/api/auth/refresh'] = () => refresh.promise;
    routes['/api/slow'] = async () => json(401, { error: 'unauthorized' });
    const pending = api.get('/api/slow').catch(() => {});
    await flush();

    await act(async () => { await auth.logout(); });
    await loginAs('B');
    await act(async () => { refresh.resolve(json(401, { error: 'session_revoked' })); await pending; });

    expect(getAccessToken()).toBe('tok-B');
    expect(auth.user?.loginId).toBe('owner.b');
    expect(container.querySelector('.login-card')).toBeNull();
  });

  it('a refresh in flight when the user logs out cannot bring the token back', async () => {
    await loginAs('A');
    const refresh = deferred<Response>();
    routes['/api/auth/refresh'] = () => refresh.promise;
    routes['/api/slow'] = async () => json(401, { error: 'unauthorized' });
    const pending = api.get('/api/slow').catch(() => {});
    await flush();

    await act(async () => { await auth.logout(); });
    await act(async () => { refresh.resolve(json(200, { accessToken: 'tok-A-refreshed' })); await pending; });

    expect(getAccessToken()).toBeNull();
    expect(auth.user).toBeNull();
    expect(container.querySelector('.login-card')).not.toBeNull();
  });
});

describe('logout is never reported clean when the server did not confirm it', () => {
  it('a confirmed logout shows no warning', async () => {
    await loginAs('A');
    await act(async () => { await auth.logout(); });
    expect(auth.logoutError).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('a 401 from /logout still clears local state but shows the Thai warning on the login screen', async () => {
    await loginAs('A');
    routes['/api/auth/logout'] = async () => json(401, { error: 'unauthorized' });
    await act(async () => { await auth.logout(); });
    expect(getAccessToken()).toBeNull();
    expect(auth.user).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('ออกจากระบบไม่สำเร็จ กรุณาปิดเบราว์เซอร์');
  });

  it('a network error on /logout does the same, and the next login clears the warning', async () => {
    await loginAs('A');
    routes['/api/auth/logout'] = () => Promise.reject(new TypeError('Failed to fetch'));
    await act(async () => { await auth.logout(); });
    expect(getAccessToken()).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await loginAs('B');
    expect(auth.logoutError).toBeNull();
  });

  it('sends the logout with credentials so the refresh cookie can identify the session', async () => {
    await loginAs('A');
    let credentials: RequestCredentials | undefined;
    routes['/api/auth/logout'] = async (init) => { credentials = init.credentials; return json(200, {}); };
    await act(async () => { await auth.logout(); });
    expect(credentials).toBe('include');
  });
});

describe('traffic during a logout', () => {
  it('a request started while the logout POST is in flight never reaches fetch; the POST itself still carries the bearer it captured', async () => {
    await loginAs('A');
    const logoutPost = deferred<Response>();
    routes['/api/auth/logout'] = () => logoutPost.promise;

    let loggingOut!: Promise<void>;
    await act(async () => { loggingOut = auth.logout(); await Promise.resolve(); });

    // Token is already out of memory, and scoped traffic is refused locally.
    expect(getAccessToken()).toBeNull();
    const before = calls.length;
    let outcome: unknown;
    await act(async () => { await api.get('/api/rows').catch((e: unknown) => { outcome = e; }); });
    expect(isSessionCancelled(outcome)).toBe(true);
    expect(calls.length).toBe(before); // nothing hit the network, and no refresh either

    const post = calls.find((c) => c.url === '/api/auth/logout')!;
    expect(post.auth).toBe('Bearer tok-A');

    await act(async () => { logoutPost.resolve(json(200, { ok: true })); await loggingOut; });
    expect(auth.user).toBeNull();

    // The block is lifted afterwards: the next user's requests go out normally.
    await loginAs('B');
    await expect(api.get('/api/rows')).resolves.toEqual([{ id: 'row-of-B' }]);
  });

  it('a poll that fires mid-logout shows no error: the cancelled request is not a failure', async () => {
    const { useCollection } = await import('./hooks/useCollection');
    let bump!: () => void;
    let latest: { error: Error | null; loading: boolean } = { error: null, loading: true };
    const { useState } = await import('react');
    function Poller() {
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      const s = useCollection<{ id: string }>(`/api/rows?n=${n}`);
      latest = s;
      return <div data-testid="poller-error">{s.error ? s.error.message : ''}</div>;
    }
    await loginAs('A');
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/']}><Ctl /><App /><Poller /></MemoryRouter>);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(latest.error).toBeNull();

    const logoutPost = deferred<Response>();
    routes['/api/auth/logout'] = () => logoutPost.promise;
    let loggingOut!: Promise<void>;
    await act(async () => { loggingOut = auth.logout(); await Promise.resolve(); });
    await act(async () => { bump(); await new Promise((r) => setTimeout(r, 0)); }); // the poll
    expect(latest.error).toBeNull();
    expect(container.querySelector('[data-testid="poller-error"]')?.textContent).toBe('');

    await act(async () => { logoutPost.resolve(json(200, { ok: true })); await loggingOut; });
    expect(latest.error).toBeNull();
  });
});

describe('switchShop is guarded by the session epoch like login and logout', () => {
  const OTHER_SHOP = { id: '00000000-0000-4000-8000-0000000000bb', name: 'เพชรเกษม', slug: 'ptk', role: 'owner' as const };

  it('a switch-shop answer that lands after logout is dropped: no token, still signed out', async () => {
    await loginAs('B');
    const late = deferred<Response>();
    routes['/api/auth/switch-shop'] = () => late.promise;
    let outcome: unknown;
    const switching = auth.switchShop(OTHER_SHOP.id).catch((e: unknown) => { outcome = e; });

    await act(async () => { await auth.logout(); });
    await act(async () => { late.resolve(json(200, { accessToken: 'tok-B-shop2', shop: OTHER_SHOP })); await switching; });

    expect(isSessionCancelled(outcome)).toBe(true);
    expect(getAccessToken()).toBeNull();
    expect(auth.user).toBeNull();
    expect(auth.shop).toBeNull();
    expect(container.querySelector('.login-card')).not.toBeNull();
  });

  it('a switch-shop answer for B that lands after A logs in cannot replace A\'s token or shop', async () => {
    await loginAs('B');
    const late = deferred<Response>();
    routes['/api/auth/switch-shop'] = () => late.promise;
    let outcome: unknown;
    const switching = auth.switchShop(OTHER_SHOP.id).catch((e: unknown) => { outcome = e; });

    await act(async () => { await auth.logout(); });
    await loginAs('A');
    await act(async () => { late.resolve(json(200, { accessToken: 'tok-B-shop2', shop: OTHER_SHOP })); await switching; });

    expect(isSessionCancelled(outcome)).toBe(true);
    expect(getAccessToken()).toBe('tok-A');
    expect(auth.shop?.id).toBe(SHOP.id);
    expect(auth.user?.loginId).toBe('office.spk');
  });
});

describe('logout signs out immediately and cannot be doubled', () => {
  it('a save in flight when logout is pressed is silent: the login page is already up, and the late answer is discarded, not shown as a failure', async () => {
    await loginAs('A');
    const save = deferred<Response>();
    routes['/api/checkin'] = () => save.promise;
    const logoutPost = deferred<Response>();
    routes['/api/auth/logout'] = () => logoutPost.promise;
    let outcome: unknown;
    const saving = api.post('/api/checkin', {}).then((v) => { outcome = v; }, (e: unknown) => { outcome = e; });

    let loggingOut!: Promise<void>;
    await act(async () => { loggingOut = auth.logout(); await Promise.resolve(); });
    // Signed out BEFORE the logout POST answers, so no screen is left showing a
    // save that is about to "fail".
    expect(auth.user).toBeNull();
    expect(container.querySelector('.login-card')).not.toBeNull();

    // The server did save it; the client just has nobody to tell.
    await act(async () => { save.resolve(json(201, { jobId: 'j1' })); await saving; });
    expect(isSessionCancelled(outcome)).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => { logoutPost.resolve(json(200, { ok: true })); await loggingOut; });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('pressing logout twice sends one POST', async () => {
    await loginAs('A');
    const logoutPost = deferred<Response>();
    routes['/api/auth/logout'] = () => logoutPost.promise;
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => { first = auth.logout(); second = auth.logout(); await Promise.resolve(); });
    await act(async () => { logoutPost.resolve(json(200, { ok: true })); await Promise.all([first, second]); });
    expect(calls.filter((c) => c.url === '/api/auth/logout')).toHaveLength(1);
  });

  it('a login started while the logout POST is pending waits for it, so its Set-Cookie cannot be wiped by the logout\'s Clear-Cookie', async () => {
    await loginAs('A');
    const logoutPost = deferred<Response>();
    routes['/api/auth/logout'] = () => logoutPost.promise;
    let loggingOut!: Promise<void>;
    let loggingIn!: Promise<void>;
    await act(async () => {
      loggingOut = auth.logout();
      loggingIn = auth.login('owner.b', 'x');
      await new Promise((r) => setTimeout(r, 0));
    });
    const loginCallsWhilePending = calls.filter((c) => c.url === '/api/auth/login').length;
    expect(loginCallsWhilePending).toBe(1); // only A's earlier login; B's has not gone out

    await act(async () => { logoutPost.resolve(json(200, { ok: true })); await loggingOut; await loggingIn; });
    expect(calls.filter((c) => c.url === '/api/auth/login')).toHaveLength(2);
    expect(auth.user?.loginId).toBe('owner.b');
    expect(getAccessToken()).toBe('tok-B');
  });
});

describe('leftovers of the previous session cannot leak across a change', () => {
  it('(a) B\'s 401 fires its own refresh; it does not wait on A\'s aborted one', async () => {
    await loginAs('A');
    const refreshA = deferred<Response>();
    let refreshCalls = 0;
    routes['/api/auth/refresh'] = () => {
      refreshCalls += 1;
      return refreshCalls === 1 ? refreshA.promise : Promise.resolve(json(200, { accessToken: 'tok-B2' }));
    };
    routes['/api/slow'] = async () => json(401, { error: 'unauthorized' });
    routes['/api/b'] = async (init) =>
      new Headers(init.headers).get('Authorization') === 'Bearer tok-B2'
        ? json(200, [{ id: 'b' }])
        : json(401, { error: 'unauthorized' });
    const stale = api.get('/api/slow').catch(() => {});
    await flush();

    await act(async () => { await auth.logout(); });
    await loginAs('B');
    let result: unknown;
    await act(async () => { result = await api.get('/api/b'); });

    const refreshes = calls.filter((c) => c.url === '/api/auth/refresh');
    expect(refreshes).toHaveLength(2);
    expect(refreshes[1]!.signal?.aborted).toBe(false);
    expect(result).toEqual([{ id: 'b' }]);
    expect(calls.filter((c) => c.url === '/api/b').at(-1)!.auth).toBe('Bearer tok-B2');
    expect(getAccessToken()).toBe('tok-B2');
    expect(auth.user?.loginId).toBe('owner.b');
    await act(async () => { refreshA.resolve(json(200, { accessToken: 'tok-A-late' })); await stale; });
    expect(getAccessToken()).toBe('tok-B2');
  });

  it('(b1) switch-shop cuts a request still pending from the old shop', async () => {
    const SHOP2 = { id: '00000000-0000-4000-8000-0000000000cc', name: 'อีกสาขา', slug: 'other', role: 'advisor' as const };
    await loginAs('A');
    const oldRows = deferred<Response>();
    routes['/api/rows'] = async (init) =>
      new Headers(init.headers).get('Authorization') === 'Bearer tok-A'
        ? oldRows.promise
        : json(200, [{ id: 'row-of-shop2' }]);
    routes['/api/auth/switch-shop'] = async () => json(200, { accessToken: 'tok-A-s2', shop: SHOP2 });
    await goto('/checkin');
    await flush();

    await act(async () => { await auth.switchShop(SHOP2.id); });
    await flush();
    await act(async () => { oldRows.resolve(json(200, [{ id: 'row-of-A-shop1' }])); await new Promise((r) => setTimeout(r, 0)); });

    expect(container.textContent).not.toContain('row-of-A-shop1');
    expect(container.querySelector('[data-testid="checkin"]')?.textContent).toBe('row-of-shop2');
    expect(calls.filter((c) => c.url === '/api/rows').at(-1)!.auth).toBe('Bearer tok-A-s2');
  });

  it('(d) an upload that got a 401 as A is not retried as B, nor with A\'s refreshed token', async () => {
    await loginAs('A');
    const refresh = deferred<Response>();
    routes['/api/files'] = async () => json(401, { error: 'unauthorized' });
    routes['/api/auth/refresh'] = () => refresh.promise;
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), 'a.jpg');
    let outcome: unknown;
    const p = api.upload('/api/files', fd).then((v) => { outcome = v; }, (e: unknown) => { outcome = e; });
    await flush();

    await act(async () => { await auth.logout(); });
    await loginAs('B');
    await act(async () => { refresh.resolve(json(200, { accessToken: 'tok-A2' })); await p; });

    expect(isSessionCancelled(outcome)).toBe(true);
    const uploads = calls.filter((c) => c.url === '/api/files');
    expect(uploads).toHaveLength(1);
    expect(uploads.some((c) => c.auth === 'Bearer tok-B' || c.auth === 'Bearer tok-A2')).toBe(false);
    expect(getAccessToken()).toBe('tok-B');
    expect(auth.user?.loginId).toBe('owner.b');
  });
});
