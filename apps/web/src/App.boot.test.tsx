// @vitest-environment happy-dom
/**
 * Boot race. useAuth's `initialized` flag and client.ts's epoch, token and
 * in-flight refresh are module-level, and the boot refresh only runs once per
 * module load, so each test loads fresh copies (vi.resetModules) and mounts
 * with the boot refresh still pending.
 */
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./lib/api/socket', () => ({
  getSocket: () => ({ on: () => {}, off: () => {} }),
  reconnectSocket: () => {},
}));
vi.mock('./routes/checkin/CheckInPage', () => ({ CheckInPage: () => null }));
vi.mock('./routes/today/TodayPage', () => ({ TodayPage: () => null }));

const SHOP = { id: '00000000-0000-4000-8000-0000000000aa', name: 'สมุทรปราการ', slug: 'spk' };
const USER_A = { id: '00000000-0000-4000-8000-000000000001', loginId: 'office.spk', name: 'A' };
const USER_B = { id: '00000000-0000-4000-8000-000000000002', loginId: 'owner.b', name: 'B' };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let bootRefresh: (r: Response) => void;
let urls: string[];
let container: HTMLDivElement;
let root: Root;
let auth: import('./hooks/useAuth').UseAuthResult;
let getAccessToken: () => string | null;
let act: typeof import('react').act;

beforeEach(async () => {
  // Fresh copies of App, useAuth and client.ts (and React with them): the boot
  // refresh runs once per module load. act() comes from the same fresh React.
  vi.resetModules();
  urls = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/auth/refresh') return new Promise<Response>((r) => { bootRefresh = r; });
    if (url === '/api/auth/login') {
      return Promise.resolve(json(200, {
        accessToken: 'tok-B', user: USER_B, shop: { ...SHOP, role: 'owner' }, shops: [{ ...SHOP, role: 'owner' }],
      }));
    }
    // What a stale boot would have resolved to: A.
    if (url === '/api/auth/me') {
      return Promise.resolve(json(200, { user: USER_A, shop: { ...SHOP, role: 'advisor' }, shops: [] }));
    }
    return Promise.reject(new Error(`unrouted ${url}`));
  });

  // React, react-dom and the router must come from the same fresh module graph as App.
  ({ act } = await import('react'));
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await import('react-router-dom');
  const { App } = await import('./App');
  const authMod = await import('./hooks/useAuth');
  ({ getAccessToken } = await import('./lib/api/client'));
  function Ctl() {
    auth = authMod.useAuth();
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={['/']}><Ctl /><App /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(auth.loading).toBe(true); // boot refresh is pending
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function loginBDuringBoot() {
  await act(async () => { await auth.login('owner.b', 'x'); });
  expect(auth.user?.loginId).toBe('owner.b');
}

describe('a login that happens while the boot refresh is pending is not overwritten', () => {
  it('(c1) boot refresh succeeds late: B stays, the token stays B\'s, /me is never asked', async () => {
    await loginBDuringBoot();
    await act(async () => { bootRefresh(json(200, { accessToken: 'tok-stale' })); await new Promise((r) => setTimeout(r, 0)); });

    expect(getAccessToken()).toBe('tok-B');
    expect(auth.user?.loginId).toBe('owner.b');
    expect(auth.loading).toBe(false);
    expect(urls).not.toContain('/api/auth/me');
  });

  it('(c2) boot refresh fails late: B is not signed out', async () => {
    await loginBDuringBoot();
    await act(async () => { bootRefresh(json(401, { error: 'session_revoked' })); await new Promise((r) => setTimeout(r, 0)); });

    expect(getAccessToken()).toBe('tok-B');
    expect(auth.user?.loginId).toBe('owner.b');
    expect(auth.loading).toBe(false);
  });
});
