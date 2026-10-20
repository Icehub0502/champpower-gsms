// @vitest-environment happy-dom
/**
 * P3.1 polish on "ยืนยันผลลูกค้า" (ux-advocate): the action row always in view,
 * no "฿0.00" preview while the discount is not acceptable, no silent loss of
 * what was typed on Esc / backdrop, and focus on the first error after a
 * refused submit.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmInput } from '@gsms/contracts/index.js';
import { ConfirmOutcomeDialog } from './ConfirmOutcomeDialog';
import type { QuoteFailure } from './quoteErrors';
import { cutSetQuotation, line, next, quotation, totals } from './quoteFixtures';
import { button, buttons, click, field, flush, mount, type, type Mounted } from './quoteTestDom';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

// Offer 2,000 with a 200 discount; the customer approved 100 (DECISION-2026-10-15 §1 case).
function shrunk() {
  const kept = line({ name: 'น้ำมันเครื่อง', unitPrice: '100.00', lineTotal: '100.00', approvalStatus: 'approved', sortOrder: 1 });
  const gone = line({ name: 'โช้คหน้า', unitPrice: '1900.00', lineTotal: '1900.00', approvalStatus: 'declined', declineReason: 'too_expensive', sortOrder: 2 });
  return quotation({
    lines: [kept, gone],
    totals: totals({
      offeredSubtotal: '2000.00', offeredDiscount: '200.00', offeredTotal: '1800.00', discount: '200.00',
      approvedSubtotal: '100.00', approvedDiscount: '100.00', approvedTotal: '0.00',
    }),
    next: next({ canDecide: true, canOpenConfirm: true, canConfirm: true, canRevise: true }),
  });
}

const preview = () => document.querySelector('.qt-confirm-total strong')!.textContent;

function pressEsc() {
  act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
}

describe('#3 the action row is a footer outside the scrolling body', () => {
  it('"ยืนยันผลลูกค้า" sits in .modal-foot, not inside .modal-body, and still submits the form', async () => {
    const onSubmit = vi.fn(async (_i: ConfirmInput) => null);
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={onSubmit} onClose={() => {}} />);
    const confirmBtn = button('ยืนยันผลลูกค้า');
    expect(confirmBtn.closest('.modal-foot')).not.toBeNull();
    expect(confirmBtn.closest('.modal-body')).toBeNull();

    type(field('ส่วนลด'), '0');
    type(field('เหตุผลที่เปลี่ยนส่วนลด'), 'ไม่ให้ส่วนลด');
    click(confirmBtn);
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('#5 no approved-total preview while the discount is not acceptable', () => {
  it('a discount above the approved subtotal shows "—", not ฿0.00', () => {
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={vi.fn()} onClose={() => {}} />);
    type(field('ส่วนลด'), '150'); // approved is 100
    expect(preview()).toBe('—');
    type(field('ส่วนลด'), '40');
    expect(preview()).toBe('฿60.00');
  });

  it('a discount that is not a number shows "—"', () => {
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={vi.fn()} onClose={() => {}} />);
    type(field('ส่วนลด'), '1.234');
    expect(preview()).toBe('—');
  });
});

describe('#6 closing with typed data asks first', () => {
  it('Esc on an untouched dialog closes it at once', () => {
    const onClose = vi.fn();
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={vi.fn()} onClose={onClose} />);
    pressEsc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc after typing asks "ทิ้งข้อมูลที่กรอก?"; going back keeps the data, discarding closes', () => {
    const onClose = vi.fn();
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={vi.fn()} onClose={onClose} />);
    type(field('ส่วนลด'), '50');
    pressEsc();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('ทิ้งข้อมูลที่กรอก?');

    click(button('กลับไปกรอกต่อ'));
    expect(document.body.textContent).not.toContain('ทิ้งข้อมูลที่กรอก?');
    expect((field('ส่วนลด') as HTMLInputElement).value).toBe('50');

    act(() => { (document.querySelector('.modal-backdrop') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
    click(button('ทิ้งข้อมูล'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"ยกเลิก" asks too when something was typed (same path as ×), and closes at once when not', () => {
    const onClose = vi.fn();
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={vi.fn()} onClose={onClose} />);
    type(field('ส่วนลด'), '50');
    click(button('ยกเลิก'));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('ทิ้งข้อมูลที่กรอก?');
    m.unmount();

    const onClose2 = vi.fn();
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={vi.fn()} onClose={onClose2} />);
    click(button('ยกเลิก'));
    expect(onClose2).toHaveBeenCalledTimes(1);
  });

  it('typing again while the question shows puts the action row back', () => {
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={vi.fn()} onClose={vi.fn()} />);
    type(field('ส่วนลด'), '50');
    pressEsc();
    expect(document.body.textContent).toContain('ทิ้งข้อมูลที่กรอก?');
    type(field('ส่วนลด'), '60');
    expect(document.body.textContent).not.toContain('ทิ้งข้อมูลที่กรอก?');
    expect(buttons('ยืนยันผลลูกค้า')).toHaveLength(1);
  });

  it('the × button asks too when something was typed', () => {
    const onClose = vi.fn();
    const { q, head } = cutSetQuotation();
    m = mount(<ConfirmOutcomeDialog quotation={q} busy={false} onSubmit={vi.fn()} onClose={onClose} />);
    type(field('เหตุผล', document.querySelector(`[data-set-id="${head.id}"]`)!), 'ลูกค้าตัดตั้งศูนย์');
    click(document.querySelector('.modal-close') as HTMLButtonElement);
    expect(onClose).not.toHaveBeenCalled();
    expect(buttons('ทิ้งข้อมูล')).toHaveLength(1);
  });
});

describe('#6 focus goes to the first field with an error after a refused submit', () => {
  it('screen check: the set amount box is focused', async () => {
    const { q, head } = cutSetQuotation();
    m = mount(<ConfirmOutcomeDialog quotation={q} busy={false} onSubmit={vi.fn()} onClose={() => {}} />);
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(document.activeElement).toBe(field('ยอดใหม่ของชุด', document.querySelector(`[data-set-id="${head.id}"]`)!));
  });

  it('server refusal on the discount reason: that box is focused', async () => {
    const refusal: QuoteFailure = {
      text: 'ข้อมูลบางช่องไม่ถูกต้อง', fields: { 'adjustments.discount.reason': 'จำเป็นต้องกรอก' }, lineIds: [], body: null, stale: false, cancelled: false,
    };
    m = mount(<ConfirmOutcomeDialog quotation={shrunk()} busy={false} onSubmit={vi.fn(async () => refusal)} onClose={() => {}} />);
    type(field('ส่วนลด'), '0');
    type(field('เหตุผลที่เปลี่ยนส่วนลด'), 'x');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(document.activeElement).toBe(field('เหตุผลที่เปลี่ยนส่วนลด'));
  });
});
