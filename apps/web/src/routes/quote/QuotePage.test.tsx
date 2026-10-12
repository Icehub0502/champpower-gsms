// @vitest-environment happy-dom
/**
 * The quotation page end to end against a mocked API client: who may open it,
 * that a mutation in flight disables every mutation button (a double tap must
 * not decide twice), that refusals arrive in Thai, and the two catalog
 * recoveries — "ราคานี้ถูกตั้งไปแล้วเป็น ฿X" and the similar-name warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CatalogSearchResult, JobDetail, Quotation, Role } from '@gsms/contracts/index.js';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
vi.mock('../../lib/api/client', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
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
import { JOB_ID, line, next, quotation, totals } from './quoteFixtures';
import { button, buttons, click, field, flush, mount, type, type Mounted } from './quoteTestDom';

const JOB: JobDetail = {
  jobId: JOB_ID, jobNumber: 'SV-00042', queueNo: 7, status: 'quoted', statusLabel: 'เสนอราคา', subState: null,
  jobType: 'normal', source: 'walk_in', plate: '9ขข 4242', province: 'สมุทรปราการ', brand: 'Toyota', model: 'Vios',
  color: null, customerName: 'สมศรี', bayName: null, createdAt: '2026-10-12T01:00:00.000Z',
  statusChangedAt: '2026-10-12T02:00:00.000Z', onBoard: true, history: [], allowedMoves: [], movesNeedingReason: [],
};

let current: Quotation | ApiError;
let search: CatalogSearchResult = { items: [], vehicleModelLinked: true };

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (path.endsWith('/quotation')) {
      if (current instanceof ApiError) throw current;
      return current;
    }
    if (path.startsWith('/api/catalog/search')) return search;
    return JOB;
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
