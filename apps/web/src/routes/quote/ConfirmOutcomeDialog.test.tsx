// @vitest-environment happy-dom
/**
 * "ยืนยันผลลูกค้า" (v3 §6.2, D10/D11/Q2): one dialog with the new amount of
 * every cut set and the discount, each with a reason. A cut set cannot be sent
 * without an amount and a reason; the difference from the old set price is
 * shown as a number; the 2x rule is a hint here and the API's decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmInput } from '@gsms/contracts/index.js';
import { ConfirmOutcomeDialog } from './ConfirmOutcomeDialog';
import { amountHint } from './quoteView';
import { describeQuoteError, type QuoteFailure } from './quoteErrors';
import { cutSetQuotation, line, next, quotation, totals } from './quoteFixtures';
import { button, click, field, flush, mount, submit, type, type Mounted } from './quoteTestDom';
import { ApiError } from '../../lib/api/client';

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

function open(onSubmit: (i: ConfirmInput) => Promise<QuoteFailure | null>, busy = false) {
  const { q, head } = cutSetQuotation();
  m = mount(<ConfirmOutcomeDialog quotation={q} busy={busy} onSubmit={onSubmit} onClose={() => {}} />);
  const set = document.querySelector(`[data-set-id="${head.id}"]`) as HTMLElement;
  return { q, head, set };
}

describe('the cut set', () => {
  it('shows the old set price and what was cut, with an EMPTY amount box (the system proposes nothing)', () => {
    const { set } = open(vi.fn());
    expect(set.textContent).toContain('ชุดโปรช่วงล่าง');
    expect(set.textContent).toContain('ราคาชุดเดิม ฿20,000.00');
    expect(set.textContent).toContain('ตัดออก: ตั้งศูนย์');
    expect(set.textContent).toContain('ต้องกรอกยอดใหม่ก่อนยืนยัน');
    expect((field('ยอดใหม่ของชุด', set) as HTMLInputElement).value).toBe('');
  });

  it('requires the amount AND the reason before anything is sent', async () => {
    const onSubmit = vi.fn(async () => null);
    const { set } = open(onSubmit);

    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(set.textContent).toContain('กรอกยอดใหม่ของชุดนี้ก่อนยืนยัน');
    expect(set.textContent).toContain('กรอกเหตุผลที่ยอดชุดเปลี่ยน');

    type(field('ยอดใหม่ของชุด', set), '18000');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit).not.toHaveBeenCalled(); // reason still missing

    type(field('เหตุผล', set), 'ลูกค้าไม่ตั้งศูนย์');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('sends the set amount with its reason, and leaves an unchanged discount out', async () => {
    const onSubmit = vi.fn(async (_i: ConfirmInput) => null);
    const { head, set } = open(onSubmit);
    type(field('ยอดใหม่ของชุด', set), '18000');
    type(field('เหตุผล', set), 'ลูกค้าไม่ตั้งศูนย์');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      adjustments: { setLines: [{ lineId: head.id, approvedAmount: '18000', reason: 'ลูกค้าไม่ตั้งศูนย์' }] },
    });
  });

  it('shows the difference as a number: above the offer, below it, and free', () => {
    const { set } = open(vi.fn());
    type(field('ยอดใหม่ของชุด', set), '21200');
    expect(set.querySelector('[data-testid="amount-hint"]')!.textContent).toBe('+฿1,200.00 จากราคาชุดเดิม');
    type(field('ยอดใหม่ของชุด', set), '18000');
    expect(set.querySelector('[data-testid="amount-hint"]')!.textContent).toBe('−฿2,000.00 จากราคาชุดเดิม');
    type(field('ยอดใหม่ของชุด', set), '0');
    expect(set.querySelector('[data-testid="amount-hint"]')!.textContent).toContain('แถมฟรี');
  });

  it('over 2x is warned in advance but still sent — the API decides, and its refusal lands under that set', async () => {
    // The refusal names the set by id, as the API's amount_over_2x body does.
    let headId = '';
    const onSubmit = vi.fn(async (): Promise<QuoteFailure> => ({
      text: 'ยอดนี้เกิน 2 เท่าของราคาที่เสนอ (เสนอ ฿20,000.00 · สูงสุด ฿40,000.00) น่าจะพิมพ์ผิด ถ้าตั้งใจจริงให้ออกใบเสนอราคาฉบับใหม่',
      fields: {}, lineIds: [headId], body: null, stale: false, cancelled: false,
    }));
    const { head, set } = open(onSubmit);
    headId = head.id;
    type(field('ยอดใหม่ของชุด', set), '200000');
    expect(set.querySelector('[data-testid="amount-hint"]')!.textContent).toContain('เกิน 2 เท่า');
    type(field('เหตุผล', set), 'พิมพ์');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(set.textContent).toContain('สูงสุด ฿40,000.00');
  });
});

describe('the discount', () => {
  it('a changed discount needs its own reason and is sent with it', async () => {
    const onSubmit = vi.fn(async (_i: ConfirmInput) => null);
    const { head, set } = open(onSubmit);
    type(field('ยอดใหม่ของชุด', set), '18000');
    type(field('เหตุผล', set), 'ตัดตั้งศูนย์');
    type(field('ส่วนลด'), '300');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('เปลี่ยนส่วนลดต้องกรอกเหตุผล');

    type(field('เหตุผลที่เปลี่ยนส่วนลด'), 'ลูกค้าประจำ');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      adjustments: {
        setLines: [{ lineId: head.id, approvedAmount: '18000', reason: 'ตัดตั้งศูนย์' }],
        discount: { amount: '300', reason: 'ลูกค้าประจำ' },
      },
    });
  });

  it('previews the approved total from the typed numbers with the domain totals function', () => {
    const { set } = open(vi.fn());
    type(field('ยอดใหม่ของชุด', set), '18000');
    type(field('ส่วนลด'), '500');
    expect(document.querySelector('.qt-confirm-total')!.textContent).toContain('฿17,500.00');
  });
});

describe('in flight', () => {
  it('every button and box is disabled while the confirm is on the wire', () => {
    open(vi.fn(), true);
    expect(button('กำลังยืนยัน...').disabled).toBe(true);
    expect(button('ยกเลิก').disabled).toBe(true);
    expect((field('ส่วนลด') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('amountHint', () => {
  it('says nothing for text that is not money', () => {
    expect(amountHint(2_000_000, '12,000')).toBeNull();
    expect(amountHint(2_000_000, '-5')).toBeNull();
  });
});

describe('server field errors keyed by full path (apps/api nestedFieldErrorsOf)', () => {
  it('a set-row error lands under THAT set, and a discount error under the discount', async () => {
    let headId = '';
    const onSubmit = vi.fn(async (): Promise<QuoteFailure> => ({
      text: 'ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจช่องที่มีข้อความสีแดง',
      fields: {
        [`adjustments.setLines.${headId}.approvedAmount`]: 'จำนวนเงินไม่ถูกต้อง — ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง',
        [`adjustments.setLines.${headId}.reason`]: 'ยาวเกินไป (ไม่เกิน 500 ตัวอักษร)',
        'adjustments.discount.reason': 'จำเป็นต้องกรอก',
      },
      lineIds: [], body: null, stale: false, cancelled: false,
    }));
    const { head, set } = open(onSubmit);
    headId = head.id;
    type(field('ยอดใหม่ของชุด', set), '18000');
    type(field('เหตุผล', set), 'x');
    type(field('ส่วนลด'), '300');
    type(field('เหตุผลที่เปลี่ยนส่วนลด'), 'y');
    click(button('ยืนยันผลลูกค้า'));
    await flush();

    const amountLabel = field('ยอดใหม่ของชุด', set).closest('label')!;
    const reasonLabel = field('เหตุผล', set).closest('label')!;
    expect(amountLabel.querySelector('.ci-field-error')!.textContent).toContain('จำนวนเงินไม่ถูกต้อง');
    expect(reasonLabel.querySelector('.ci-field-error')!.textContent).toContain('ยาวเกินไป');
    const discountReason = field('เหตุผลที่เปลี่ยนส่วนลด').closest('label')!;
    expect(discountReason.querySelector('.ci-field-error')!.textContent).toBe('จำเป็นต้องกรอก');
    // The discount amount box itself has no error.
    expect(field('ส่วนลด').closest('label')!.querySelector('.ci-field-error')).toBeNull();
  });
});

describe('M1 — an amount the totals cannot hold', () => {
  it('does not crash the dialog: the preview says "ยอดเกินที่ระบบรองรับ" and the typed values stay', () => {
    const { q, head } = cutSetQuotation();
    // A second approved line, so the sum overflows numeric(12,2) inside quoteTotals.
    const extra = { ...q.lines[1]!, id: '00000000-0000-4000-8000-00000000ee01', parentLineId: null, name: 'ค่าแรง', unitPrice: '100.00', lineTotal: '100.00', sortOrder: 9 };
    const q2 = { ...q, lines: [...q.lines, extra] };
    m = mount(<ConfirmOutcomeDialog quotation={q2} busy={false} onSubmit={vi.fn()} onClose={() => {}} />);
    const set = document.querySelector(`[data-set-id="${head.id}"]`) as HTMLElement;
    type(field('ยอดใหม่ของชุด', set), '9999999999');
    expect(document.querySelector('.qt-confirm')).not.toBeNull();
    expect(document.querySelector('.qt-confirm-total')!.textContent).toContain('ยอดเกินที่ระบบรองรับ');
    expect((field('ยอดใหม่ของชุด', set) as HTMLInputElement).value).toBe('9999999999');
  });
});

/**
 * DECISION-2026-10-15 §1: approved < offered with a discount > 0 → staff must
 * type a NEW discount. The box starts empty, the old deal is shown as a
 * reference, and nothing is sent until a discount (0 counts) and a reason are in.
 */
describe('DECISION-2026-10-15 §1 — a new discount when the customer approved less', () => {
  // The pass criterion: offer 2,000 with a discount of 200, the customer approves 100.
  function shrunkQuotation() {
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

  function openShrunk(onSubmit: (i: ConfirmInput) => Promise<QuoteFailure | null>) {
    m = mount(<ConfirmOutcomeDialog quotation={shrunkQuotation()} busy={false} onSubmit={onSubmit} onClose={() => {}} />);
  }

  it('the discount box starts EMPTY and the old deal is shown as reference', () => {
    openShrunk(vi.fn());
    expect((field('ส่วนลด') as HTMLInputElement).value).toBe('');
    expect(document.body.textContent).toContain('ส่วนลดที่ตกลงไว้ 200.00 บาท บนยอด 2,000.00 · ยอดอนุมัติตอนนี้ 100.00 บาท');
  });

  it('the confirm button stays disabled until a discount is typed (0 is a valid entry)', () => {
    openShrunk(vi.fn());
    expect(button('ยืนยันผลลูกค้า').disabled).toBe(true);
    type(field('ส่วนลด'), '0');
    expect(button('ยืนยันผลลูกค้า').disabled).toBe(false);
    type(field('ส่วนลด'), '');
    expect(button('ยืนยันผลลูกค้า').disabled).toBe(true);
  });

  it('pass criterion: confirming without a discount cannot happen — nothing is sent', async () => {
    const onSubmit = vi.fn(async () => null);
    openShrunk(onSubmit);
    // Clicking the disabled button, and submitting the form directly (Enter key), both send nothing.
    click(button('ยืนยันผลลูกค้า'));
    submit(document.querySelector('form.qt-confirm') as HTMLFormElement);
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a typed discount still needs its reason, and is always sent — even when equal to the old one', async () => {
    const onSubmit = vi.fn(async (_i: ConfirmInput) => null);
    openShrunk(onSubmit);
    type(field('ส่วนลด'), '200');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('เปลี่ยนส่วนลดต้องกรอกเหตุผล');

    type(field('เหตุผลที่เปลี่ยนส่วนลด'), 'ลูกค้าขอคงส่วนลด');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit.mock.calls[0]![0]).toEqual({ adjustments: { discount: { amount: '200', reason: 'ลูกค้าขอคงส่วนลด' } } });
  });

  it('the rule does not apply (nothing cut) → the agreed discount is prefilled as before, no reference text', () => {
    const q = shrunkQuotation();
    const all = { ...q, lines: q.lines.map((l) => ({ ...l, approvalStatus: 'approved' as const, declineReason: null })),
      totals: { ...q.totals, approvedSubtotal: '2000.00', approvedDiscount: '200.00', approvedTotal: '1800.00' } };
    m = mount(<ConfirmOutcomeDialog quotation={all} busy={false} onSubmit={vi.fn()} onClose={() => {}} />);
    expect((field('ส่วนลด') as HTMLInputElement).value).toBe('200.00');
    expect(document.body.textContent).not.toContain('ส่วนลดที่ตกลงไว้');
    expect(button('ยืนยันผลลูกค้า').disabled).toBe(false);
  });

  it('judged on the lines as they will be: a lower set amount typed in the dialog switches the rule on, Z follows it', async () => {
    const { q, head } = cutSetQuotation();
    const withDiscount = { ...q, totals: { ...q.totals, discount: '500.00', offeredDiscount: '500.00', approvedDiscount: '500.00', offeredTotal: '19500.00', approvedTotal: '19500.00' } };
    const onSubmit = vi.fn(async (_i: ConfirmInput) => null);
    m = mount(<ConfirmOutcomeDialog quotation={withDiscount} busy={false} onSubmit={onSubmit} onClose={() => {}} />);
    const set = document.querySelector(`[data-set-id="${head.id}"]`) as HTMLElement;
    // Nothing typed yet: approved (20,000 as offered) is not below the offer → prefilled as before.
    expect((field('ส่วนลด') as HTMLInputElement).value).toBe('500.00');
    type(field('ยอดใหม่ของชุด', set), '18000');
    expect((field('ส่วนลด') as HTMLInputElement).value).toBe('');
    expect(document.querySelector('[data-testid="discount-reference"]')!.textContent)
      .toContain('ส่วนลดที่ตกลงไว้ 500.00 บาท บนยอด 20,000.00 · ยอดอนุมัติตอนนี้ 18,000.00 บาท');
    expect(button('ยืนยันผลลูกค้า').disabled).toBe(true);

    type(field('เหตุผล', set), 'ตัดตั้งศูนย์');
    type(field('ส่วนลด'), '300');
    type(field('เหตุผลที่เปลี่ยนส่วนลด'), 'ลดตามยอดใหม่');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      adjustments: {
        setLines: [{ lineId: head.id, approvedAmount: '18000', reason: 'ตัดตั้งศูนย์' }],
        discount: { amount: '300', reason: 'ลดตามยอดใหม่' },
      },
    });
  });

  it('a discount_required refusal from the server lands on the discount box', async () => {
    const body = { error: 'discount_required' as const, message: 'x', fields: { 'adjustments.discount.amount': ['required'] } };
    const onSubmit = vi.fn(async () => describeQuoteError(new ApiError(400, 'discount_required', body)));
    // The cut-set fixture has no discount, so the screen lets it through; the server says otherwise.
    const { set } = open(onSubmit);
    type(field('ยอดใหม่ของชุด', set), '18000');
    type(field('เหตุผล', set), 'ตัดตั้งศูนย์');
    click(button('ยืนยันผลลูกค้า'));
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const err = field('ส่วนลด').closest('label')!.querySelector('.ci-field-error');
    expect(err?.textContent).toContain('กรอกส่วนลดใหม่');
  });
});
