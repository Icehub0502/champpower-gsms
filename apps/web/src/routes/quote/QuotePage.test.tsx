// @vitest-environment happy-dom
/**
 * The quotation page end to end against a mocked API client: who may open it,
 * that a mutation in flight disables every mutation button (a double tap must
 * not decide twice), that refusals arrive in Thai, and the two catalog
 * recoveries — "ราคานี้ถูกตั้งไปแล้วเป็น ฿X" and the similar-name warning.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CatalogSearchResult, JobDetail, Quotation, Role } from '@gsms/contracts/index.js';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiPut = vi.fn();
vi.mock('../../lib/api/client', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
    put: (...a: unknown[]) => apiPut(...a),
    del: vi.fn(),
  },
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
vi.mock('../../lib/api/socket', () => ({ getSocket: () => ({ on: vi.fn(), off: vi.fn() }) }));

import { ApiError } from '../../lib/api/client';
import { QuoteRoute } from './QuotePage';
import { JOB_ID, VEHICLE_ID, cutSetQuotation, line, next, quotation, totals } from './quoteFixtures';

const MODEL_ID = '00000000-0000-4000-8000-0000000000b9';
import { button, buttons, click, field, flush, mount, type, type Mounted } from './quoteTestDom';

const JOB: JobDetail = {
  jobId: JOB_ID, jobNumber: 'SV-00042', queueNo: 7, status: 'quoted', statusLabel: 'เสนอราคา', subState: null,
  jobType: 'normal', source: 'walk_in', plate: '9ขข 4242', province: 'สมุทรปราการ', brand: 'Toyota', model: 'Vios',
  color: null, customerName: 'สมศรี', bayName: null, createdAt: '2026-10-12T01:00:00.000Z',
  statusChangedAt: '2026-10-12T02:00:00.000Z', onBoard: true, history: [], allowedMoves: ['approved', 'rejected', 'carout'], movesNeedingReason: [],
};

let current: Quotation | ApiError;
let currentJob: JobDetail;
let search: CatalogSearchResult = { items: [], vehicleModelLinked: true };

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiPut.mockReset();
  currentJob = JOB;
  apiGet.mockImplementation(async (path: string) => {
    if (path.endsWith('/quotation')) {
      if (current instanceof ApiError) throw current;
      return current;
    }
    if (path.startsWith('/api/catalog/search')) return search;
    if (path.startsWith('/api/vehicle-models')) return { items: [{ id: MODEL_ID, brand: 'Chevrolet', name: 'Colorado', yearRange: null }], total: 1 };
    return currentJob;
  });
});

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(role: Role) {
  m = mount(
    <MemoryRouter initialEntries={[`/jobs/${JOB_ID}/quote`]}>
      <Routes>
        <Route path="/jobs/:jobId/quote" element={<QuoteRoute role={role} />} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('who may open it', () => {
  it('a technician gets no page and no request is made (he sees no prices)', async () => {
    current = quotation();
    await render('technician');
    expect(apiGet).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('เปิดได้เฉพาะหน้าร้านและผู้จัดการ');
  });

  it('a viewer sees the quotation and both totals, with no button that changes anything', async () => {
    current = quotation({ lines: [line({ name: 'ผ้าเบรก', lineTotal: '1200.00', unitPrice: '1200.00' })], totals: totals({ offeredTotal: '1200.00' }) });
    await render('viewer');
    expect(document.body.textContent).toContain('ผ้าเบรก');
    expect(document.querySelector('[data-testid="offered-total"]')!.textContent).toContain('฿1,200.00');
    expect(document.querySelector('[data-testid="approved-total"]')).not.toBeNull();
    expect(buttons(/อนุมัติ|ยืนยันผลลูกค้า|ออกฉบับแก้ไข/)).toHaveLength(0);
  });

  it('no quotation yet: the counter is offered "สร้างใบเสนอราคา"', async () => {
    current = new ApiError(404, 'quotation_not_found', { error: 'quotation_not_found', message: 'x' });
    await render('advisor');
    expect(button('สร้างใบเสนอราคา')).toBeTruthy();
  });
});

describe('a mutation in flight', () => {
  it('disables every mutation button until the server answers, and a second tap sends nothing', async () => {
    const a = line({ name: 'ผ้าเบรกหน้า', lineTotal: '1200.00', unitPrice: '1200.00', sortOrder: 1 });
    const b = line({ name: 'โช้คหลัง', lineTotal: '3000.00', unitPrice: '3000.00', sortOrder: 2 });
    current = quotation({ lines: [a, b], next: next({ canDecide: true, canRevise: true, undecidedLineIds: [a.id, b.id] }) });
    await render('advisor');

    const answer = deferred<Quotation>();
    apiPatch.mockReturnValueOnce(answer.promise);
    const approveA = buttons('อนุมัติ')[0]!;
    click(approveA);
    await flush();

    expect(apiPatch).toHaveBeenCalledTimes(1);
    expect(apiPatch.mock.calls[0]![0]).toBe(`/api/jobs/${JOB_ID}/quotation/lines/${a.id}/decision`);
    expect(document.body.textContent).toContain('กำลังบันทึก...');
    for (const b2 of [...buttons(/^(อนุมัติ|ไม่อนุมัติ|กำลังบันทึก\.\.\.)$/), button('ออกฉบับแก้ไข')]) expect(b2.disabled).toBe(true);

    click(buttons(/^(อนุมัติ|กำลังบันทึก\.\.\.)$/)[1]!); // the other line's approve, while busy
    await flush();
    expect(apiPatch).toHaveBeenCalledTimes(1);

    answer.resolve(quotation({
      lines: [{ ...a, approvalStatus: 'approved' }, b],
      next: next({ canDecide: true, canRevise: true, undecidedLineIds: [b.id] }),
    }));
    await flush();
    expect(button('ออกฉบับแก้ไข').disabled).toBe(false);
    expect(document.querySelector(`[data-line-id="${a.id}"]`)!.textContent).toContain('อนุมัติ');
  });
});

describe('refusals in Thai', () => {
  it('issuing without a QUO series says what is wrong and that it is not the counter’s fault', async () => {
    current = quotation({ status: 'draft', number: null, lines: [line({ name: 'น้ำมันเครื่อง' })], next: next({ canEditContent: true, canIssue: true }) });
    await render('advisor');
    apiPost.mockRejectedValueOnce(new ApiError(409, 'document_series_missing', { error: 'document_series_missing', message: 'x' }));
    click(button('ออกใบเสนอราคา'));
    await flush();
    expect(document.body.textContent).toContain('สาขานี้ยังไม่ได้ตั้งเลขที่ใบเสนอราคา');
    expect(button('ออกใบเสนอราคา').disabled).toBe(false);
  });
});

describe('adding from the catalog', () => {
  const ITEM = '00000000-0000-4000-8000-0000000000e1';
  const draft = () => quotation({ status: 'draft', number: null, next: next({ canEditContent: true }) });

  it('no price yet -> first price -> "ราคานี้ถูกตั้งไปแล้วเป็น ฿X" -> use X adds the line without an override', async () => {
    current = draft();
    search = {
      vehicleModelLinked: true,
      items: [{
        section: 'other', itemId: ITEM, offeredItemId: null, category: 'ช่วงล่าง', name: 'ลูกหมากกันโคลง', lineType: 'part',
        unit: null, defaultQty: '1', isSet: false, componentCount: 0, price: null, priceSource: 'none', priceRefId: null, warranty: null,
      }],
    };
    await render('advisor');
    type(document.querySelector('input[type="search"]') as HTMLInputElement, 'ลูกหมาก');
    await flush(250);
    click(button(/ลูกหมากกันโคลง/));
    expect(document.body.textContent).toContain('ยังไม่มีราคาสำหรับรถคันนี้');

    apiPost.mockRejectedValueOnce(new ApiError(409, 'price_already_set', {
      error: 'price_already_set', message: 'x', existingPrice: '1250.00', scope: 'model',
    }));
    type(field('ราคาต่อหน่วย'), '1200');
    click(button('บันทึกราคาและเพิ่ม'));
    await flush();
    expect(apiPost.mock.calls[0]).toEqual(['/api/catalog/prices', { jobId: JOB_ID, itemId: ITEM, price: '1200' }]);
    expect(document.body.textContent).toContain('ราคานี้ถูกตั้งไปแล้วเป็น ฿1,250.00');

    apiPost.mockResolvedValueOnce(draft());
    click(button('ใช้ ฿1,250.00'));
    await flush();
    expect(apiPost.mock.calls[1]).toEqual([`/api/jobs/${JOB_ID}/quotation/lines`, { kind: 'item', itemId: ITEM }]);
  });

  it('…or keeps the typed price for this quotation only', async () => {
    current = draft();
    await render('advisor');
    type(document.querySelector('input[type="search"]') as HTMLInputElement, 'ลูกหมาก');
    await flush(250);
    click(button(/ลูกหมากกันโคลง/));
    apiPost.mockRejectedValueOnce(new ApiError(409, 'price_already_set', { error: 'price_already_set', message: 'x', existingPrice: '1250.00', scope: 'base' }));
    type(field('ราคาต่อหน่วย'), '1200');
    click(button('บันทึกราคาและเพิ่ม'));
    await flush();
    apiPost.mockResolvedValueOnce(draft());
    click(button('ใช้ ฿1,200.00 เฉพาะใบนี้'));
    await flush();
    expect(apiPost.mock.calls[1]).toEqual([`/api/jobs/${JOB_ID}/quotation/lines`, { kind: 'item', itemId: ITEM, unitPrice: '1200' }]);
  });

  it('a hand-typed name close to an existing one asks "ใช่อันเดียวกันไหม" and can use the existing item', async () => {
    current = draft();
    search = { vehicleModelLinked: true, items: [] };
    await render('advisor');
    click(button(/เพิ่มรายการใหม่/));
    type(field('ชื่อสินค้า/บริการ'), 'ลูกหมากปีกนกล่าง L/R');
    type(field('หมวดหมู่'), 'ช่วงล่าง');
    type(field('ราคาต่อหน่วย'), '850');
    apiPost.mockRejectedValueOnce(new ApiError(409, 'similar_item_found', {
      error: 'similar_item_found', message: 'x', similar: [{ id: ITEM, category: 'ช่วงล่าง', name: 'ลูกหมากปีกนกล่าง L+R' }],
    }));
    click(button('เพิ่ม'));
    await flush();
    expect(document.body.textContent).toContain('คล้ายกับ “ลูกหมากปีกนกล่าง L+R” ที่มีอยู่แล้ว ใช่อันเดียวกันไหม');

    apiPost.mockResolvedValueOnce(draft());
    click(button(/ใช้ของเดิม/));
    await flush();
    expect(apiPost.mock.calls[1]![1]).toMatchObject({ kind: 'free', useExistingItemId: ITEM, addToCatalog: true });
  });
});

describe('matching the car to a model (v3 §4.2)', () => {
  const draft = (linked: boolean) =>
    quotation({ status: 'draft', number: null, vehicleModelLinked: linked, next: next({ canEditContent: true }) });

  it('no picker when the car is already matched', async () => {
    current = draft(true);
    await render('advisor');
    expect(buttons('เลือกรุ่นรถ')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('ยังไม่ได้จับคู่กับรุ่น');
  });

  it('not matched: the picker shows, and choosing a model PUTs it on THIS car, then reloads', async () => {
    current = draft(false);
    await render('advisor');
    expect(document.body.textContent).toContain('ยังไม่ได้จับคู่กับรุ่น');
    click(button('เลือกรุ่นรถ'));
    await flush(250);
    apiPut.mockResolvedValueOnce({ vehicleId: VEHICLE_ID, vehicleModelId: MODEL_ID });
    const getsBefore = apiGet.mock.calls.filter((c) => String(c[0]).endsWith('/quotation')).length;
    click(button(/Chevrolet Colorado/));
    await flush();
    expect(apiPut).toHaveBeenCalledWith(`/api/vehicles/${VEHICLE_ID}/model`, { vehicleModelId: MODEL_ID });
    expect(apiGet.mock.calls.filter((c) => String(c[0]).endsWith('/quotation')).length).toBe(getsBefore + 1);
  });
});

describe('"ยืนยันผลลูกค้า" opens from next.canOpenConfirm', () => {
  it('disabled while the server says no, even with every line decided', async () => {
    const { q } = cutSetQuotation();
    current = { ...q, next: { ...q.next, canOpenConfirm: false } };
    await render('advisor');
    expect(button('ยืนยันผลลูกค้า').disabled).toBe(true);
  });

  it('opens the dialog when canOpenConfirm is true — although a cut set still lacks its amount', async () => {
    const { q } = cutSetQuotation(); // canConfirm false, canOpenConfirm true
    current = q;
    await render('advisor');
    click(button('ยืนยันผลลูกค้า'));
    expect(document.querySelector('.qt-confirm')).not.toBeNull();
    expect(document.body.textContent).toContain('ยอดใหม่ของชุด');
  });
});

describe('ไม่อนุมัติ (close the job) — Q1', () => {
  it('with lines still unanswered, a reason is required before anything is sent, and chose_alternative is not offered', async () => {
    const a = line({ name: 'โช้คหลัง', sortOrder: 1 });
    current = quotation({ lines: [a], next: next({ canDecide: true, undecidedLineIds: [a.id] }) });
    await render('advisor');
    click(button('ไม่อนุมัติ (ปิดงาน)…'));
    expect(document.body.textContent).toContain('ลูกค้ายังไม่ได้ตอบอีก 1 รายการ');
    const select = field('ทำไมลูกค้าไม่เอา') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).not.toContain('chose_alternative');

    click(button('ยืนยันไม่อนุมัติ'));
    await flush();
    expect(apiPatch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('เลือกเหตุผลก่อน');

    apiPatch.mockResolvedValueOnce({ jobId: JOB_ID, status: 'rejected', subState: null, column: null, statusChangedAt: '2026-10-12T05:00:00.000Z' });
    type(select, 'too_expensive');
    click(button('ยืนยันไม่อนุมัติ'));
    await flush();
    expect(apiPatch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/status`, { to: 'rejected', fromStatus: 'quoted', declineReason: 'too_expensive' });
    expect(document.body.textContent).toContain('ปิดงานเป็น “ไม่อนุมัติ” แล้ว');
  });

  it('the server’s "declineReason required" lands next to the reason box', async () => {
    const a = line({ name: 'โช้คหลัง' });
    current = quotation({ lines: [a], next: next({ canDecide: true, undecidedLineIds: [a.id] }) });
    await render('advisor');
    click(button('ไม่อนุมัติ (ปิดงาน)…'));
    apiPatch.mockRejectedValueOnce(new ApiError(400, 'invalid_request', { error: 'invalid_request', message: 'x', fields: { declineNote: ['required'] } }));
    type(field('ทำไมลูกค้าไม่เอา'), 'going_elsewhere');
    click(button('ยืนยันไม่อนุมัติ'));
    await flush();
    const note = field('รายละเอียด').closest('label')!;
    expect(note.querySelector('.ci-field-error')!.textContent).toBe('จำเป็นต้องกรอก');
  });

  it('nothing unanswered: no reason asked, just a confirmation', async () => {
    current = quotation({ status: 'signed', lines: [line({ name: 'x', approvalStatus: 'declined', declineReason: 'next_time' })], next: next() });
    await render('advisor');
    click(button('ไม่อนุมัติ (ปิดงาน)…'));
    expect(document.querySelector('select')).toBeNull();
    apiPatch.mockResolvedValueOnce({ jobId: JOB_ID, status: 'rejected', subState: null, column: null, statusChangedAt: '2026-10-12T05:00:00.000Z' });
    click(button('ยืนยันไม่อนุมัติ'));
    await flush();
    expect(apiPatch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/status`, { to: 'rejected', fromStatus: 'quoted' });
  });
});

describe('M3 — the job read is refreshed after a step that moves the job', () => {
  it('after confirm, the header shows the job status the server now reports', async () => {
    const a = line({ name: 'ผ้าเบรก', approvalStatus: 'approved', lineTotal: '1200.00', unitPrice: '1200.00' });
    current = quotation({ lines: [a], next: next({ canDecide: true, canOpenConfirm: true, canConfirm: true }) });
    await render('advisor');
    expect(document.querySelector('.qt-header')!.textContent).toContain('สถานะงาน เสนอราคา');

    // The confirm moved the job to approved on the server.
    currentJob = { ...JOB, status: 'approved', statusLabel: 'อนุมัติ', allowedMoves: ['repairing'] };
    apiPost.mockResolvedValueOnce({ ...quotation({ status: 'signed', lines: [a], next: next() }), jobStatusUnchanged: null });
    click(button('ยืนยันผลลูกค้า'));
    click(document.querySelector('.qt-confirm button[type="submit"]') as HTMLButtonElement); // the dialog's submit
    await flush();
    expect(document.querySelector('.qt-header')!.textContent).toContain('สถานะงาน อนุมัติ');
    // allowedMoves came with it: rejecting is no longer offered.
    expect(buttons('ไม่อนุมัติ (ปิดงาน)…')).toHaveLength(0);
  });

  it('a status_changed refusal on reject refetches the job too', async () => {
    current = quotation({ status: 'signed', lines: [line({ name: 'x', approvalStatus: 'declined', declineReason: 'next_time' })], next: next() });
    await render('advisor');
    const before = apiGet.mock.calls.filter((c) => c[0] === `/api/jobs/${JOB_ID}`).length;
    click(button('ไม่อนุมัติ (ปิดงาน)…'));
    apiPatch.mockRejectedValueOnce(new ApiError(409, 'status_changed', { error: 'status_changed', message: 'x', currentStatus: 'approved' }));
    click(button('ยืนยันไม่อนุมัติ'));
    await flush();
    expect(apiGet.mock.calls.filter((c) => c[0] === `/api/jobs/${JOB_ID}`).length).toBe(before + 1);
    expect(document.body.textContent).toContain('มีคนเปลี่ยนสถานะงานนี้ไปแล้ว');
  });
});

describe('M2 — the server asks for a reason the screen did not expect', () => {
  it('a 400 declineReason opens the reason form with a note, and reloads the quotation', async () => {
    // On screen: a stale draft — so the web thinks no reason is needed.
    current = quotation({ status: 'draft', number: null, lines: [line({ name: 'โช้คหลัง' })], next: next({ canEditContent: true, canIssue: true }) });
    await render('advisor');
    click(button('ไม่อนุมัติ (ปิดงาน)…'));
    expect(document.querySelector('select')).toBeNull();
    const quoteGets = () => apiGet.mock.calls.filter((c) => String(c[0]).endsWith('/quotation')).length;
    const before = quoteGets();

    apiPatch.mockRejectedValueOnce(new ApiError(400, 'invalid_request', { error: 'invalid_request', message: 'x', fields: { declineReason: ['required'] } }));
    click(button('ยืนยันไม่อนุมัติ'));
    await flush();
    expect(document.querySelector('select')).not.toBeNull();
    expect(document.body.textContent).toContain('มีรายการที่ลูกค้ายังไม่ได้ตัดสิน กรุณาเลือกเหตุผล');
    expect(quoteGets()).toBe(before + 1);

    apiPatch.mockResolvedValueOnce({ jobId: JOB_ID, status: 'rejected', subState: null, column: null, statusChangedAt: '2026-10-12T05:00:00.000Z' });
    type(field('ทำไมลูกค้าไม่เอา'), 'not_needed_yet');
    click(button('ยืนยันไม่อนุมัติ'));
    await flush();
    expect(apiPatch.mock.calls[1]![1]).toEqual({ to: 'rejected', fromStatus: 'quoted', declineReason: 'not_needed_yet' });
  });
});

describe('double tap in the same tick', () => {
  it('two approve clicks before any re-render send ONE request (busyRef, not only state)', async () => {
    const a = line({ name: 'ผ้าเบรกหน้า', sortOrder: 1 });
    current = quotation({ lines: [a], next: next({ canDecide: true, undecidedLineIds: [a.id] }) });
    await render('advisor');
    apiPatch.mockReturnValue(new Promise(() => {}));
    const approve = buttons('อนุมัติ')[0]!;
    // Both clicks inside ONE act: React has not re-rendered, so the button is still enabled for the second.
    act(() => {
      approve.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      approve.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(apiPatch).toHaveBeenCalledTimes(1);
  });
});

describe('discount save (draft)', () => {
  it('after a successful save the box shows the server’s value, not the typed text', async () => {
    current = quotation({ status: 'draft', number: null, lines: [line({ name: 'ผ้าเบรก', lineTotal: '1000.00', unitPrice: '1000.00' })], next: next({ canEditContent: true }) });
    await render('advisor');
    type(field('ส่วนลดท้ายบิล'), '450');
    apiPatch.mockResolvedValueOnce(quotation({
      status: 'draft', number: null, lines: [line({ name: 'ผ้าเบรก', lineTotal: '1000.00', unitPrice: '1000.00' })],
      totals: totals({ discount: '450.00', offeredSubtotal: '1000.00', offeredDiscount: '450.00', offeredTotal: '550.00' }),
      next: next({ canEditContent: true }),
    }));
    click(button('บันทึกส่วนลด'));
    await flush();
    expect(apiPatch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/quotation`, { discount: '450' });
    expect((field('ส่วนลดท้ายบิล') as HTMLInputElement).value).toBe('450.00');
  });
});

describe('line price save (draft)', () => {
  it('after a successful save the price box shows the server’s value; after a refusal it keeps the typed text', async () => {
    const a = line({ name: 'ผ้าเบรก', lineTotal: '1000.00', unitPrice: '1000.00' });
    current = quotation({ status: 'draft', number: null, lines: [a], next: next({ canEditContent: true }) });
    await render('advisor');
    const box = () => document.querySelector(`[data-line-id="${a.id}"] input[aria-label="ราคาต่อหน่วย"]`) as HTMLInputElement;

    apiPatch.mockRejectedValueOnce(new ApiError(400, 'invalid_request', { error: 'invalid_request', message: 'x', fields: { unitPrice: ['out_of_range'] } }));
    type(box(), '9999999999');
    act(() => { box().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await flush();
    expect(box().value).toBe('9999999999');

    apiPatch.mockResolvedValueOnce(quotation({ status: 'draft', number: null, lines: [{ ...a, unitPrice: '1200.00', lineTotal: '1200.00' }], next: next({ canEditContent: true }) }));
    type(box(), '1200');
    act(() => { box().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    await flush();
    expect(box().value).toBe('1200.00');
  });
});
