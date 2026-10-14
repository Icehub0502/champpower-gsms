// @vitest-environment happy-dom
/**
 * What the lines and totals must always show: both totals (CLAUDE.md §5.1 #3),
 * declined lines still on screen with their reason (§5.1 #2), the "ต้องกรอก
 * ยอดใหม่ก่อนยืนยัน" label on a cut set (D10), and on a revision the split
 * between decisions carried from the earlier one and lines to ask again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api/client', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
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

import { QuoteLines } from './QuoteLines';
import { revisionMark } from './quoteView';
import { QuoteTotalsPanel } from './QuoteTotalsPanel';
import { cutSetQuotation, line, quotation, totals, next } from './quoteFixtures';
import { field, flush, mount, submit, type, type Mounted } from './quoteTestDom';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const run = vi.fn();

describe('the two totals', () => {
  it('shows the offered and the approved total side by side, as the server sent them', () => {
    m = mount(
      <QuoteTotalsPanel
        totals={totals({
          offeredSubtotal: '23500.00', offeredDiscount: '500.00', offeredTotal: '23000.00',
          approvedSubtotal: '18000.00', approvedDiscount: '500.00', approvedTotal: '17500.00', discount: '500.00',
        })}
        discountEditable={false}
        busy={false}
      />,
    );
    const offered = m.container.querySelector('[data-testid="offered-total"]')!;
    const approved = m.container.querySelector('[data-testid="approved-total"]')!;
    expect(offered.textContent).toContain('ยอดเสนอทั้งหมด');
    expect(offered.textContent).toContain('฿23,000.00');
    expect(offered.textContent).toContain('฿23,500.00');
    expect(approved.textContent).toContain('ยอดที่ลูกค้าอนุมัติ');
    expect(approved.textContent).toContain('฿17,500.00');
    expect(approved.textContent).toContain('−฿500.00');
  });

  it('still shows the approved total when nothing is approved yet (฿0.00, not hidden)', () => {
    m = mount(<QuoteTotalsPanel totals={totals({ offeredTotal: '900.00' })} discountEditable={false} busy={false} />);
    expect(m.container.querySelector('[data-testid="approved-total"]')!.textContent).toContain('฿0.00');
  });
});

describe('lines', () => {
  it('a cut set carries "ต้องกรอกยอดใหม่ก่อนยืนยัน", and the declined piece stays on screen with its reason', () => {
    const { q, head, cut } = cutSetQuotation();
    m = mount(<QuoteLines jobId={q.jobId} quotation={q} canWrite busy={null} run={run} />);
    const headRow = m.container.querySelector(`[data-line-id="${head.id}"]`)!;
    expect(headRow.textContent).toContain('ต้องกรอกยอดใหม่ก่อนยืนยัน');
    const cutRow = m.container.querySelector(`[data-line-id="${cut.id}"]`)!;
    expect(cutRow.textContent).toContain('ตั้งศูนย์');
    expect(cutRow.textContent).toContain('ไม่อนุมัติ · ยังไม่จำเป็น');
  });

  it('an agreed set amount reads "เสนอ X → ตกลง Y"', () => {
    const head = line({ name: 'ชุดโปร', lineTotal: '20000.00', unitPrice: '20000.00', approvalStatus: 'approved', approvedAmount: '18500.00' });
    const q = quotation({ status: 'signed', lines: [head], next: next() });
    m = mount(<QuoteLines jobId={q.jobId} quotation={q} canWrite busy={null} run={run} />);
    expect(m.container.textContent).toContain('เสนอ ฿20,000.00 → ตกลง ฿18,500.00');
  });
});

describe('a revision: carried decisions vs ask again', () => {
  const carried = line({ name: 'ผ้าเบรกหน้า', approvalStatus: 'approved', decisionCarriedFrom: '00000000-0000-4000-8000-00000000c001', sortOrder: 1 });
  const fresh = line({ name: 'โช้คหลัง', approvalStatus: 'pending', decisionCarriedFrom: null, sortOrder: 2 });
  const rev2 = quotation({ revision: 2, supersedesDocumentId: '00000000-0000-4000-8000-00000000d000', lines: [carried, fresh] });

  it('labels each line from decisionCarriedFrom only', () => {
    expect(revisionMark(rev2, carried)).toBe('carried');
    expect(revisionMark(rev2, fresh)).toBe('ask');
    expect(revisionMark(quotation({ lines: [fresh] }), fresh)).toBeNull(); // revision 1: no labels
  });

  it('puts the two kinds in separate, named sections', () => {
    m = mount(<QuoteLines jobId={rev2.jobId} quotation={rev2} canWrite busy={null} run={run} />);
    const ask = m.container.querySelector('section[aria-label="ต้องถามลูกค้าใหม่"]')!;
    const agreed = m.container.querySelector('section[aria-label="ลูกค้าตกลงไว้แล้ว"]')!;
    expect(ask.textContent).toContain('โช้คหลัง');
    expect(ask.textContent).toContain('ต้องถามใหม่');
    expect(ask.textContent).not.toContain('ผ้าเบรกหน้า');
    expect(agreed.textContent).toContain('ผ้าเบรกหน้า');
    expect(agreed.textContent).toContain('ตกลงไว้แล้ว');
  });
});

describe('a failed save keeps what was typed', () => {
  it('discount: the box still holds the typed value after the server refused', async () => {
    const onSave = vi.fn(async () => false);
    m = mount(<QuoteTotalsPanel totals={totals({ discount: '0.00' })} discountEditable busy={false} onSaveDiscount={onSave} />);
    type(field('ส่วนลดท้ายบิล'), '450');
    submit(m.container.querySelector('form.qt-discount') as HTMLFormElement);
    await flush();
    expect(onSave).toHaveBeenCalledWith('450');
    expect((field('ส่วนลดท้ายบิล') as HTMLInputElement).value).toBe('450');
  });
});
