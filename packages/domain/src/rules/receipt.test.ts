import { describe, expect, it } from 'vitest';
import {
  discountCeilingRefusal, discountExceedsCeiling, discountPercentText, fulfilledQtyIssue,
  receiptDiscount, receiptLineCharge, receiptSubtotal, receiptTotals, settlePayments,
  cashVariance, type ReceiptLineMoney,
} from './receipt.js';
import { quoteTotals } from './quote.js';

const line = (o: Partial<ReceiptLineMoney> & { id: string }): ReceiptLineMoney => ({
  qty: '1', unitPrice: '1000.00', approvedAmount: null, isSet: false, fulfilledQty: null, ...o,
});

describe('discount ceiling (B4)', () => {
  it('40.00% passes, 40.01% does not (integer satang)', () => {
    expect(discountExceedsCeiling(300000, 120000)).toBe(false); // 3,000 base, 1,200.00
    expect(discountExceedsCeiling(300000, 120001)).toBe(true); // 1,200.01
    expect(discountExceedsCeiling(300000, 130000)).toBe(true);
  });
  it('no base: any discount exceeds, zero does not', () => {
    expect(discountExceedsCeiling(0, 1)).toBe(true);
    expect(discountExceedsCeiling(0, 0)).toBe(false);
  });
  it('percent text', () => {
    expect(discountPercentText(300000, 120000)).toBe('40.00');
    expect(discountPercentText(300000, 120001)).toBe('40.00'); // rounds half up to 2 places
    expect(discountPercentText(300000, 130000)).toBe('43.33');
    expect(discountPercentText(0, 5)).toBe('0.00');
  });
  it('advisor is refused, manager needs a reason, assistant manager and owner pass with one', () => {
    const base = { baseSatang: 300000, discountSatang: 180000 };
    expect(discountCeilingRefusal({ ...base, role: 'advisor', reason: 'x' })).toBe('discount_requires_manager');
    expect(discountCeilingRefusal({ ...base, role: 'manager', reason: '' })).toBe('discount_reason_required');
    expect(discountCeilingRefusal({ ...base, role: 'manager', reason: '  ' })).toBe('discount_reason_required');
    expect(discountCeilingRefusal({ ...base, role: 'assistant_manager', reason: 'regular' })).toBeNull();
    expect(discountCeilingRefusal({ ...base, role: 'owner', reason: 'regular' })).toBeNull();
    expect(discountCeilingRefusal({ baseSatang: 300000, discountSatang: 120000, role: 'advisor', reason: null })).toBeNull();
  });
});

describe('ticking lines', () => {
  it('rejects non-numbers, negatives, more than approved, and a part-set', () => {
    expect(fulfilledQtyIssue({ qty: '4', isSet: false }, 'abc')).toBe('invalid');
    expect(fulfilledQtyIssue({ qty: '4', isSet: false }, '-1')).toBe('invalid');
    expect(fulfilledQtyIssue({ qty: '4', isSet: false }, '5')).toBe('exceeds_qty');
    expect(fulfilledQtyIssue({ qty: '4', isSet: false }, '3')).toBeNull();
    expect(fulfilledQtyIssue({ qty: '2', isSet: true }, '1')).toBe('set_must_be_whole');
    expect(fulfilledQtyIssue({ qty: '2', isSet: true }, '0')).toBeNull();
    expect(fulfilledQtyIssue({ qty: '2', isSet: true }, '2')).toBeNull();
  });
  it('charges fulfilled qty x price, rounded once; unticked is null', () => {
    expect(receiptLineCharge(line({ id: 'a', qty: '4', unitPrice: '250.00', fulfilledQty: '3' }))).toBe(75000);
    expect(receiptLineCharge(line({ id: 'a', fulfilledQty: '0' }))).toBe(0);
    expect(receiptLineCharge(line({ id: 'a' }))).toBeNull();
    expect(receiptLineCharge(line({ id: 'a', qty: '3', unitPrice: '0.33', fulfilledQty: '1.5' }))).toBe(50); // 0.495 -> 0.50
  });
  it('a set bills its agreed amount, all or nothing', () => {
    const s = line({ id: 's', isSet: true, unitPrice: '5000.00', approvedAmount: '4200.00' });
    expect(receiptLineCharge({ ...s, fulfilledQty: '1' })).toBe(420000);
    expect(receiptLineCharge({ ...s, fulfilledQty: '0' })).toBe(0);
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
    expect(sub.fullyDone).toBe(true);
    expect(sub.subtotal).toBe(t.approvedSubtotal);
    const disc = receiptDiscount({ lines, agreedDiscount: '500.00', entered: null });
    expect(disc.state).toBe('carried');
    expect(receiptTotals(sub.subtotal, disc.discount).billTotal).toBe(t.approvedTotal);
  });
  it('a line not done: the agreed discount is NOT carried (AC-C2)', () => {
    const lines = [line({ id: 'a', qty: '1', unitPrice: '3000.00', fulfilledQty: '1' }), line({ id: 'b', unitPrice: '2000.00', fulfilledQty: '0' })];
    expect(receiptDiscount({ lines, agreedDiscount: '500.00', entered: null })).toEqual({ state: 'needs_entry', discount: 0 });
    expect(receiptDiscount({ lines, agreedDiscount: '500.00', entered: '0' })).toEqual({ state: 'entered', discount: 0 });
    expect(receiptDiscount({ lines, agreedDiscount: '0', entered: null }).state).toBe('none');
  });
});

describe('settlePayments', () => {
  it('exact transfer', () => {
    const r = settlePayments(750000, [{ method: 'transfer', amount: '7500' }]);
    expect(r).toMatchObject({ ok: true, change: '0.00', netPaid: '7500.00' });
  });
  it('cash over: stores handed-over and change separately (AC-D3)', () => {
    const r = settlePayments(750000, [{ method: 'cash', amount: '8000' }]);
    expect(r).toEqual({ ok: true, rows: [{ method: 'cash', amount: '8000.00', changeGiven: '500.00' }], netPaid: '7500.00', change: '500.00' });
  });
  it('split transfer + cash, change on the cash row (AC-D6)', () => {
    const r = settlePayments(750000, [{ method: 'transfer', amount: '5000' }, { method: 'cash', amount: '3000' }]);
    expect(r).toMatchObject({ ok: true, change: '500.00', netPaid: '7500.00' });
    if (r.ok) expect(r.rows.find((x) => x.method === 'cash')!.changeGiven).toBe('500.00');
  });
  it('short names the shortfall (AC-D4)', () => {
    expect(settlePayments(750000, [{ method: 'cash', amount: '7000' }])).toEqual({ ok: false, code: 'payment_short', short: '500.00' });
  });
  it('transfer above the bill is refused (A-12)', () => {
    expect(settlePayments(750000, [{ method: 'transfer', amount: '8000' }])).toEqual({ ok: false, code: 'payment_over_noncash', over: '500.00' });
  });
  it('a cash row that is all change is refused', () => {
    expect(settlePayments(500000, [{ method: 'transfer', amount: '5000' }, { method: 'cash', amount: '100' }])).toEqual({ ok: false, code: 'payment_cash_unneeded' });
  });
  it('rejects zero, 3 decimals, a repeated method', () => {
    expect(settlePayments(100, [{ method: 'cash', amount: '0' }])).toMatchObject({ ok: false, code: 'payment_invalid' });
    expect(settlePayments(100, [{ method: 'cash', amount: '1.005' }])).toMatchObject({ ok: false, code: 'payment_invalid' });
    expect(settlePayments(100, [{ method: 'cash', amount: '1' }, { method: 'cash', amount: '1' }])).toMatchObject({ ok: false, code: 'payment_invalid' });
  });
});

describe('cash variance', () => {
  it('counted - expected', () => {
    expect(cashVariance(1250000, 1230000)).toBe(-20000);
  });
});
