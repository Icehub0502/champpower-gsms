// @vitest-environment happy-dom
/**
 * "ส่งแล้ววันนี้" — the way back from a mistaken ส่งแล้ว (DECISION-carout.md §3):
 * today's delivered jobs, one job's history (who / when / why), and the undo,
 * which must carry a reason. The API client is mocked; everything else is real.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveredJobsPage, JobDetail } from '@gsms/contracts/index.js';
import { SessionCancelledError } from '../../lib/api/sessionCancelled';

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

import { ApiError } from '../../lib/api/client';
import { DeliveredPanel } from './DeliveredPanel';

const JOB_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_A = '00000000-0000-4000-8000-0000000000b1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';

function item(n: number): DeliveredJobsPage['items'][number] {
  return {
    jobId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    jobNumber: `SV-${String(n).padStart(5, '0')}`,
    queueNo: n,
    plate: `${n}กก ${1000 + n}`,
    province: null,
    brand: 'Toyota',
    model: 'Vios',
    customerName: `ลูกค้า${n}`,
    deliveredAt: '2026-09-30T08:15:00.000Z',
  };
}

function listPage(page: number, total: number, count: number): DeliveredJobsPage {
  return { items: Array.from({ length: count }, (_, i) => item((page - 1) * 10 + i + 1)), page, pageSize: 10, total };
}

const DETAIL: JobDetail = {
  jobId: JOB_ID,
  jobNumber: 'SV-00042',
  queueNo: 7,
  status: 'delivered',
  statusLabel: 'ส่งแล้ว',
  subState: null,
  jobType: 'normal',
  source: 'walk_in',
  plate: '9ขข 4242',
  province: 'สมุทรปราการ',
  brand: 'Honda',
  model: 'City',
  color: null,
  customerName: 'สมศรี',
  bayName: null,
  createdAt: '2026-09-30T01:00:00.000Z',
  statusChangedAt: '2026-09-30T09:30:00.000Z',
  onBoard: false,
  history: [
    { status: 'ready', statusLabel: 'พร้อมส่ง', changedAt: '2026-09-30T07:00:00.000Z', changedBy: { userId: USER_A, name: 'สมชาย' }, reason: null },
    { status: 'delivered', statusLabel: 'ส่งแล้ว', changedAt: '2026-09-30T08:00:00.000Z', changedBy: { userId: USER_A, name: 'สมชาย' }, reason: null },
    { status: 'ready', statusLabel: 'พร้อมส่ง', changedAt: '2026-09-30T08:10:00.000Z', changedBy: { userId: USER_B, name: 'สมหญิง' }, reason: 'กดผิดคัน ลูกค้ายังไม่มารับ' },
    { status: 'delivered', statusLabel: 'ส่งแล้ว', changedAt: '2026-09-30T09:30:00.000Z', changedBy: null, reason: null },
  ],
  allowedMoves: ['ready'],
  movesNeedingReason: ['ready'],
};

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const onUndone = vi.fn();

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  onClose.mockReset();
  onUndone.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  await act(async () => {
    root.render(<DeliveredPanel onClose={onClose} onUndone={onUndone} />);
    await new Promise((r) => setTimeout(r, 0));
  });
}

function button(text: string): HTMLButtonElement {
  const all = [...document.querySelectorAll('button')];
  const b = all.find((el) => el.textContent?.trim() === text) ?? all.find((el) => el.textContent?.includes(text));
  if (!b) throw new Error(`no button containing "${text}"`);
  return b as HTMLButtonElement;
}

function hasButton(text: string): boolean {
  return [...document.querySelectorAll('button')].some((el) => el.textContent?.includes(text));
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const reasonBox = () => document.querySelector<HTMLTextAreaElement>('#kb-undo-reason')!;

/** Serve the list and the one job. */
function serve(detail: JobDetail = DETAIL, list: (url: string) => DeliveredJobsPage = () => listPage(1, 2, 2)) {
  apiGet.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/jobs?')) return list(url);
    if (url === `/api/jobs/${detail.jobId}`) return detail;
    throw new Error(`unexpected GET ${url}`);
  });
}

async function openDetail(detail: JobDetail = DETAIL) {
  serve(detail, () => ({ ...listPage(1, 1, 1), items: [{ ...item(1), jobId: detail.jobId }] }));
  await mount();
  await click(document.querySelector<HTMLElement>('.kb-dl-item')!);
}

describe('the list', () => {
  it('asks for today’s delivered jobs, 10 to a page, and shows each car', async () => {
    serve();
    await mount();
    expect(apiGet).toHaveBeenCalledWith('/api/jobs?status=delivered&date=today&page=1&pageSize=10');
    const rows = [...document.querySelectorAll('.kb-dl-item')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('1กก 1001');
    expect(rows[0]!.textContent).toContain('SV-00001');
    expect(rows[0]!.textContent).toContain('ส่งเมื่อ');
    // One page: no pager.
    expect(document.querySelector('.kb-dl-pager')).toBeNull();
  });

  it('paginates: next fetches page 2, previous goes back, and the ends are disabled', async () => {
    serve(DETAIL, (url) => {
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      return listPage(page, 25, page === 3 ? 5 : 10);
    });
    await mount();
    expect(document.body.textContent).toContain('ส่งแล้ววันนี้ 25 คัน · หน้า 1 จาก 3');
    expect(button('ก่อนหน้า').disabled).toBe(true);

    await click(button('ถัดไป'));
    expect(apiGet).toHaveBeenLastCalledWith('/api/jobs?status=delivered&date=today&page=2&pageSize=10');
    expect(document.body.textContent).toContain('หน้า 2 จาก 3');
    expect(document.querySelector('.kb-dl-item')!.textContent).toContain('SV-00011');

    await click(button('ถัดไป'));
    expect(document.querySelectorAll('.kb-dl-item')).toHaveLength(5);
    expect(button('ถัดไป').disabled).toBe(true);

    await click(button('ก่อนหน้า'));
    expect(document.body.textContent).toContain('หน้า 2 จาก 3');
  });

  it('says so when nothing was delivered today, and offers a retry when the load fails', async () => {
    serve(DETAIL, () => listPage(1, 0, 0));
    await mount();
    expect(document.body.textContent).toContain('วันนี้ยังไม่มีรถที่ส่งแล้ว');

    apiGet.mockReset();
    apiGet.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(listPage(1, 1, 1));
    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('โหลดรายการที่ส่งแล้วไม่สำเร็จ');
    await click(button('ลองใหม่'));
    expect(document.querySelectorAll('.kb-dl-item')).toHaveLength(1);
  });
});

describe('a job’s history', () => {
  it('shows each status with its time, who moved it and why — including who undid a delivery', async () => {
    await openDetail();
    expect(apiGet).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}`);
    const entries = [...document.querySelectorAll('.kb-hist-item')];
    expect(entries).toHaveLength(4);
    // Newest first; a row with no recorded actor says so instead of guessing.
    expect(entries[0]!.textContent).toContain('ส่งแล้ว');
    expect(entries[0]!.textContent).toContain('ไม่ทราบผู้ทำรายการ');
    // The undo: who, why, and the words that say it is an undo.
    const undo = entries[1]!;
    expect(undo.classList.contains('is-undo')).toBe(true);
    expect(undo.textContent).toContain('พร้อมส่ง');
    expect(undo.textContent).toContain('ย้อนกลับจากส่งแล้ว');
    expect(undo.textContent).toContain('โดย สมหญิง');
    expect(undo.textContent).toContain('เหตุผล: กดผิดคัน ลูกค้ายังไม่มารับ');
    expect(entries[2]!.textContent).toContain('โดย สมชาย');
    expect(entries[2]!.classList.contains('is-undo')).toBe(false);
    // A time is shown on every row.
    for (const e of entries) expect(e.querySelector('.kb-hist-meta')!.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it('shows the job summary above the history', async () => {
    await openDetail();
    const summary = document.querySelector('.kb-dl-summary')!.textContent!;
    expect(summary).toContain('SV-00042');
    expect(summary).toContain('Honda City');
    expect(summary).toContain('9ขข 4242 สมุทรปราการ');
    expect(summary).toContain('สมศรี');
  });

  it('a job that cannot be found says so', async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/jobs?')) return { ...listPage(1, 1, 1), items: [{ ...item(1), jobId: JOB_ID }] };
      throw new ApiError(404, 'job_not_found');
    });
    await mount();
    await click(document.querySelector<HTMLElement>('.kb-dl-item')!);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('ไม่พบใบงานนี้');
  });
});

describe('undoing a delivery', () => {
  it('offers the undo only when the server’s allowedMoves includes ready', async () => {
    await openDetail();
    expect(hasButton('ย้อนกลับเป็นพร้อมส่ง')).toBe(true);
  });

  it('a viewer (allowedMoves empty) gets no undo button, and is told why', async () => {
    await openDetail({ ...DETAIL, allowedMoves: [], movesNeedingReason: [] });
    expect(hasButton('ย้อนกลับเป็นพร้อมส่ง')).toBe(false);
    expect(document.body.textContent).toContain('บัญชีนี้ย้อนกลับรายการส่งแล้วไม่ได้');
    // The history is still there to read.
    expect(document.querySelectorAll('.kb-hist-item')).toHaveLength(4);
  });

  it('will not send without a reason — empty or only spaces', async () => {
    await openDetail();
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    await click(button('ยืนยันย้อนกลับ'));
    expect(apiPatch).not.toHaveBeenCalled();
    expect(document.querySelector('#kb-undo-error')!.textContent).toContain('กรุณากรอกเหตุผล');
    expect(reasonBox().getAttribute('aria-invalid')).toBe('true');

    type(reasonBox(), '     ');
    await click(button('ยืนยันย้อนกลับ'));
    expect(apiPatch).not.toHaveBeenCalled();
    expect(document.querySelector('#kb-undo-error')).not.toBeNull();
  });

  it('shows a counter over the trimmed text and blocks a reason over 500', async () => {
    await openDetail();
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    type(reasonBox(), '  abc  ');
    expect(document.querySelector('#kb-undo-count')!.textContent).toBe('3/500');

    type(reasonBox(), 'x'.repeat(503));
    expect(document.querySelector('#kb-undo-count')!.textContent).toContain('503/500');
    expect(document.querySelector('#kb-undo-count')!.textContent).toContain('เกิน 3');
    await click(button('ยืนยันย้อนกลับ'));
    expect(apiPatch).not.toHaveBeenCalled();
    expect(document.querySelector('#kb-undo-error')!.textContent).toContain('ไม่เกิน 500');
  });

  it('sends { to: ready, fromStatus: delivered, reason } with the reason TRIMMED, then reports it', async () => {
    apiPatch.mockResolvedValue({ jobId: JOB_ID, status: 'ready', subState: null, column: 4, statusChangedAt: '2026-09-30T10:00:00.000Z' });
    await openDetail();
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    type(reasonBox(), '   กดผิดคัน   ');
    await click(button('ยืนยันย้อนกลับ'));

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/status`, {
      to: 'ready',
      fromStatus: 'delivered',
      reason: 'กดผิดคัน',
    });
    expect(onUndone).toHaveBeenCalledTimes(1);
    expect(onUndone.mock.calls[0]![0].jobId).toBe(JOB_ID);
  });

  it('the confirm button is disabled while the request is on the wire, so a second tap sends nothing', async () => {
    let resolve!: (v: unknown) => void;
    apiPatch.mockReturnValue(new Promise((r) => (resolve = r)));
    await openDetail();
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    type(reasonBox(), 'กดผิด');
    await click(button('ยืนยันย้อนกลับ'));

    const pending = button('กำลังบันทึก');
    expect(pending.disabled).toBe(true);
    expect(button('ยกเลิก').disabled).toBe(true);
    expect(reasonBox().disabled).toBe(true);
    await click(pending);
    expect(apiPatch).toHaveBeenCalledTimes(1);

    // Esc must not abandon a request that is in flight.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolve({ jobId: JOB_ID, status: 'ready', subState: null, column: 4, statusChangedAt: '2026-09-30T10:00:00.000Z' });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(onUndone).toHaveBeenCalledTimes(1);
  });

  it('a 400 that names the reason box is read through the contract schema and shown on the box', async () => {
    apiPatch.mockRejectedValue(new ApiError(400, 'invalid_request', { error: 'invalid_request', fields: { reason: ['not_allowed'] } }));
    await openDetail();
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    type(reasonBox(), 'กดผิด');
    await click(button('ยืนยันย้อนกลับ'));
    expect(document.querySelector('#kb-undo-error')!.textContent).toContain('ไม่รับเหตุผล');
    expect(onUndone).not.toHaveBeenCalled();
    // Button is usable again.
    expect(button('ยืนยันย้อนกลับ').disabled).toBe(false);
  });

  it('a 400 in a shape the contract does not know is an unknown error, not a guess', async () => {
    apiPatch.mockRejectedValue(new ApiError(400, 'invalid_request', { error: 'invalid_request', fields: { reason: 'oops' } }));
    await openDetail();
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    type(reasonBox(), 'กดผิด');
    await click(button('ยืนยันย้อนกลับ'));
    expect(document.querySelector('#kb-undo-error')).toBeNull();
    expect(document.querySelector('.kb-sheet-error')!.textContent).toContain('บันทึกไม่สำเร็จ');
  });

  it('409 illegal_status_move: says the job moved on, and re-reads the job so the button can go', async () => {
    apiPatch.mockRejectedValue(new ApiError(409, 'illegal_status_move'));
    await openDetail();
    const getsBefore = apiGet.mock.calls.length;
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    type(reasonBox(), 'กดผิด');
    await click(button('ยืนยันย้อนกลับ'));
    expect(document.body.textContent).toContain('ย้อนกลับงานนี้ไม่ได้');
    expect(apiGet.mock.calls.length).toBeGreaterThan(getsBefore);
  });

  it('a request cancelled by logout / user switch is silent: no message, no success', async () => {
    apiPatch.mockRejectedValue(new SessionCancelledError());
    await openDetail();
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    type(reasonBox(), 'กดผิด');
    await click(button('ยืนยันย้อนกลับ'));
    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.kb-sheet-error')).toBeNull();
    expect(document.querySelector('#kb-undo-error')).toBeNull();
    expect(onUndone).not.toHaveBeenCalled();
  });

  it('ยกเลิก backs out to the button without sending', async () => {
    await openDetail();
    await click(button('ย้อนกลับเป็นพร้อมส่ง'));
    await click(button('ยกเลิก'));
    expect(apiPatch).not.toHaveBeenCalled();
    expect(document.querySelector('.kb-undo')).toBeNull();
    expect(hasButton('ย้อนกลับเป็นพร้อมส่ง')).toBe(true);
    await flush();
  });
});
