import { describe, expect, it } from 'vitest';
import {
  agreedAmountsAfterUndo, confirmNeedsNewDiscount, discountAtIssue, discountExceedsApproved, offeredFoots, quoteTotals, quoteTotalsDecimal,
  totalsAfterUndoConfirm, type QuoteLineMoney,
} from './quote.js';

const line = (id: string, price: string, over: Partial<QuoteLineMoney> = {}): QuoteLineMoney => ({
  id, parentLineId: null, qty: '1', unitPrice: price, approvalStatus: 'approved', approvedAmount: null, ...over,
});

describe('discountAtIssue', () => {
  const lines = [line('a', '3000'), line('b', '2000')];
  it('is the entered discount when it fits', () => {
    expect(discountAtIssue(lines, '200')).toBe('200.00');
  });
  it('clamps to the offered subtotal so the offer foots', () => {
    expect(discountAtIssue(lines, '9000')).toBe('5000.00');
  });
  it('a negative or empty discount is 0', () => {
    expect(discountAtIssue(lines, '-5')).toBe('0.00');
    expect(discountAtIssue([], '100')).toBe('0.00');
  });
});

describe('offeredFoots', () => {
  it('holds for every discount the totals function can produce', () => {
    const lines = [line('a', '1234.56'), line('b', '99.99', { approvalStatus: 'declined' })];
    for (const entered of ['0', '10', '1234.56', '1334.55', '9999']) {
      const t = quoteTotalsDecimal(quoteTotals(lines, entered));
      expect(offeredFoots(t.offeredSubtotal, t.offeredDiscount, t.offeredTotal)).toBe(true);
    }
  });
  it('detects a discount that does not foot', () => {
    expect(offeredFoots('5000.00', '200.00', '4700.00')).toBe(false);
  });
});

describe('undo-confirm reverses confirm (offered 200, agreed 300)', () => {
  // A cut set (head 1000 offered, one piece declined) and a plain line.
  const head = line('set', '1000');
  const piece = line('piece', '0', { parentLineId: 'set', approvalStatus: 'declined' });
  const plain = line('plain', '4000');
  const preConfirm = [head, piece, plain];
  const offeredDiscount = '200.00';

  const preTotals = quoteTotals(preConfirm, offeredDiscount);

  // What confirm did: agreed set price 700 and discount 300.
  const confirmed = [{ ...head, approvedAmount: '700.00' }, piece, plain];
  const confirmTotals = quoteTotals(confirmed, '300');

  it('confirm really moved the approved total', () => {
    expect(confirmTotals.approvedTotal).not.toBe(preTotals.approvedTotal);
  });

  it('restoring the amounts and the offered discount reproduces the pre-confirm totals', () => {
    const restored = agreedAmountsAfterUndo(
      confirmed.map((l) => ({ id: l.id, approvedAmount: l.approvedAmount })), ['set'], {},
    );
    expect(restored.get('set')).toBeNull();
    const back = confirmed.map((l) => ({ ...l, approvedAmount: restored.get(l.id) ?? null }));
    const undone = totalsAfterUndoConfirm(back, offeredDiscount);
    expect(undone.discount).toBe('200.00');
    expect(undone.approvedTotal).toBe(quoteTotalsDecimal(preTotals).approvedTotal);
    // and the offered side was never touched
    expect(quoteTotals(back, undone.discount).offeredTotal).toBe(preTotals.offeredTotal);
  });

  it('a prior (revision-carried) amount comes back instead of null', () => {
    const restored = agreedAmountsAfterUndo(
      [{ id: 'set', approvedAmount: '700.00' }, { id: 'plain', approvedAmount: null }], ['set'], { set: '900.00' },
    );
    expect(restored.get('set')).toBe('900.00');
    expect(restored.get('plain')).toBeNull();
  });

  it('lines confirm did not write keep whatever they had', () => {
    const restored = agreedAmountsAfterUndo([{ id: 'x', approvedAmount: '50.00' }], [], {});
    expect(restored.get('x')).toBe('50.00');
  });

  it('with no adjustment at all, undo leaves the money unchanged', () => {
    const noAdj = [head, piece, plain];
    const before = quoteTotalsDecimal(quoteTotals(noAdj, offeredDiscount));
    const undone = totalsAfterUndoConfirm(noAdj, offeredDiscount);
    expect(undone.approvedTotal).toBe(before.approvedTotal);
    expect(undone.discount).toBe(offeredDiscount);
  });
});

describe('confirmNeedsNewDiscount (DECISION-2026-10-15 §1)', () => {
  // offer 2,000 (1,900 + 100) with a discount of 200
  const offer = (declineFirst: boolean) => [
    line('a', '1900', { approvalStatus: declineFirst ? 'declined' : 'approved' }),
    line('b', '100'),
  ];
  it('pass criterion: offer 2,000, discount 200, approve only 100 -> a new discount is required', () => {
    expect(confirmNeedsNewDiscount(offer(true), '200')).toBe(true);
  });
  it('everything approved (approved == offered) with a discount -> not needed', () => {
    expect(confirmNeedsNewDiscount(offer(false), '200')).toBe(false);
  });
  it('discount 0 -> not needed even when lines are declined', () => {
    expect(confirmNeedsNewDiscount(offer(true), '0')).toBe(false);
    expect(confirmNeedsNewDiscount(offer(true), '0.00')).toBe(false);
  });
  it('a cut set whose agreed amount is below the offer counts as approved < offered', () => {
    expect(confirmNeedsNewDiscount([line('s', '6000', { approvedAmount: '5200.00' })], '100')).toBe(true);
  });
  it('a set agreed at a HIGHER price than offered is not "less"', () => {
    expect(confirmNeedsNewDiscount([line('s', '1000', { approvedAmount: '1300.00' })], '100')).toBe(false);
  });
  it('pending lines count as not approved', () => {
    expect(confirmNeedsNewDiscount([line('a', '500', { approvalStatus: 'pending' })], '50')).toBe(true);
  });
  it('all lines declined with a discount: the rule applies (current behaviour, pinned)', () => {
    expect(confirmNeedsNewDiscount([line('a', '1000', { approvalStatus: 'declined' })], '200')).toBe(true);
  });
});

describe('discountExceedsApproved', () => {
  const approved100 = [line('a', '1900', { approvalStatus: 'declined' }), line('b', '100')];
  it('a discount above the approved subtotal is refused', () => {
    expect(discountExceedsApproved(approved100, '100.01')).toBe(true);
    expect(discountExceedsApproved(approved100, '200')).toBe(true);
  });
  it('equal to the approved subtotal is allowed (bill 0), and so is anything below', () => {
    expect(discountExceedsApproved(approved100, '100')).toBe(false);
    expect(discountExceedsApproved(approved100, '10')).toBe(false);
    expect(discountExceedsApproved(approved100, '0')).toBe(false);
  });
  it('an agreed set amount counts, not the offered price', () => {
    const cut = [line('s', '6000', { approvedAmount: '5200.00' })];
    expect(discountExceedsApproved(cut, '5200')).toBe(false);
    expect(discountExceedsApproved(cut, '5200.01')).toBe(true);
  });
  it('nothing approved: only 0 fits', () => {
    const none = [line('a', '500', { approvalStatus: 'declined' })];
    expect(discountExceedsApproved(none, '0')).toBe(false);
    expect(discountExceedsApproved(none, '1')).toBe(true);
  });
});
