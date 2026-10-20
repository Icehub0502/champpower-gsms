// @vitest-environment happy-dom
/**
 * P3.1 polish — what ux-advocate found on the running quotation screen:
 * both totals always in view (CLAUDE.md §5.1 #3), the draft discount box that
 * held "0.00" as a real value, the catalog search focused after a draft is
 * created, and per-line decision buttons that name their line.
 * Layout itself (sticky, widths) cannot be measured here; these pin the DOM the
 * CSS relies on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { JobDetail, Quotation, Role } from '@gsms/contracts/index.js';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
vi.mock('../../lib/api/client', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    patch: (...a: unknown[]) => apiPatch(...a),
    put: vi.fn(),
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
import { JOB_ID, cutSetQuotation, line, next, quotation, totals } from './quoteFixtures';
import { button, click, field, flush, mount, type, type Mounted } from './quoteTestDom';

const JOB: JobDetail = {
  jobId: JOB_ID, jobNumber: 'SV-00042', queueNo: 7, status: 'quoted', statusLabel: 'เสนอราคา', subState: null,
  jobType: 'normal', source: 'walk_in', plate: '9ขข 4242', province: 'สมุทรปราการ', brand: 'Toyota', model: 'Vios',
  color: null, customerName: 'สมศรี', bayName: null, createdAt: '2026-10-12T01:00:00.000Z',
  statusChangedAt: '2026-10-12T02:00:00.000Z', onBoard: true, history: [], allowedMoves: ['approved', 'carout'], movesNeedingReason: [],
};

let current: Quotation | ApiError;

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPatch.mockReset();
  apiGet.mockImplementation(async (path: string) => {
    if (path.endsWith('/quotation')) {
      if (current instanceof ApiError) throw current;
      return current;
    }
    if (path.startsWith('/api/catalog/search')) return { items: [], vehicleModelLinked: true };
    return JOB;
  });
});

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(role: Role = 'advisor') {
  m = mount(
    <MemoryRouter initialEntries={[`/jobs/${JOB_ID}/quote`]}>
      <Routes>
        <Route path="/jobs/:jobId/quote" element={<QuoteRoute role={role} />} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
}

const draft = (over: Partial<Quotation> = {}) => quotation({
  status: 'draft', number: null,
  lines: [line({ name: 'ผ้าเบรก', lineTotal: '1000.00', unitPrice: '1000.00' })],
  totals: totals({ offeredSubtotal: '1000.00', offeredTotal: '1000.00' }),
  next: next({ canEditContent: true, canIssue: true }),
  ...over,
});

describe('#1 both totals stay in view', () => {
  it('a compact bar carries BOTH totals, from the server’s figures', async () => {
    current = quotation({
      lines: [line({ name: 'โช้คหลัง', lineTotal: '3000.00', unitPrice: '3000.00', approvalStatus: 'approved' })],
      totals: totals({ offeredSubtotal: '3000.00', offeredTotal: '3000.00', approvedSubtotal: '3000.00', approvedTotal: '2800.00' }),
    });
    await render();
    const bar = document.querySelector('[data-testid="totals-bar"]');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('ยอดเสนอ ฿3,000.00');
    expect(bar!.textContent).toContain('ยอดอนุมัติ ฿2,800.00');
  });

  it('after issue (no add panel) the full totals panel moves into the right column', async () => {
    current = quotation({ lines: [line({ name: 'โช้คหลัง' })] });
    await render();
    const panel = document.querySelector('section.qt-totals')!;
    expect(panel.closest('aside.qt-side')).not.toBeNull();
    expect(panel.closest('.qt-lines-card')).toBeNull();
    // The bar is only for screens without that column: CSS keeps it below 1024 only.
    expect(document.querySelector('[data-testid="totals-bar"]')!.classList.contains('is-with-catalog')).toBe(false);
  });

  it('in a draft the add panel keeps the right column; totals stay under the lines and the bar shows at every width', async () => {
    current = draft();
    await render();
    const panel = document.querySelector('section.qt-totals')!;
    expect(panel.closest('.qt-lines-card')).not.toBeNull();
    expect(document.querySelector('aside.qt-side section.qt-catalog')).not.toBeNull();
    expect(document.querySelector('[data-testid="totals-bar"]')!.classList.contains('is-with-catalog')).toBe(true);
  });
});

describe('#2 the draft discount box does not hold "0.00" as a value', () => {
  it('a zero discount shows an empty box with a placeholder', async () => {
    current = draft();
    await render();
    const box = field('ส่วนลดท้ายบิล') as HTMLInputElement;
    expect(box.value).toBe('');
    expect(box.placeholder).toBe('0.00');
  });

  it('typing 200 (appended to whatever the box shows, as a keyboard does) saves 200', async () => {
    current = draft();
    await render();
    const box = field('ส่วนลดท้ายบิล') as HTMLInputElement;
    type(box, `${box.value}200`);
    apiPatch.mockResolvedValueOnce(draft({ totals: totals({ offeredSubtotal: '1000.00', discount: '200.00', offeredDiscount: '200.00', offeredTotal: '800.00' }) }));
    click(button('บันทึกส่วนลด'));
    await flush();
    expect(apiPatch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/quotation`, { discount: '200' });
  });

  it('clearing a discount of 150 and saving sends "0"', async () => {
    current = draft({ totals: totals({ offeredSubtotal: '1000.00', discount: '150.00', offeredDiscount: '150.00', offeredTotal: '850.00' }) });
    await render();
    type(field('ส่วนลดท้ายบิล'), '');
    expect(button('บันทึกส่วนลด').disabled).toBe(false);
    apiPatch.mockResolvedValueOnce(draft());
    click(button('บันทึกส่วนลด'));
    await flush();
    expect(apiPatch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/quotation`, { discount: '0' });
  });

  it('a typed amount equal to the current discount leaves the save button disabled (nothing to save)', async () => {
    current = draft();
    await render();
    type(field('ส่วนลดท้ายบิล'), '200');
    type(field('ส่วนลดท้ายบิล'), ''); // emptied again: still no discount
    expect(button('บันทึกส่วนลด').disabled).toBe(true);
    type(field('ส่วนลดท้ายบิล'), '0.00');
    expect(button('บันทึกส่วนลด').disabled).toBe(true);
  });

  it('a non-zero discount is still shown as its value', async () => {
    current = draft({ totals: totals({ offeredSubtotal: '1000.00', discount: '150.00', offeredDiscount: '150.00', offeredTotal: '850.00' }) });
    await render();
    expect((field('ส่วนลดท้ายบิล') as HTMLInputElement).value).toBe('150.00');
  });
});

describe('#7 after a draft is created the catalog search has focus', () => {
  it('one click on "สร้างใบเสนอราคา" leaves the cursor in the search box', async () => {
    current = new ApiError(404, 'quotation_not_found', { error: 'quotation_not_found', message: 'x' });
    await render();
    apiPost.mockResolvedValueOnce(draft({ lines: [] , next: next({ canEditContent: true }) }));
    click(button('สร้างใบเสนอราคา'));
    await flush();
    const search = document.querySelector('section.qt-catalog input[type="search"]');
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it('only once: a later draft (issue, then revise) does not pull focus into the search again', async () => {
    current = new ApiError(404, 'quotation_not_found', { error: 'quotation_not_found', message: 'x' });
    await render();
    const created = draft();
    apiPost.mockResolvedValueOnce(created);
    click(button('สร้างใบเสนอราคา'));
    await flush();

    apiPost.mockResolvedValueOnce(quotation({ lines: created.lines, next: next({ canDecide: true, canRevise: true }) }));
    click(button('ออกใบเสนอราคา'));
    await flush();
    expect(document.querySelector('section.qt-catalog')).toBeNull();

    apiPost.mockResolvedValueOnce(draft({ revision: 2 }));
    click(button('ออกฉบับแก้ไข')); // opens the dialog
    click(document.querySelector('.modal-card button[type="submit"]') as HTMLButtonElement); // the dialog's own "ออกฉบับแก้ไข"
    await flush();
    const search = document.querySelector('section.qt-catalog input[type="search"]');
    expect(search).not.toBeNull();
    expect(document.activeElement).not.toBe(search);
  });

  it('opening an existing draft does NOT steal focus (only right after creating one)', async () => {
    current = draft();
    await render();
    const search = document.querySelector('section.qt-catalog input[type="search"]');
    expect(document.activeElement).not.toBe(search);
  });
});

describe('#6 focus on the first error after a real busy cycle (page + dialog + server refusal)', () => {
  it('the server refuses the set reason: once busy ends, the reason box (enabled again) has focus', async () => {
    const { q, head } = cutSetQuotation();
    current = q;
    await render();
    click(button('ยืนยันผลลูกค้า')); // opens the dialog
    const set = () => document.querySelector(`[data-set-id="${head.id}"]`)!;
    type(field('ยอดใหม่ของชุด', set()), '18000');
    type(field('เหตุผล', set()), 'x');

    let reject!: (e: unknown) => void;
    apiPost.mockReturnValueOnce(new Promise((_r, j) => { reject = j; }));
    click(document.querySelector('.modal-foot button[type="submit"]') as HTMLButtonElement);
    await flush();
    expect(document.querySelector('.modal-foot button[type="submit"]')!.textContent).toBe('กำลังยืนยัน...');
    expect((field('เหตุผล', set()) as HTMLInputElement).disabled).toBe(true);

    reject(new ApiError(400, 'invalid_request', {
      error: 'invalid_request', message: 'x', fields: { [`adjustments.setLines.${head.id}.reason`]: ['required'] },
    }));
    await flush();
    const reason = field('เหตุผล', set()) as HTMLInputElement;
    expect(reason.disabled).toBe(false);
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(reason);
  });
});

describe('#8 per-line decision buttons name their line', () => {
  it('approve and decline carry the line name in their accessible name', async () => {
    const a = line({ name: 'ผ้าเบรกหน้า', sortOrder: 1 });
    const b = line({ name: 'โช้คหลัง', sortOrder: 2, approvalStatus: 'declined', declineReason: 'too_expensive' });
    current = quotation({ lines: [a, b], next: next({ canDecide: true, undecidedLineIds: [a.id] }) });
    await render();
    expect(document.querySelector('button[aria-label="อนุมัติ ผ้าเบรกหน้า"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="ไม่อนุมัติ ผ้าเบรกหน้า"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="อนุมัติ โช้คหลัง"]')).not.toBeNull();
    // Visible text is part of the name (WCAG 2.5.3): a declined line's button says "เปลี่ยนเหตุผล".
    expect(document.querySelector('button[aria-label="เปลี่ยนเหตุผล โช้คหลัง"]')).not.toBeNull();
  });
});
