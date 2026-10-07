import { describe, expect, it } from 'vitest';
import {
  ALL_SET_DECLINED_NOTE,
  applySetDecision,
  approvedLineSatang,
  bangkokDayKey,
  blocksJobBackToQuoted,
  canSetApprovedAmount,
  canUndoConfirm,
  checkApprovedAmount,
  confirmReadiness,
  defaultIsVatable,
  isClosedByJob,
  isTrueDecline,
  jobOutcomeAtConfirm,
  lineTotalSatang,
  offeredItemLineIds,
  planQuotationClose,
  quoteTotals,
  quoteTotalsDecimal,
  setsNeedingAmount,
  validateLineTree,
  validateQuoteLine,
  withDecisionChanges,
  workOrderLineIds,
  type ApprovalStatus,
  type DeclineReason,
  type QuoteLineDecisionState,
  type QuoteLineMoney,
} from './quote.js';

type L = QuoteLineMoney & QuoteLineDecisionState;

function line(id: string, over: Partial<L> = {}): L {
  return {
    id,
    parentLineId: null,
    qty: '1',
    unitPrice: '0',
    approvalStatus: 'pending',
    declineReason: null,
    declineNote: null,
    approvedAmount: null,
    ...over,
  };
}

/** ชุดโปรช่วงล่าง: header at the set price + 6 children at 0. */
function proSet(price = '20000'): L[] {
  const out: L[] = [line('S', { unitPrice: price })];
  for (let i = 1; i <= 6; i++) out.push(line(`c${i}`, { parentLineId: 'S' }));
  return out;
}

function decide(lines: L[], lineId: string, decision: 'approved' | 'declined', reason?: DeclineReason, note?: string): L[] {
  const r = applySetDecision(lines, { lineId, decision, reason, note });
  if (!r.ok) throw new Error(r.code);
  return withDecisionChanges(lines, r.changes);
}

const status = (lines: L[], id: string): ApprovalStatus => lines.find((l) => l.id === id)!.approvalStatus;

describe('line totals and quote totals', () => {
  it('line total is qty x unit price rounded once', () => {
    expect(lineTotalSatang('2', '1500')).toBe(300000);
    expect(lineTotalSatang('1.5', '333.33')).toBe(50000);
    expect(lineTotalSatang('1', '0')).toBe(0);
  });

  it('counts a set once: children never add, even when mispriced', () => {
    const lines = proSet('20000');
    lines[1] = { ...lines[1]!, unitPrice: '999' }; // a child carrying a price must still not count
    const t = quoteTotals(lines);
    expect(t.offeredSubtotal).toBe(2_000_000);
    expect(t.offeredTotal).toBe(2_000_000);
  });

  it('approved total counts only approved top-level lines', () => {
    const lines = [
      line('a', { unitPrice: '1000', approvalStatus: 'approved' }),
      line('b', { unitPrice: '500', approvalStatus: 'declined', declineReason: 'too_expensive' }),
      line('c', { unitPrice: '300' }),
    ];
    const t = quoteTotals(lines);
    expect(t.offeredSubtotal).toBe(180000);
    expect(t.approvedSubtotal).toBe(100000);
  });

  it('#186: two alternative brands, approve one, decline the other as chose_alternative', () => {
    const lines = [
      line('showa', { unitPrice: '15500', approvalStatus: 'approved' }),
      line('formula', {
        unitPrice: '12000',
        approvalStatus: 'declined',
        declineReason: 'chose_alternative',
      }),
    ];
    const t = quoteTotals(lines);
    expect(t.offeredSubtotal).toBe(2_750_000); // what was offered: both
    expect(t.approvedSubtotal).toBe(1_550_000); // what was accepted: one
    expect(quoteTotalsDecimal(t).approvedTotal).toBe('15500.00');
  });

  it('uses the agreed amount for a cut set, not the set price', () => {
    let lines = proSet('20000');
    lines = decide(lines, 'S', 'approved');
    lines = decide(lines, 'c6', 'declined', 'not_needed_yet');
    lines = lines.map((l) => (l.id === 'S' ? { ...l, approvedAmount: '17500.00' } : l));
    expect(approvedLineSatang(lines[0]!)).toBe(1_750_000);
    expect(quoteTotals(lines).approvedSubtotal).toBe(1_750_000);
    expect(quoteTotals(lines).offeredSubtotal).toBe(2_000_000);
  });

  it('an agreed amount higher than the set price is honoured (Q2)', () => {
    const lines = proSet('20000').map((l) =>
      l.id === 'S' ? { ...l, approvalStatus: 'approved' as const, approvedAmount: '22000' } : l,
    );
    expect(quoteTotals(lines).approvedSubtotal).toBe(2_200_000);
  });

  it('applies the discount as its own amount, clamped so totals are never negative', () => {
    const lines = [line('a', { unitPrice: '1000', approvalStatus: 'approved' }), line('b', { unitPrice: '500' })];
    const t = quoteTotals(lines, '300');
    expect(t.offeredTotal).toBe(150000 - 30000);
    expect(t.approvedTotal).toBe(100000 - 30000);

    const big = quoteTotals(lines, '99999');
    expect(big.offeredTotal).toBe(0);
    expect(big.approvedTotal).toBe(0);
    expect(big.offeredDiscount).toBe(150000);
    expect(big.approvedDiscount).toBe(100000);
  });

  it('clamps the discount against the approved base separately', () => {
    const lines = [
      line('a', { unitPrice: '1000', approvalStatus: 'declined', declineReason: 'next_time' }),
      line('b', { unitPrice: '200', approvalStatus: 'approved' }),
    ];
    const t = quoteTotals(lines, '500');
    expect(t.offeredTotal).toBe(120000 - 50000);
    expect(t.approvedTotal).toBe(0); // 200 approved, 500 discount -> clamped, not -300
  });

  it('a negative discount is treated as none', () => {
    const t = quoteTotals([line('a', { unitPrice: '100', approvalStatus: 'approved' })], '-50');
    expect(t.discount).toBe(0);
    expect(t.approvedTotal).toBe(10000);
  });

  it('is exact with decimals and many lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(`x${i}`, { unitPrice: '0.10', approvalStatus: 'approved' }));
    expect(quoteTotalsDecimal(quoteTotals(lines)).offeredTotal).toBe('1.00');
  });

  it('empty quotation is all zeros', () => {
    expect(quoteTotals([])).toMatchObject({ offeredTotal: 0, approvedTotal: 0 });
  });
});

describe('line validation', () => {
  const ok = { lineType: 'part' as const, qty: '1', unitPrice: '0', isVatable: true };
  it('allows a zero price (free / awaiting price)', () => {
    expect(validateQuoteLine(ok)).toEqual([]);
  });
  it('refuses a negative price', () => {
    expect(validateQuoteLine({ ...ok, unitPrice: '-1' })).toEqual([{ field: 'unitPrice', code: 'unit_price_negative' }]);
  });
  it('refuses junk prices and quantities', () => {
    expect(validateQuoteLine({ ...ok, unitPrice: '1.234' })[0]?.code).toBe('unit_price_invalid');
    expect(validateQuoteLine({ ...ok, qty: 'x' })[0]?.code).toBe('qty_invalid');
    expect(validateQuoteLine({ ...ok, qty: '0' })[0]?.code).toBe('qty_not_positive');
  });
  it('labour is never VAT', () => {
    expect(validateQuoteLine({ ...ok, lineType: 'labor', isVatable: true })).toEqual([
      { field: 'isVatable', code: 'labor_not_vatable' },
    ]);
    expect(validateQuoteLine({ ...ok, lineType: 'labor', isVatable: false })).toEqual([]);
    expect(defaultIsVatable('labor')).toBe(false);
    expect(defaultIsVatable('fee')).toBe(false);
    expect(defaultIsVatable('part')).toBe(true);
  });
});

describe('line tree', () => {
  it('accepts children of a top-level line', () => {
    expect(validateLineTree(proSet())).toEqual([]);
  });
  it('rejects a dangling parent, a self parent and a grandchild', () => {
    const r = validateLineTree([
      { id: 'a', parentLineId: null },
      { id: 'b', parentLineId: 'zzz' },
      { id: 'c', parentLineId: 'c' },
      { id: 'd', parentLineId: 'a' },
      { id: 'e', parentLineId: 'd' },
    ]);
    expect(r.map((x) => [x.lineId, x.issue.code])).toEqual([
      ['b', 'parent_missing'],
      ['c', 'parent_is_self'],
      ['e', 'parent_is_child'],
    ]);
  });
});

describe('applySetDecision — every row of v3 §3.1', () => {
  it('approve parent: pending children follow', () => {
    const r = decide(proSet(), 'S', 'approved');
    expect(['S', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((i) => status(r, i))).toEqual(Array(7).fill('approved'));
  });

  it('approve parent: when EVERY child is declined (undo a declined set) all children come back', () => {
    let l = decide(proSet(), 'S', 'declined', 'next_time');
    l = decide(l, 'S', 'approved');
    for (const id of ['S', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']) {
      const x = l.find((y) => y.id === id)!;
      expect(x.approvalStatus).toBe('approved');
      expect(x.declineReason).toBeNull();
      expect(x.declineNote).toBeNull();
    }
  });

  it('approve parent: a child declined earlier stays declined', () => {
    let l = decide(proSet(), 'c3', 'declined', 'not_needed_yet');
    l = decide(l, 'S', 'approved');
    expect(status(l, 'c3')).toBe('declined');
    expect(status(l, 'c1')).toBe('approved');
    expect(status(l, 'S')).toBe('approved');
  });

  it('decline parent: every pending child declines with the same reason and note', () => {
    const l = decide(proSet(), 'S', 'declined', 'other', 'แพงไป');
    for (const id of ['S', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']) {
      const x = l.find((y) => y.id === id)!;
      expect(x.approvalStatus).toBe('declined');
      expect(x.declineReason).toBe('other');
      expect(x.declineNote).toBe('แพงไป');
    }
  });

  it('decline parent: a child already declined keeps its OWN reason', () => {
    let l = decide(proSet(), 'c3', 'declined', 'not_needed_yet');
    l = decide(l, 'S', 'declined', 'too_expensive');
    expect(l.find((x) => x.id === 'c3')!.declineReason).toBe('not_needed_yet');
    expect(l.find((x) => x.id === 'c1')!.declineReason).toBe('too_expensive');
    expect(l.find((x) => x.id === 'S')!.declineReason).toBe('too_expensive');
  });

  it('decline parent: an approved child is declined too', () => {
    let l = decide(proSet(), 'S', 'approved');
    l = decide(l, 'S', 'declined', 'next_time');
    expect(l.filter((x) => x.approvalStatus === 'declined')).toHaveLength(7);
  });

  it('decline one child is accepted, parent unchanged (no 409)', () => {
    const l = decide(proSet(), 'c6', 'declined', 'not_needed_yet');
    expect(status(l, 'c6')).toBe('declined');
    expect(status(l, 'S')).toBe('pending');
    expect(status(l, 'c1')).toBe('pending');
  });

  it('decline every child with one reason: parent declines itself with that reason', () => {
    let l = proSet();
    for (let i = 1; i <= 6; i++) l = decide(l, `c${i}`, 'declined', 'too_expensive');
    const s = l.find((x) => x.id === 'S')!;
    expect(s.approvalStatus).toBe('declined');
    expect(s.declineReason).toBe('too_expensive');
    expect(s.declineNote).toBeNull();
  });

  it('decline every child with different reasons: parent gets other + the standard note', () => {
    let l = proSet();
    for (let i = 1; i <= 5; i++) l = decide(l, `c${i}`, 'declined', 'too_expensive');
    l = decide(l, 'c6', 'declined', 'next_time');
    const s = l.find((x) => x.id === 'S')!;
    expect(s.approvalStatus).toBe('declined');
    expect(s.declineReason).toBe('other');
    expect(s.declineNote).toBe(ALL_SET_DECLINED_NOTE);
  });

  it('approving a declined child of an auto-declined parent puts the parent back to pending', () => {
    let l = proSet();
    for (let i = 1; i <= 6; i++) l = decide(l, `c${i}`, 'declined', 'too_expensive');
    expect(status(l, 'S')).toBe('declined');
    l = decide(l, 'c2', 'approved');
    expect(status(l, 'c2')).toBe('approved');
    expect(status(l, 'S')).toBe('pending');
    expect(l.find((x) => x.id === 'c2')!.declineReason).toBeNull();
  });

  it('changing one child reason under an already-declined parent keeps the parent reason', () => {
    let l = decide(proSet(), 'S', 'declined', 'too_expensive');
    l = decide(l, 'c1', 'declined', 'next_time');
    const s = l.find((x) => x.id === 'S')!;
    expect(s.declineReason).toBe('too_expensive');
    expect(l.find((x) => x.id === 'c1')!.declineReason).toBe('next_time');
  });

  it('a plain (non-set) line is just approve / decline', () => {
    const l0 = [line('a'), line('b')];
    const l1 = decide(l0, 'a', 'approved');
    expect(status(l1, 'a')).toBe('approved');
    expect(status(l1, 'b')).toBe('pending');
    const l2 = decide(l1, 'a', 'declined', 'chose_alternative');
    expect(l2.find((x) => x.id === 'a')!.declineReason).toBe('chose_alternative');
  });

  it('changing a decision back clears the reason', () => {
    let l = decide([line('a')], 'a', 'declined', 'too_expensive');
    l = decide(l, 'a', 'approved');
    expect(l[0]).toMatchObject({ approvalStatus: 'approved', declineReason: null, declineNote: null });
  });

  it('returns only the lines that really change', () => {
    const l = decide([line('a', { approvalStatus: 'approved' })], 'a', 'approved');
    expect(applySetDecision(l, { lineId: 'a', decision: 'approved' })).toEqual({ ok: true, changes: [] });
  });

  it('refuses a decline without a reason, and "other" without a note', () => {
    expect(applySetDecision([line('a')], { lineId: 'a', decision: 'declined' })).toEqual({
      ok: false,
      code: 'decline_reason_required',
    });
    expect(applySetDecision([line('a')], { lineId: 'a', decision: 'declined', reason: 'other', note: '  ' })).toEqual({
      ok: false,
      code: 'decline_note_required',
    });
  });

  it('refuses an unknown line', () => {
    expect(applySetDecision([line('a')], { lineId: 'nope', decision: 'approved' })).toEqual({
      ok: false,
      code: 'line_not_found',
    });
  });
});

describe('cut sets and confirm readiness (D10)', () => {
  it('a set with a declined child needs an agreed amount; a whole set does not', () => {
    let l = decide(proSet(), 'S', 'approved');
    expect(setsNeedingAmount(l)).toEqual([]);
    l = decide(l, 'c6', 'declined', 'not_needed_yet');
    expect(setsNeedingAmount(l)).toEqual(['S']);
    expect(canSetApprovedAmount(l, 'S')).toBe(true);
    expect(canSetApprovedAmount(l, 'c1')).toBe(false);
  });

  it('a declined parent never needs an amount', () => {
    const l = decide(proSet(), 'S', 'declined', 'next_time');
    expect(setsNeedingAmount(l)).toEqual([]);
  });

  it('cannot confirm while a top-level line is pending', () => {
    const l = [line('a', { approvalStatus: 'approved' }), line('b')];
    expect(confirmReadiness(l)).toEqual({ ready: false, undecidedLineIds: ['b'], setsMissingAmount: [] });
  });

  it('children do not count as undecided on their own', () => {
    const l = decide(proSet(), 'S', 'approved');
    expect(confirmReadiness(l).ready).toBe(true);
  });

  it('cannot confirm a cut set until its amount is supplied — on the line or in the request', () => {
    let l = decide(proSet(), 'S', 'approved');
    l = decide(l, 'c6', 'declined', 'not_needed_yet');
    expect(confirmReadiness(l)).toMatchObject({ ready: false, setsMissingAmount: ['S'] });
    expect(confirmReadiness(l, ['S']).ready).toBe(true);
    const stored = l.map((x) => (x.id === 'S' ? { ...x, approvedAmount: '18000' } : x));
    expect(confirmReadiness(stored).ready).toBe(true);
  });
});

describe('checkApprovedAmount — the 3 tiers (Q2)', () => {
  const offered = 2_000_000; // 20,000.00

  it('blocks negative', () => {
    expect(checkApprovedAmount(offered, -1)).toMatchObject({ ok: false, code: 'negative' });
  });
  it('blocks above 2x, allows exactly 2x', () => {
    expect(checkApprovedAmount(offered, 20_000_000)).toMatchObject({ ok: false, code: 'over_double' }); // 10x
    expect(checkApprovedAmount(offered, 4_000_001)).toMatchObject({ ok: false, code: 'over_double' });
    expect(checkApprovedAmount(offered, 4_000_000)).toMatchObject({ ok: true, kind: 'higher', requiresReason: true });
  });
  it('1.3x passes, needs a reason, and reports the difference in satang', () => {
    expect(checkApprovedAmount(offered, 2_600_000)).toEqual({ ok: true, kind: 'higher', delta: 600_000, requiresReason: true });
  });
  it('lower passes with a reason', () => {
    expect(checkApprovedAmount(offered, 1_700_000)).toEqual({ ok: true, kind: 'lower', delta: -300_000, requiresReason: true });
  });
  it('zero passes with a reason (free of charge)', () => {
    expect(checkApprovedAmount(offered, 0)).toMatchObject({ ok: true, kind: 'zero', requiresReason: true });
  });
  it('the same as offered needs nothing', () => {
    expect(checkApprovedAmount(offered, offered)).toEqual({ ok: true, kind: 'same', delta: 0, requiresReason: false });
  });
  it('a free set cannot be repriced upward — its own code, not "typo"', () => {
    expect(checkApprovedAmount(0, 100)).toMatchObject({ ok: false, code: 'free_set' });
    expect(checkApprovedAmount(0, 0)).toMatchObject({ ok: true, kind: 'same' });
  });
});

describe('jobOutcomeAtConfirm (D4 / D5)', () => {
  it('approve_job when at least one top-level line is approved and none pending', () => {
    expect(
      jobOutcomeAtConfirm([line('a', { approvalStatus: 'approved' }), line('b', { approvalStatus: 'declined', declineReason: 'next_time' })]),
    ).toBe('approve_job');
  });
  it('keep_quoted when everything is declined', () => {
    expect(
      jobOutcomeAtConfirm([line('a', { approvalStatus: 'declined', declineReason: 'too_expensive' })]),
    ).toBe('keep_quoted');
  });
  it('not_ready while any top-level line is pending', () => {
    expect(jobOutcomeAtConfirm([line('a', { approvalStatus: 'approved' }), line('b')])).toBe('not_ready');
  });
  it('ignores children: an approved child under a declined parent does not approve the job', () => {
    const l = [
      line('S', { approvalStatus: 'declined', declineReason: 'too_expensive' }),
      line('c', { parentLineId: 'S', approvalStatus: 'approved' }),
    ];
    expect(jobOutcomeAtConfirm(l)).toBe('keep_quoted');
  });
});

describe('undo confirm', () => {
  const base = { quotationStatus: 'signed' as const, jobStatus: 'approved' };

  it('same Bangkok day and job still approved: allowed', () => {
    expect(canUndoConfirm({ ...base, confirmedAt: '2026-10-01T03:00:00Z', now: '2026-10-01T10:00:00Z' })).toEqual({ ok: true });
  });
  it('uses the Bangkok day, not UTC: 23:30 UTC is already tomorrow in Bangkok', () => {
    expect(bangkokDayKey('2026-10-01T23:30:00Z')).toBe('2026-10-02');
    expect(bangkokDayKey('2026-10-01T16:59:59Z')).toBe('2026-10-01');
    // confirmed 16:30 UTC (23:30 BKK) — undone 17:30 UTC (00:30 BKK next day): different day
    expect(canUndoConfirm({ ...base, confirmedAt: '2026-10-01T16:30:00Z', now: '2026-10-01T17:30:00Z' })).toEqual({
      ok: false,
      code: 'different_day',
    });
    // confirmed 17:30 UTC and undone 20:00 UTC: both 2 Oct in Bangkok
    expect(canUndoConfirm({ ...base, confirmedAt: '2026-10-01T17:30:00Z', now: '2026-10-01T20:00:00Z' })).toEqual({ ok: true });
  });
  it('refused once the job moved on', () => {
    expect(
      canUndoConfirm({ ...base, jobStatus: 'repairing', confirmedAt: '2026-10-01T03:00:00Z', now: '2026-10-01T04:00:00Z' }),
    ).toEqual({ ok: false, code: 'job_moved_on' });
  });
  it('refused unless the quotation is signed', () => {
    expect(
      canUndoConfirm({ ...base, quotationStatus: 'issued', confirmedAt: '2026-10-01T03:00:00Z', now: '2026-10-01T04:00:00Z' }),
    ).toEqual({ ok: false, code: 'not_signed' });
  });
  it('approved -> quoted is blocked only while signed', () => {
    expect(blocksJobBackToQuoted('signed')).toBe(true);
    expect(blocksJobBackToQuoted('issued')).toBe(false);
    expect(blocksJobBackToQuoted('superseded')).toBe(false);
    expect(blocksJobBackToQuoted(null)).toBe(false);
  });
});

describe('planQuotationClose (Q1)', () => {
  const pendingLines = [line('a'), line('b', { approvalStatus: 'approved' })];

  it('signed is never touched, not even by rejected', () => {
    expect(planQuotationClose({ targetStatus: 'rejected', quotation: { status: 'signed', lines: pendingLines } })).toEqual({ action: 'none' });
  });
  it('no quotation / superseded / void: nothing to do', () => {
    expect(planQuotationClose({ targetStatus: 'rejected', quotation: null })).toEqual({ action: 'none' });
    expect(planQuotationClose({ targetStatus: 'carout', quotation: { status: 'superseded', lines: [] } })).toEqual({ action: 'none' });
    expect(planQuotationClose({ targetStatus: 'carout', quotation: { status: 'void', lines: [] } })).toEqual({ action: 'none' });
  });
  it('rejected on an issued quotation with pending lines needs a reason', () => {
    expect(planQuotationClose({ targetStatus: 'rejected', quotation: { status: 'issued', lines: pendingLines } })).toEqual({
      action: 'refuse',
      code: 'decline_reason_required',
    });
  });
  it('with a reason, every pending line (children included) is declined; decided ones are kept', () => {
    const lines = [line('S'), line('c', { parentLineId: 'S' }), line('ok', { approvalStatus: 'approved' })];
    expect(
      planQuotationClose({ targetStatus: 'rejected', quotation: { status: 'issued', lines }, declineReason: 'too_expensive' }),
    ).toEqual({ action: 'close', declineLineIds: ['S', 'c'], reason: 'too_expensive', note: null });
  });
  it('chose_alternative is not a valid reason here; other needs a note', () => {
    expect(
      planQuotationClose({ targetStatus: 'rejected', quotation: { status: 'issued', lines: pendingLines }, declineReason: 'chose_alternative' }),
    ).toEqual({ action: 'refuse', code: 'decline_reason_not_allowed' });
    expect(
      planQuotationClose({ targetStatus: 'rejected', quotation: { status: 'issued', lines: pendingLines }, declineReason: 'other' }),
    ).toEqual({ action: 'refuse', code: 'decline_note_required' });
  });
  it('rejected with everything already decided needs no reason', () => {
    const decided = [line('a', { approvalStatus: 'declined', declineReason: 'next_time' })];
    expect(planQuotationClose({ targetStatus: 'rejected', quotation: { status: 'issued', lines: decided } })).toEqual({
      action: 'close',
      declineLineIds: [],
      reason: null,
      note: null,
    });
  });
  it('carout never needs a reason and leaves pending lines pending', () => {
    expect(planQuotationClose({ targetStatus: 'carout', quotation: { status: 'issued', lines: pendingLines } })).toEqual({
      action: 'close',
      declineLineIds: [],
      reason: null,
      note: null,
    });
  });
  it('a draft is left untouched — no close, no reason, whatever the target', () => {
    expect(planQuotationClose({ targetStatus: 'rejected', quotation: { status: 'draft', lines: pendingLines } })).toEqual({ action: 'none' });
    expect(planQuotationClose({ targetStatus: 'carout', quotation: { status: 'draft', lines: pendingLines } })).toEqual({ action: 'none' });
  });
  it('recognises a system close', () => {
    expect(isClosedByJob({ status: 'void', voidReason: 'job_closed', voidedBy: null })).toBe(true);
    expect(isClosedByJob({ status: 'void', voidReason: 'job_closed', voidedBy: 'u1' })).toBe(false);
    expect(isClosedByJob({ status: 'void', voidReason: 'wrong customer', voidedBy: null })).toBe(false);
  });
});

describe('reporting vocabulary', () => {
  it('chose_alternative is not a true decline (D13)', () => {
    expect(isTrueDecline('chose_alternative')).toBe(false);
    expect(isTrueDecline(null)).toBe(false);
    for (const r of ['too_expensive', 'next_time', 'going_elsewhere', 'not_needed_yet', 'other'] as const) {
      expect(isTrueDecline(r)).toBe(true);
    }
  });
});

describe('work order and offered items', () => {
  it('approve 2 of 4 lines: the work order has 2, the declined 2 stay out', () => {
    const l = [
      line('a', { approvalStatus: 'approved' }),
      line('b', { approvalStatus: 'declined', declineReason: 'too_expensive' }),
      line('c', { approvalStatus: 'approved' }),
      line('d', { approvalStatus: 'declined', declineReason: 'next_time' }),
    ];
    expect(workOrderLineIds(l)).toEqual(['a', 'c']);
  });

  it('a cut set shows 5 children, not 6', () => {
    let l = decide(proSet(), 'S', 'approved');
    l = decide(l, 'c4', 'declined', 'not_needed_yet');
    expect(workOrderLineIds(l)).toEqual(['S', 'c1', 'c2', 'c3', 'c5', 'c6']);
  });

  it('a declined set shows nothing, even if a child was approved', () => {
    let l = decide(proSet(), 'S', 'declined', 'next_time');
    l = l.map((x) => (x.id === 'c1' ? { ...x, approvalStatus: 'approved' as const } : x));
    expect(workOrderLineIds(l)).toEqual([]);
  });

  it('writes offered items for next_time only, parent not children, never chose_alternative', () => {
    const l = [
      line('a', { approvalStatus: 'declined', declineReason: 'next_time' }),
      line('b', { approvalStatus: 'declined', declineReason: 'chose_alternative' }),
      line('c', { approvalStatus: 'declined', declineReason: 'too_expensive' }),
      ...decide(proSet(), 'S', 'declined', 'next_time').map((x) => ({ ...x, id: `p${x.id}`, parentLineId: x.parentLineId ? `p${x.parentLineId}` : null })),
    ];
    expect(offeredItemLineIds(l)).toEqual(['a', 'pS']);
  });

  it('a child cut with next_time under an approved parent is remembered', () => {
    let l = decide(proSet(), 'S', 'approved');
    l = decide(l, 'c6', 'declined', 'next_time');
    expect(offeredItemLineIds(l)).toEqual(['c6']);
  });
});

import { jobStatusOnIssue } from './quote.js';

describe('jobStatusOnIssue', () => {
  it('moves received and inspecting to quoted', () => {
    expect(jobStatusOnIssue('received')).toBe('quoted');
    expect(jobStatusOnIssue('inspecting')).toBe('quoted');
  });
  it('never moves any other status — no backwards or sideways move', () => {
    for (const s of ['quoted', 'approved', 'repairing', 'aligning', 'ready', 'delivered', 'rejected', 'carout', 'unknown']) {
      expect(jobStatusOnIssue(s), s).toBeNull();
    }
  });
});
