import { describe, expect, it } from 'vitest';
import { discountCeilingRefusal, discountExceedsCeiling, discountPercentText } from './receipt.js';
import {
  fulfilledQtyIssue, receiptDiscount, receiptLineCharge, receiptLineDiscountIssue, receiptSubtotal,
  receiptTotals, settlePayments, surchargeSatang, type ReceiptLineMoney,
} from './receiptBill.js';
import { quoteTotals } from './quote.js';

const line = (o: Partial<ReceiptLineMoney> & { id: string }): ReceiptLineMoney => ({
  qty: '1', unitPrice: '1000.00', approvedAmount: null, isSet: false, fulfilledQty: null, lineDiscount: '0.00', ...o,
});

describe('discount ceiling (B4)', () => {
  it('40.00% passes, 40.01% does not (integer satang)', () => {
    expect(discountExceedsCeiling(300000, 120000)).toBe(false);
    expect(discountExceedsCeiling(300000, 120001)).toBe(true);
  });
  it('no base: any discount exceeds, zero does not', () => {
    expect(discountExceedsCeiling(0, 1)).toBe(true);
    expect(discountExceedsCeiling(0, 0)).toBe(false);
  });
  it('percent text', () => {
    expect(discountPercentText(300000, 120000)).toBe('40.00');
    expect(discountPercentText(300000, 130000)).toBe('43.33');
    expect(discountPercentText(0, 5)).toBe('0.00');
  });
  it('advisor refused, manager needs a reason, assistant manager and owner pass with one', () => {
    const base = { baseSatang: 300000, discountSatang: 180000 };
    expect(discountCeilingRefusal({ ...base, role: 'advisor', reason: 'x' })).toBe('discount_requires_manager');
    expect(discountCeilingRefusal({ ...base, role: 'manager', reason: ' ' })).toBe('discount_reason_required');
    expect(discountCeilingRefusal({ ...base, role: 'assistant_manager', reason: 'regular' })).toBeNull();
    expect(discountCeilingRefusal({ baseSatang: 300000, discountSatang: 120000, role: 'advisor', reason: null })).toBeNull();
  });
});

describe('ticking lines', () => {
  it('rejects non-numbers, negatives, more than approved, and a part-set', () => {
    expect(fulfilledQtyIssue({ qty: '4', isSet: false }, 'abc')).toBe('invalid');
    expect(fulfilledQtyIssue({ qty: '4', isSet: false }, '5')).toBe('exceeds_qty');
    expect(fulfilledQtyIssue({ qty: '2', isSet: true }, '1')).toBe('set_must_be_whole');
    expect(fulfilledQtyIssue({ qty: '2', isSet: true }, '2')).toBeNull();
  });
  it('charges fulfilled qty x price, rounded once; unticked is null', () => {
    expect(receiptLineCharge(line({ id: 'a', qty: '4', unitPrice: '250.00', fulfilledQty: '3' }))).toBe(75000);
    expect(receiptLineCharge(line({ id: 'a' }))).toBeNull();
    expect(receiptLineCharge(line({ id: 'a', qty: '3', unitPrice: '0.33', fulfilledQty: '1.5' }))).toBe(50);
  });
});

describe('line discounts (B4, Ice 20 Oct)', () => {
  const l = line({ id: 'a', unitPrice: '1000.00', fulfilledQty: '1' });
  it('needs a ticked line, not above the line, and a reason', () => {
    expect(receiptLineDiscountIssue(line({ id: 'a' }), '10', 'x')).toBe('line_not_answered');
    expect(receiptLineDiscountIssue(l, '1000.01', 'x')).toBe('exceeds_line');
    expect(receiptLineDiscountIssue(l, '100', ' ')).toBe('reason_required');
    expect(receiptLineDiscountIssue(l, '100', 'ลูกค้าประจำ')).toBeNull();
    expect(receiptLineDiscountIssue(l, '0', null)).toBeNull();
    expect(receiptLineDiscountIssue(l, '-1', 'x')).toBe('invalid');
  });
  it('totals: line discounts + document discount, rounded per line then summed', () => {
    const lines = [
      line({ id: 'a', unitPrice: '1000.00', fulfilledQty: '1', lineDiscount: '100.00' }),
      line({ id: 'b', unitPrice: '2000.00', fulfilledQty: '1', lineDiscount: '0.00' }),
    ];
    const s = receiptSubtotal(lines);
    expect(s).toMatchObject({ subtotal: 300000, lineDiscountTotal: 10000 });
    const t = receiptTotals(s.subtotal, s.lineDiscountTotal, 20000);
    expect(t).toEqual({ subtotal: 300000, lineDiscountTotal: 10000, discount: 20000, totalDiscount: 30000, billTotal: 270000 });
    // the ceiling base is the GROSS subtotal and the discount is the TOTAL
    expect(discountExceedsCeiling(t.subtotal, t.totalDiscount)).toBe(false);
    expect(discountExceedsCeiling(t.subtotal, 120001)).toBe(true);
  });
  it('a document discount never takes the bill below zero', () => {
    expect(receiptTotals(100000, 40000, 999999).billTotal).toBe(0);
  });
});

describe('invariant C1: all done + carried discount = the quotation approved_total', () => {
  it('foots to the penny, sets included', () => {
    const q = [
      { id: 'a', parentLineId: null, qty: '2', unitPrice: '1500.00', approvalStatus: 'approved' as const, approvedAmount: null },
      { id: 's', parentLineId: null, qty: '1', unitPrice: '6000.00', approvalStatus: 'approved' as const, approvedAmount: '4500.50' },
      { id: 'd', parentLineId: null, qty: '1', unitPrice: '999.00', approvalStatus: 'declined' as const, approvedAmount: null },
    ];
    const t = quoteTotals(q, '500.00');
    const lines = [
      line({ id: 'a', qty: '2', unitPrice: '1500.00', fulfilledQty: '2' }),
      line({ id: 's', isSet: true, unitPrice: '6000.00', approvedAmount: '4500.50', fulfilledQty: '1' }),
    ];
    const sub = receiptSubtotal(lines);
    const disc = receiptDiscount({ lines, agreedDiscount: '500.00', entered: null });
    expect(disc.state).toBe('carried');
    expect(receiptTotals(sub.subtotal, sub.lineDiscountTotal, disc.discount).billTotal).toBe(t.approvedTotal);
  });
  it('a line not done: the agreed discount is NOT carried (AC-C2)', () => {
    const lines = [line({ id: 'a', unitPrice: '3000.00', fulfilledQty: '1' }), line({ id: 'b', unitPrice: '2000.00', fulfilledQty: '0' })];
    expect(receiptDiscount({ lines, agreedDiscount: '500.00', entered: null })).toEqual({ state: 'needs_entry', discount: 0 });
    expect(receiptDiscount({ lines, agreedDiscount: '500.00', entered: '0' })).toEqual({ state: 'entered', discount: 0 });
  });
});

describe('surcharge (B3)', () => {
  it('percent of the applied amount, rounded once to the satang', () => {
    expect(surchargeSatang(1000000, '3.00')).toBe(30000);
    expect(surchargeSatang(33333, '3.00')).toBe(1000); // 999.99 -> 1000
    expect(surchargeSatang(1000000, '0.00')).toBe(0);
  });
});

const E = (key: string, method: 'cash' | 'transfer' | 'card', amount: string, surchargePercent = '0.00') => ({ key, method, amount, surchargePercent });

describe('settlePayments', () => {
  it('exact transfer', () => {
    expect(settlePayments(750000, [E('t', 'transfer', '7500')])).toMatchObject({ ok: true, change: '0.00', netPaid: '7500.00' });
  });
  it('cash over: stores handed-over and change separately', () => {
    const r = settlePayments(750000, [E('c', 'cash', '8000')]);
    expect(r).toMatchObject({ ok: true, change: '500.00', netPaid: '7500.00' });
    if (r.ok) expect(r.rows[0]).toMatchObject({ amount: '8000.00', changeGiven: '500.00', surcharge: '0.00' });
  });
  it('card with 3%: the fee is on top, recorded on the row, in the net', () => {
    const r = settlePayments(1000000, [E('k', 'card', '10000', '3.00')]);
    expect(r).toMatchObject({ ok: true, surchargeTotal: '300.00', netPaid: '10300.00', change: '0.00' });
    if (r.ok) expect(r.rows[0]).toMatchObject({ applied: '10000.00', surcharge: '300.00', amount: '10300.00' });
  });
  it('split transfer + cash, change on the cash row', () => {
    const r = settlePayments(750000, [E('t', 'transfer', '5000'), E('c', 'cash', '3000')]);
    expect(r).toMatchObject({ ok: true, change: '500.00' });
    if (r.ok) expect(r.rows.find((x) => x.method === 'cash')!.changeGiven).toBe('500.00');
  });
  it('short names the shortfall', () => {
    expect(settlePayments(750000, [E('c', 'cash', '7000')])).toEqual({ ok: false, code: 'payment_short', short: '500.00' });
  });
  it('transfer above the bill is refused; an all-change cash row is refused', () => {
    expect(settlePayments(750000, [E('t', 'transfer', '8000')])).toEqual({ ok: false, code: 'payment_over_noncash', over: '500.00' });
    expect(settlePayments(500000, [E('t', 'transfer', '5000'), E('c', 'cash', '100')])).toEqual({ ok: false, code: 'payment_cash_unneeded' });
  });
  it('rejects zero, 3 decimals, a repeated channel', () => {
    expect(settlePayments(100, [E('c', 'cash', '0')])).toMatchObject({ ok: false, code: 'payment_invalid' });
    expect(settlePayments(100, [E('c', 'cash', '1.005')])).toMatchObject({ ok: false, code: 'payment_invalid' });
    expect(settlePayments(100, [E('c', 'cash', '1'), E('c', 'cash', '1')])).toMatchObject({ ok: false, code: 'payment_invalid' });
  });
});
