// @vitest-environment happy-dom
/**
 * Extends AppShell.test.tsx's no-remount proof to the actual /today page
 * mounted inside the shell (docs/UI-SPEC-FIGMA.md §4 rule 2 + the work
 * order): rotating a tablet must not lose the search box's typed text or
 * force a second fetch of the board, at any of the three kanban tiers
 * (1 column <768, 2 visible 768–1023, 4 in a grid ≥1024).
 *
 * Network and sockets are stubbed — this is a DOM-identity test, not an
 * integration test of the API.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayResponse } from '@gsms/contracts/index.js';
import { BREAKPOINTS } from '../../lib/breakpoints';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock('../../lib/api/client', () => ({
  api: { get: (...a: unknown[]) => apiGet(...a), patch: (...a: unknown[]) => apiPatch(...a) },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const fakeSocket = { on: vi.fn(), off: vi.fn() };
vi.mock('../../lib/api/socket', () => ({ getSocket: () => fakeSocket }));

const SAMPLE: TodayResponse = {
  jobs: [
    {
      jobId: '00000000-0000-4000-8000-000000000001',
      jobNumber: 'SV-00001',
      queueNo: 1,
      status: 'inspecting',
      statusLabel: 'ตรวจเช็ก',
      subState: null,
      label: { text: 'Walk-in', tone: 'orange' },
      jobType: 'normal',
      source: 'walk_in',
      plate: '1กข 1234',
      brand: 'Toyota',
      model: 'Vios',
      color: null,
      customerName: 'ทดสอบ',
      phone: null,
      bayId: null,
      bayName: null,
      symptom: 'ลูกหมากหน้าซ้ายมีเสียง',
      bookingSlotStart: null,
      thumbFileId: null,
      createdAt: new Date().toISOString(),
      statusChangedAt: new Date().toISOString(),
      sla: null,
      column: 2,
      allowedMoves: ['quoted', 'received', 'carout'],
    },
  ],
  kpis: { openJobs: 1, awaitingDecision: 1, inRepair: 0, readyForHandover: 0 },
  pulse: { baysInUse: 0, baysActive: 2, avgInspectionWaitMinutes: null, waitingParts: 0, overSla: 0 },
  generatedAt: new Date().toISOString(),
  truncated: false,
};

const WIDTHS = [
  390,
  BREAKPOINTS.tablet - 1, BREAKPOINTS.tablet, 820,
  BREAKPOINTS.tabletWide - 1, BREAKPOINTS.tabletWide, 1180,
  BREAKPOINTS.desktop - 1, BREAKPOINTS.desktop, 1440,
  1180, 820, 390,
];

function setViewport(width: number) {
  const w = window as unknown as { happyDOM?: { setViewport(v: { width: number; height: number }): void } };
  const height = width < BREAKPOINTS.tablet ? 844 : 900;
  if (w.happyDOM?.setViewport) w.happyDOM.setViewport({ width, height });
}

function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiGet.mockResolvedValue(SAMPLE);
  setViewport(390);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Loaded lazily, after the client/socket mocks above are registered.
async function loadShellAndPage() {
  const { AppShell } = await import('../../components/AppShell');
  const { TodayPage } = await import('./TodayPage');
  return { AppShell, TodayPage };
}

const user = { id: '00000000-0000-4000-8000-000000000002', loginId: 'ice', name: 'Ice' };

describe('/today survives resize/rotation without remounting', () => {
  it('keeps the search input, its typed text, and one board fetch across every tier', async () => {
    const { AppShell, TodayPage } = await loadShellAndPage();

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/today']}>
          <AppShell user={user} role="advisor" online onLogout={() => {}}>
            <TodayPage />
          </AppShell>
        </MemoryRouter>,
      );
      // Flush the initial GET /api/jobs/today (a real await inside
      // useTodayBoard's reload, plus React's own scheduling) — a macrotask
      // tick clears both more reliably than a fixed number of microtasks.
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/api/jobs/today');

    const searchInput = container.querySelector<HTMLInputElement>('.kb-header-search input')!;
    expect(searchInput).not.toBeNull();
    // A term the search blob actually indexes (jobNumber/plate/brand/model/
    // customerName — see jobBlob() in TodayPage.tsx; it deliberately does not
    // index the symptom line, matching jobSearchBlob's existing scope), so the
    // one sample card stays visible through the resize loop below.
    act(() => typeInto(searchInput, 'ทดสอบ'));
    expect(searchInput.value).toBe('ทดสอบ');

    const card = container.querySelector('[data-job-id]');
    expect(card).not.toBeNull();

    const htmlAt390 = container.innerHTML;

    for (const width of WIDTHS) {
      act(() => setViewport(width));
      const nowInput = container.querySelector<HTMLInputElement>('.kb-header-search input');
      expect(nowInput, `search input missing at ${width}px`).toBe(searchInput);
      expect(nowInput!.value, `search text lost at ${width}px`).toBe('ทดสอบ');
      expect(container.querySelector('[data-job-id]'), `card missing at ${width}px`).toBe(card);
      // One tree for every width — layout differences are CSS only.
      expect(container.innerHTML, `DOM differs at ${width}px`).toBe(htmlAt390);
    }

    // Resizing must never trigger a second load of the board.
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});
