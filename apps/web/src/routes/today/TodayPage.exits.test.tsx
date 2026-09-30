// @vitest-environment happy-dom
/**
 * ส่งแล้ว on /today (DECISION-carout.md §2 and §3): the confirm dialog before
 * ready -> delivered, whichever way it is started, and the round trip through
 * the "ส่งแล้ววันนี้" panel that brings a mistaken delivery back to column 4.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobDetail, TodayJob, TodayResponse } from '@gsms/contracts/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock('../../lib/api/client', () => ({
  api: { get: (...a: unknown[]) => apiGet(...a), patch: (...a: unknown[]) => apiPatch(...a) },
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, message: string, body?: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  },
}));
const fakeSocket = { on: vi.fn(), off: vi.fn() };
vi.mock('../../lib/api/socket', () => ({ getSocket: () => fakeSocket }));

import { ApiError } from '../../lib/api/client';
import { TodayPage } from './TodayPage';

const JOB_ID = '00000000-0000-4000-8000-000000000031';

const READY_JOB: TodayJob = {
  jobId: JOB_ID,
  jobNumber: 'SV-00031',
  queueNo: 5,
  status: 'ready',
  statusLabel: 'พร้อมส่ง',
  subState: null,
  label: { text: 'พร้อมส่ง', tone: 'green' },
  jobType: 'normal',
  source: 'walk_in',
  plate: '5กก 3131',
  brand: 'Toyota',
  model: 'Vios',
  color: null,
  customerName: null,
  phone: null,
  bayId: null,
  bayName: null,
  symptom: null,
  bookingSlotStart: null,
  thumbFileId: null,
  createdAt: '2026-09-30T01:00:00.000Z',
  statusChangedAt: '2026-09-30T02:00:00.000Z',
  sla: null,
  column: 4,
  allowedMoves: ['delivered'],
};

function board(jobs: TodayJob[]): TodayResponse {
  return {
    jobs,
    kpis: { openJobs: jobs.length, awaitingDecision: 0, inRepair: 0, readyForHandover: jobs.length },
    pulse: { baysInUse: 0, baysActive: 2, avgInspectionWaitMinutes: null, waitingParts: 0, overSla: 0 },
    generatedAt: new Date().toISOString(),
    truncated: false,
  };
}

const DELIVERED_DETAIL: JobDetail = {
  jobId: JOB_ID,
  jobNumber: 'SV-00031',
  queueNo: 5,
  status: 'delivered',
  statusLabel: 'ส่งแล้ว',
  subState: null,
  jobType: 'normal',
  source: 'walk_in',
  plate: '5กก 3131',
  province: null,
  brand: 'Toyota',
  model: 'Vios',
  color: null,
  customerName: null,
  bayName: null,
  createdAt: '2026-09-30T01:00:00.000Z',
  statusChangedAt: '2026-09-30T03:00:00.000Z',
  onBoard: false,
  history: [
    { status: 'delivered', statusLabel: 'ส่งแล้ว', changedAt: '2026-09-30T03:00:00.000Z', changedBy: { userId: '00000000-0000-4000-8000-0000000000c1', name: 'สมชาย' }, reason: null },
  ],
  allowedMoves: ['ready'],
  movesNeedingReason: ['ready'],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/today']}>
        <TodayPage />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function button(text: string): HTMLButtonElement {
  const all = [...document.querySelectorAll('button')];
  const b = all.find((el) => el.textContent?.trim() === text) ?? all.find((el) => el.textContent?.includes(text));
  if (!b) throw new Error(`no button containing "${text}"`);
  return b as HTMLButtonElement;
}

const card = () => container.querySelector(`[data-job-id="${JOB_ID}"]`);
const confirmDialog = () => document.querySelector('[aria-labelledby="kb-deliver-title"]');

describe('ส่งแล้ว asks first', () => {
  beforeEach(() => {
    apiGet.mockResolvedValue(board([READY_JOB]));
  });

  it('from the card menu: a dialog "ยืนยันว่ารถออกจากอู่แล้ว" names the car, and nothing is sent until confirmed', async () => {
    await mount();
    await click(card()!);
    await click(button('ส่งแล้ว…'));

    expect(apiPatch).not.toHaveBeenCalled();
    const dlg = confirmDialog()!;
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).toContain('ยืนยันว่ารถออกจากอู่แล้ว');
    expect(dlg.textContent).toContain('Toyota Vios');
    expect(dlg.textContent).toContain('5กก 3131');
    expect(dlg.textContent).toContain('SV-00031');
    expect(dlg.textContent).toContain('หายจากกระดานทันที');
  });

  it('ยกเลิก sends no request and leaves the card where it was', async () => {
    await mount();
    await click(card()!);
    await click(button('ส่งแล้ว…'));
    await click(button('ยกเลิก'));

    expect(apiPatch).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
    expect(card()).not.toBeNull();
  });

  it('Esc is a cancel too', async () => {
    await mount();
    await click(card()!);
    await click(button('ส่งแล้ว…'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(apiPatch).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
  });

  it('confirming sends ready -> delivered once, and the card leaves the board', async () => {
    let resolve!: (v: unknown) => void;
    apiPatch.mockReturnValue(new Promise((r) => (resolve = r)));
    await mount();
    await click(card()!);
    await click(button('ส่งแล้ว…'));
    await click(button('ยืนยัน รถออกแล้ว'));

    // Disabled while pending: a second tap cannot send it twice.
    expect(button('กำลังบันทึก').disabled).toBe(true);
    await click(button('กำลังบันทึก'));
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/status`, { to: 'delivered', fromStatus: 'ready' });

    apiGet.mockResolvedValue(board([]));
    await act(async () => {
      resolve({ jobId: JOB_ID, status: 'delivered', subState: null, column: null, statusChangedAt: '2026-09-30T03:00:00.000Z' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(confirmDialog()).toBeNull();
    expect(card()).toBeNull();
  });

  it('a refusal shows in the dialog and the dialog stays until the person decides', async () => {
    apiPatch.mockRejectedValue(new ApiError(409, 'illegal_status_move'));
    await mount();
    await click(card()!);
    await click(button('ส่งแล้ว…'));
    await click(button('ยืนยัน รถออกแล้ว'));
    expect(confirmDialog()!.textContent).toContain('ย้ายงานจาก');
    expect(button('ยืนยัน รถออกแล้ว').disabled).toBe(false);
  });

  it('there is no drag route around it: dropping a ready card on any column never sends delivered', async () => {
    await mount();
    const bodies = [...container.querySelectorAll<HTMLElement>('.kb-column-body')];
    expect(bodies).toHaveLength(4);
    bodies.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({ left: i * 100, right: i * 100 + 90, top: 0, bottom: 500, width: 90, height: 500, x: i * 100, y: 0 }) as DOMRect;
    });

    for (let col = 0; col < 4; col++) {
      await act(async () => {
        card()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 350, clientY: 20 }));
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: 350 - 40, clientY: 40 }));
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', clientX: col * 100 + 10, clientY: 40 }));
      });
    }
    // The drops really happened (each one was refused with the toast), so the
    // silence above is the rule, not a drag that never started.
    expect(container.querySelector('.kb-toast')?.textContent).toContain('วางการ์ดในคอลัมน์เดิม');
    expect(apiPatch).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
  });
});

describe('the ส่งแล้ววันนี้ panel on /today', () => {
  it('undoing a delivery sends the trimmed reason, closes the panel, reloads the board and the card is back', async () => {
    let boardNow = board([]);
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/api/jobs/today') return boardNow;
      if (url.startsWith('/api/jobs?')) {
        return { items: [{ jobId: JOB_ID, jobNumber: 'SV-00031', queueNo: 5, plate: '5กก 3131', province: null, brand: 'Toyota', model: 'Vios', customerName: null, deliveredAt: '2026-09-30T03:00:00.000Z' }], page: 1, pageSize: 10, total: 1 };
      }
      if (url === `/api/jobs/${JOB_ID}`) return DELIVERED_DETAIL;
      throw new Error(`unexpected GET ${url}`);
    });
    apiPatch.mockImplementation(async () => {
      boardNow = board([READY_JOB]);
      return { jobId: JOB_ID, status: 'ready', subState: null, column: 4, statusChangedAt: '2026-09-30T04:00:00.000Z' };
    });

    await mount();
    expect(card()).toBeNull();

    await click(button('ส่งแล้ววันนี้'));
    await click(document.querySelector('.kb-dl-item')!);
    expect(document.body.textContent).toContain('สมชาย');
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));

    const box = document.querySelector<HTMLTextAreaElement>('#kb-undo-reason')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(box, '  กดส่งผิดคัน  ');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('ยืนยันย้อนกลับ'));
    await tick();

    expect(apiPatch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/status`, { to: 'ready', fromStatus: 'delivered', reason: 'กดส่งผิดคัน' });
    expect(document.querySelector('.modal-card')).toBeNull();
    expect(card()).not.toBeNull();
    expect(container.querySelector('[role="status"].kb-toast')?.textContent).toContain('ย้อนกลับแล้ว');
  });
});
