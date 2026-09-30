// @vitest-environment happy-dom
/**
 * The waiting-room TV (/board/:token). Uses the REAL lib/api/client.ts against
 * a stubbed fetch, so "never sends Authorization" is checked on the request the
 * client actually builds — with a staff token deliberately sitting in memory,
 * the situation where a leak would happen (a manager opens the board on the
 * same browser they work in).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicBoardResponse } from '@gsms/contracts/index.js';
import { setAccessToken } from '../../lib/api/client';
import { BREAKPOINTS } from '../../lib/breakpoints';
import { BoardPage } from './BoardPage';
import { nextDelayMs } from './useBoardFeed';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = 'tok_7Hq-2xYk_ZpA9';

const SAMPLE: PublicBoardResponse = {
  shopName: 'Champ Power สมุทรปราการ',
  bays: [
    { name: 'ลิฟต์ 1', inUse: true },
    { name: 'ลิฟต์ 2', inUse: false },
  ],
  cars: [
    {
      queueNo: 4, plate: '1กข 1234', province: 'กรุงเทพมหานคร', brand: 'Toyota', model: 'Vios', color: 'ขาว',
      bayName: 'ลิฟต์ 1', status: 'repairing', statusLabel: 'กำลังซ่อม', estLabel: '1 ชม.', estMinutes: 60,
      repairStartedAt: '2026-09-25T03:00:00.000Z', repairEndedAt: null, deliveredToday: false,
      statusChangedAt: '2026-09-25T03:00:00.000Z',
    },
    {
      queueNo: 2, plate: '3ขค 9876', province: null, brand: 'Honda', model: 'Jazz', color: null,
      bayName: null, status: 'delivered', statusLabel: 'ส่งแล้ว', estLabel: '', estMinutes: 0,
      repairStartedAt: null, repairEndedAt: null, deliveredToday: true,
      statusChangedAt: '2026-09-25T02:00:00.000Z',
    },
  ],
  generatedAt: '2026-09-25T03:10:00.000Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // A staff session in the same browser — the board must not use it.
  setAccessToken('staff.jwt.token');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setAccessToken(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderAt(path: string) {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/board/:token" element={<BoardPage />} />
          <Route path="/board" element={<BoardPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('/board/:token', () => {
  it('requests /api/public/board/<token> with NO Authorization header, even with a staff session in memory', async () => {
    fetchMock.mockResolvedValue(json(SAMPLE));
    await renderAt(`/board/${TOKEN}`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/public/board/${TOKEN}`);
    const headers = new Headers(init?.headers);
    expect(headers.has('Authorization')).toBe(false);
  });

  it('renders the bays the RESPONSE names — not a hard-coded bay list', async () => {
    fetchMock.mockResolvedValue(json(SAMPLE));
    await renderAt(`/board/${TOKEN}`);
    const labels = [...container.querySelectorAll('.board-bay-label')].map((n) => n.textContent);
    expect(labels).toEqual(['ลิฟต์ 1', 'ลิฟต์ 2']);
    // Occupancy is words, not only a fill colour.
    expect(container.textContent).toContain('ว่าง');
    expect(container.querySelector('.board-bay-plate')?.textContent).toBe('1กข 1234');
  });

  it("today's delivered car is dimmed but still readable, and says ส่งแล้ว in words", async () => {
    fetchMock.mockResolvedValue(json(SAMPLE));
    await renderAt(`/board/${TOKEN}`);
    const delivered = container.querySelector('.board-row.is-delivered');
    expect(delivered).not.toBeNull();
    expect(delivered!.textContent).toContain('3ขค 9876');
    expect(delivered!.textContent).toContain('ส่งแล้ว');
    // Still in the workshop sorts first; the delivered car is last.
    const rows = [...container.querySelectorAll('.board-row')];
    expect(rows.at(-1)).toBe(delivered);
  });

  it('has nowhere to show a photo', async () => {
    fetchMock.mockResolvedValue(json(SAMPLE));
    await renderAt(`/board/${TOKEN}`);
    expect(container.querySelector('img')).toBeNull();
  });

  it('a 404 (bad or rotated link) shows a clear message, not a blank screen or an old board', async () => {
    fetchMock.mockResolvedValue(json({ error: 'not_found' }, 404));
    await renderAt(`/board/${TOKEN}`);
    expect(container.textContent).toContain('ลิงก์กระดานนี้ใช้ไม่ได้');
    expect(container.querySelector('.board-row')).toBeNull();
  });

  it('plain /board asks for the owner’s link and requests nothing', async () => {
    await renderAt('/board');
    expect(container.textContent).toContain('ต้องเปิดจากลิงก์กระดานของร้าน');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps one tree across every width (rotating a tablet does not remount the board)', async () => {
    fetchMock.mockResolvedValue(json(SAMPLE));
    await renderAt(`/board/${TOKEN}`);
    const html = container.innerHTML;
    const setViewport = (width: number) =>
      (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height: 900 });
    for (const w of [390, BREAKPOINTS.tablet, 1180, BREAKPOINTS.tv, 1920, 390]) {
      act(() => setViewport(w));
      expect(container.innerHTML, `DOM differs at ${w}px`).toBe(html);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('polling back-off', () => {
  it('stretches the delay after consecutive failures, capped at 5 minutes', () => {
    expect(nextDelayMs(0)).toBe(20_000);
    expect(nextDelayMs(1)).toBe(40_000);
    expect(nextDelayMs(2)).toBe(80_000);
    expect(nextDelayMs(10)).toBe(300_000);
  });

  it('after a server error the next request waits the backed-off delay — no hammering', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fetchMock.mockResolvedValue(json({ error: 'internal_error' }, 500));

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/board/${TOKEN}`]}>
          <Routes>
            <Route path="/board/:token" element={<BoardPage />} />
          </Routes>
        </MemoryRouter>,
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('เชื่อมต่อไม่ได้ชั่วคราว');

    // One failure -> 40s, not the normal 20s.
    await act(async () => { await vi.advanceTimersByTimeAsync(39_999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Two failures -> 80s.
    await act(async () => { await vi.advanceTimersByTimeAsync(79_999); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
