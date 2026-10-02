/**
 * Money gate for P3.1 Stage 1 (CLAUDE.md §4, §13). Property-style tests with a
 * deterministic PRNG (fast-check is not installed) checked against an
 * independent BigInt reference that shares no code with money.ts / quote.ts.
 */
import { describe, expect, it } from 'vitest';
import { formatSatang, mulQty, sumSatang, toQtyCenti, toSatang, MoneyError, MAX_SATANG } from './money.js';
import {
  approvedLineSatang,
  checkApprovedAmount,
  lineTotalSatang,
  quoteTotals,
  quoteTotalsDecimal,
  type ApprovalStatus,
  type QuoteLineMoney,
} from './quote.js';

// ---------- deterministic generator ----------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = () => number;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: R, xs: readonly T[]) => xs[int(r, 0, xs.length - 1)]!;

// ---------- independent BigInt reference ----------
function refScaled(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error('ref parse ' + s);
  const v = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -v : v;
}
function refRoundDiv100(p: bigint): bigint {
  const neg = p < 0n;
  const a = neg ? -p : p;
  const q = a / 100n;
  const rem = a % 100n;
  const r = rem >= 50n ? q + 1n : q;
  return neg ? -r : r;
}
const refLine = (qty: string, price: string) => refRoundDiv100(refScaled(qty) * refScaled(price));
function refFmt(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
interface RefTotals { off: bigint; app: bigint }
function refTotals(lines: readonly QuoteLineMoney[], discount: string): RefTotals {
  const top = lines.filter((l) => l.parentLineId === null);
  const offSub = top.reduce((s, l) => s + refLine(l.qty, l.unitPrice), 0n);
  const appSub = top
    .filter((l) => l.approvalStatus === 'approved')
    .reduce((s, l) => s + (l.approvedAmount !== null ? refScaled(l.approvedAmount) : refLine(l.qty, l.unitPrice)), 0n);
  const d0 = refScaled(discount);
  const d = d0 < 0n ? 0n : d0;
  const clamp = (sub: bigint) => (sub <= 0n ? 0n : d > sub ? sub : d);
  return { off: offSub - clamp(offSub), app: appSub - clamp(appSub) };
}

// ---------- random quotation ----------
const dec2 = (satang: number) => formatSatang(satang);
function randQty(r: R): string {
  const mode = int(r, 0, 3);
  if (mode === 0) return String(int(r, 1, 20));
  if (mode === 1) return dec2(int(r, 1, 5000)); // up to 50.00, 2dp
  if (mode === 2) return `${int(r, 0, 9)}.${int(r, 1, 9)}`; // 1dp, may be 0.x
  return `0.${String(int(r, 1, 99)).padStart(2, '0')}`; // sub-unit
}
function randPrice(r: R): string {
  const mode = int(r, 0, 4);
  if (mode === 0) return '0.00';
  if (mode === 1) return '999999.99';
  if (mode === 2) return dec2(int(r, 0, 99999999)); // up to 999,999.99
  if (mode === 3) return String(int(r, 0, 999999)); // whole baht, no fraction
  return dec2(int(r, 1, 999)); // tiny, rounding-prone
}
const STATUSES: ApprovalStatus[] = ['pending', 'approved', 'declined'];
function randQuote(r: R): { lines: QuoteLineMoney[]; discount: string } {
  const lines: QuoteLineMoney[] = [];
  const nTop = int(r, 0, 8);
  for (let i = 0; i < nTop; i++) {
    const id = `t${i}`;
    const status = pick(r, STATUSES);
    const hasAmount = status === 'approved' && r() < 0.3;
    lines.push({
      id,
      parentLineId: null,
      qty: randQty(r),
      unitPrice: randPrice(r),
      approvalStatus: status,
      approvedAmount: hasAmount ? dec2(int(r, 0, 99999999)) : null,
    });
    if (r() < 0.4) {
      for (let c = 0; c < int(r, 0, 8); c++) {
        lines.push({
          id: `${id}c${c}`,
          parentLineId: id,
          qty: randQty(r),
          unitPrice: randPrice(r), // deliberately priced: must be ignored
          approvalStatus: pick(r, STATUSES),
          approvedAmount: r() < 0.2 ? dec2(int(r, 0, 99999999)) : null,
        });
      }
    }
  }
  const dm = int(r, 0, 4);
  const discount =
    dm === 0 ? '0' : dm === 1 ? '0.00' : dm === 2 ? dec2(int(r, 0, 5000000)) : dm === 3 ? '99999999.99' : dec2(int(r, 0, 999));
  return { lines, discount };
}

const N = 3000;

describe('1. totals reconcile with an independent BigInt reference', () => {
  it(`matches the reference, never negative, exact strings (${N} random quotations)`, () => {
    const r = rng(20261001);
    for (let i = 0; i < N; i++) {
      const { lines, discount } = randQuote(r);
      const t = quoteTotals(lines, discount);
      const ref = refTotals(lines, discount);
      const ctx = JSON.stringify({ lines, discount });
      expect(Number.isInteger(t.offeredTotal), ctx).toBe(true);
      expect(Number.isInteger(t.approvedTotal), ctx).toBe(true);
      expect(BigInt(t.offeredTotal), ctx).toBe(ref.off);
      expect(BigInt(t.approvedTotal), ctx).toBe(ref.app);
      expect(t.offeredTotal).toBeGreaterThanOrEqual(0);
      expect(t.approvedTotal).toBeGreaterThanOrEqual(0);
      const d = quoteTotalsDecimal(t);
      expect(d.offeredTotal, ctx).toBe(refFmt(ref.off));
      expect(d.approvedTotal, ctx).toBe(refFmt(ref.app));
      expect(d.offeredTotal).toMatch(/^\d+\.\d{2}$/);
      expect(d.approvedTotal).toMatch(/^\d+\.\d{2}$/);
      // internal identity
      expect(t.offeredSubtotal - t.offeredDiscount).toBe(t.offeredTotal);
      expect(t.approvedSubtotal - t.approvedDiscount).toBe(t.approvedTotal);
    }
  });

  it('discount larger than subtotal clamps to exactly zero, not negative', () => {
    const l: QuoteLineMoney = { id: 'a', parentLineId: null, qty: '1', unitPrice: '100.00', approvalStatus: 'approved', approvedAmount: null };
    const t = quoteTotals([l], '100.01');
    expect(t.offeredTotal).toBe(0);
    expect(t.approvedTotal).toBe(0);
    expect(t.offeredDiscount).toBe(10000);
    expect(quoteTotals([l], '100.00').offeredTotal).toBe(0);
    expect(quoteTotals([l], '99.99').offeredTotal).toBe(1);
  });

  it('negative discount is treated as no discount (never inflates the total)', () => {
    const l: QuoteLineMoney = { id: 'a', parentLineId: null, qty: '1', unitPrice: '100.00', approvalStatus: 'approved', approvedAmount: null };
    expect(quoteTotals([l], '-50.00').offeredTotal).toBe(10000);
  });

  it('empty quotation is 0.00 / 0.00', () => {
    const d = quoteTotalsDecimal(quoteTotals([], '5.00'));
    expect(d.offeredTotal).toBe('0.00');
    expect(d.approvedTotal).toBe('0.00');
  });

  it('classic float trap: 3 x 0.10 + 3 x 0.20 is exactly 0.90', () => {
    const mk = (id: string, p: string): QuoteLineMoney => ({ id, parentLineId: null, qty: '3', unitPrice: p, approvalStatus: 'pending', approvedAmount: null });
    expect(quoteTotalsDecimal(quoteTotals([mk('a', '0.10'), mk('b', '0.20')])).offeredTotal).toBe('0.90');
  });

  it('refuses float residue and >2dp input instead of rounding it', () => {
    expect(() => toSatang(0.1 + 0.2)).toThrow(MoneyError);
    expect(() => toSatang('1.005')).toThrow(MoneyError);
    expect(() => toQtyCenti('1.234')).toThrow(MoneyError);
    expect(() => toSatang(1e21)).toThrow(MoneyError);
    expect(() => toSatang('1e3')).toThrow(MoneyError);
    expect(() => toSatang('NaN')).toThrow(MoneyError);
    expect(() => toSatang(Infinity)).toThrow(MoneyError);
  });
});

describe('2. set children never contribute to totals', () => {
  it('whatever the child price, status or approved_amount', () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      const { lines, discount } = randQuote(r);
      const base = quoteTotals(lines.filter((l) => l.parentLineId === null), discount);
      const withKids = quoteTotals(lines, discount);
      expect(withKids).toEqual(base);
      // mutate children to absurd prices; totals must not move
      const mutated = lines.map((l) =>
        l.parentLineId === null ? l : { ...l, unitPrice: '999999.99', qty: '99.99', approvedAmount: '123456.78', approvalStatus: 'approved' as const },
      );
      expect(quoteTotals(mutated, discount)).toEqual(base);
    }
  });
});

describe('3. approved_amount and declined handling', () => {
  const line = (over: Partial<QuoteLineMoney>): QuoteLineMoney => ({
    id: 'p', parentLineId: null, qty: '1', unitPrice: '1000.00', approvalStatus: 'approved', approvedAmount: null, ...over,
  });

  it('replaces line_total for that approved parent only', () => {
    const a = line({ id: 'a', approvedAmount: '700.00' });
    const b = line({ id: 'b' });
    const t = quoteTotals([a, b]);
    expect(t.approvedSubtotal).toBe(70000 + 100000);
    expect(t.offeredSubtotal).toBe(200000); // offered side ignores approved_amount
  });

  it('falls back to line total when approved_amount is null', () => {
    expect(approvedLineSatang(line({ qty: '2', unitPrice: '12.345'.slice(0, 5) }))).toBe(lineTotalSatang('2', '12.34'));
  });

  it('approved_amount 0 is a real value (free), not a fallback', () => {
    expect(quoteTotals([line({ approvedAmount: '0.00' })]).approvedSubtotal).toBe(0);
    expect(quoteTotals([line({ approvedAmount: '0' })]).approvedSubtotal).toBe(0);
  });

  it('declined and pending lines contribute 0 to approved side even with approved_amount set', () => {
    for (const s of ['declined', 'pending'] as const) {
      const t = quoteTotals([line({ approvalStatus: s, approvedAmount: '500.00' })]);
      expect(t.approvedSubtotal).toBe(0);
      expect(t.offeredSubtotal).toBe(100000);
    }
  });
});

describe('4. checkApprovedAmount boundaries', () => {
  it('offer 1000.00', () => {
    const o = toSatang('1000.00');
    expect(checkApprovedAmount(o, toSatang('-0.01'))).toMatchObject({ ok: false, code: 'negative' });
    expect(checkApprovedAmount(o, 0)).toMatchObject({ ok: true, kind: 'zero', requiresReason: true });
    expect(checkApprovedAmount(o, toSatang('2000.00'))).toMatchObject({ ok: true, kind: 'higher', requiresReason: true, delta: o });
    expect(checkApprovedAmount(o, toSatang('2000.01'))).toMatchObject({ ok: false, code: 'over_double' });
    expect(checkApprovedAmount(o, o)).toMatchObject({ ok: true, kind: 'same', requiresReason: false, delta: 0 });
    expect(checkApprovedAmount(o, o - 1)).toMatchObject({ ok: true, kind: 'lower' });
    expect(checkApprovedAmount(o, o + 1)).toMatchObject({ ok: true, kind: 'higher' });
  });
  it('odd offer: 2x boundary is exact in satang', () => {
    expect(checkApprovedAmount(1, 2)).toMatchObject({ ok: true });
    expect(checkApprovedAmount(1, 3)).toMatchObject({ ok: false, code: 'over_double' });
  });
  it('free offer (0): any positive is blocked with free_set; 0 and negative behave', () => {
    expect(checkApprovedAmount(0, 1)).toMatchObject({ ok: false, code: 'free_set' });
    expect(checkApprovedAmount(0, 999999999999)).toMatchObject({ ok: false, code: 'free_set' });
    expect(checkApprovedAmount(0, 0)).toMatchObject({ ok: true, kind: 'same', requiresReason: false });
    expect(checkApprovedAmount(0, -1)).toMatchObject({ ok: false, code: 'negative' });
  });
  it('exhaustive small grid agrees with the spec table', () => {
    for (let o = 0; o <= 30; o++) {
      for (let a = -5; a <= 70; a++) {
        const res = checkApprovedAmount(o, a);
        if (a < 0) expect(res).toMatchObject({ ok: false, code: 'negative' });
        else if (o === 0 && a > 0) expect(res).toMatchObject({ ok: false, code: 'free_set' });
        else if (a > 2 * o) expect(res).toMatchObject({ ok: false, code: 'over_double' });
        else expect(res.ok).toBe(true);
      }
    }
  });
});

describe('5. rounding: once per line, half away from zero', () => {
  it('table of half cases', () => {
    // qty x price -> expected satang. 0.5 satang rounds up.
    const cases: Array<[string, string, string]> = [
      ['0.50', '0.01', '0.01'], // 0.005 baht -> 0.01
      ['0.49', '0.01', '0.00'],
      ['1.50', '0.01', '0.02'], // 0.015 -> 0.02
      ['2.50', '0.01', '0.03'],
      ['0.01', '0.50', '0.01'],
      ['0.33', '1.00', '0.33'],
      ['3.33', '0.15', '0.50'], // 0.4995 -> 0.50
    ];
    for (const [q, p, e] of cases) expect(formatSatang(lineTotalSatang(q, p)), `${q}x${p}`).toBe(e);
  });
  it('mulQty is symmetric: negative mirrors positive (half away from zero)', () => {
    // Loose equality, not Object.is: a result that rounds to zero is 0 for
    // BOTH signs (BigInt has no -0), so `-mulQty(q, p)` is a signed -0 while
    // `mulQty(-q, p)` is +0 — equal as money (0 === -0), not as bit patterns.
    for (let q = 1; q <= 300; q++) for (const p of [1, 5, 33, 99, 12345]) {
      // eslint-disable-next-line eqeqeq
      expect(mulQty(-q, p) == -mulQty(q, p)).toBe(true);
    }
  });
  it('mulQty matches BigInt reference across a grid', () => {
    const r = rng(99);
    for (let i = 0; i < 5000; i++) {
      const q = int(r, 1, 99999), p = int(r, 0, 99999999);
      expect(BigInt(mulQty(q, p))).toBe(refRoundDiv100(BigInt(q) * BigInt(p)));
    }
  });
  it('DOCUMENTED: sum of rounded lines differs from rounded sum; the system chooses per-line', () => {
    // Three lines of qty 0.50 x 0.01 baht: each is 0.005 -> rounds to 0.01.
    // Per-line: 3 x 0.01 = 0.03. Rounding the exact sum (0.015) once gives 0.02.
    // CLAUDE.md §4.3 mandates per-line, so 0.03 is the correct answer.
    const mk = (id: string): QuoteLineMoney => ({ id, parentLineId: null, qty: '0.50', unitPrice: '0.01', approvalStatus: 'pending', approvedAmount: null });
    const lines = [mk('a'), mk('b'), mk('c')];
    const t = quoteTotals(lines);
    expect(t.offeredSubtotal).toBe(3);
    const roundedSumOnce = refRoundDiv100(3n * refScaled('0.50') * refScaled('0.01'));
    expect(roundedSumOnce).toBe(2n);
    expect(BigInt(t.offeredSubtotal)).not.toBe(roundedSumOnce);
    // and the opposite direction: 0.4 each rounds down (0.0040 -> 0.00), sum 0.012 -> 0.01
    const mk2 = (id: string): QuoteLineMoney => ({ id, parentLineId: null, qty: '0.40', unitPrice: '0.01', approvalStatus: 'pending', approvedAmount: null });
    expect(quoteTotals([mk2('a'), mk2('b'), mk2('c')]).offeredSubtotal).toBe(0);
  });
});

describe('6. numeric(12,2) limits', () => {
  const MAX = '9999999999.99';
  it('accepts the maximum exactly and round-trips it', () => {
    expect(toSatang(MAX)).toBe(999_999_999_999);
    expect(formatSatang(toSatang(MAX))).toBe(MAX);
    expect(lineTotalSatang('1', MAX)).toBe(999_999_999_999);
    expect(lineTotalSatang('9999999999.99', '1')).toBe(999_999_999_999);
  });
  it('refuses a single money/qty value beyond the maximum', () => {
    expect(() => toSatang('10000000000.00')).toThrow(MoneyError);
    expect(() => toSatang('9999999999.99'.replace('99.99', '99.999'))).toThrow(MoneyError);
    expect(() => toQtyCenti('10000000000')).toThrow(MoneyError);
    expect(() => toSatang('99999999999999999999')).toThrow(MoneyError);
    expect(() => quoteTotals([], '10000000000.00')).toThrow(MoneyError);
  });
  it('large products stay exact (BigInt in the middle) or throw, never silently lose precision', () => {
    const r = rng(5);
    for (let i = 0; i < 3000; i++) {
      const q = `${int(r, 0, 99999)}.${String(int(r, 0, 99)).padStart(2, '0')}`;
      const p = `${int(r, 0, 9999999999)}.${String(int(r, 0, 99)).padStart(2, '0')}`;
      if (refScaled(q) === 0n) continue;
      let got: number | null = null;
      try { got = lineTotalSatang(q, p); } catch (e) { expect(e).toBeInstanceOf(MoneyError); }
      if (got !== null) expect(BigInt(got), `${q}x${p}`).toBe(refRoundDiv100(refScaled(q) * refScaled(p)));
    }
  });
  // Results (line totals, sums, formatted values) must stay inside
  // numeric(12,2) = +-MAX_SATANG; overflow is a domain MoneyError, not an
  // opaque Postgres error at INSERT time.
  it('refuses a line total beyond numeric(12,2): 100000 x 999999.99', () => {
    expect(() => lineTotalSatang('100000', '999999.99')).toThrow(MoneyError);
  });
  it('refuses a summed total beyond numeric(12,2): two MAX lines', () => {
    const mk = (id: string): QuoteLineMoney => ({ id, parentLineId: null, qty: '1', unitPrice: MAX, approvalStatus: 'approved', approvedAmount: null });
    expect(() => quoteTotals([mk('a'), mk('b')])).toThrow(MoneyError);
  });
  it('refuses to format a satang value beyond numeric(12,2)', () => {
    expect(() => formatSatang(MAX_SATANG + 1)).toThrow(MoneyError);
    expect(() => formatSatang(-(MAX_SATANG + 1))).toThrow(MoneyError);
  });
  it('boundary: exactly MAX_SATANG is accepted, one satang over is refused', () => {
    expect(mulQty(100, MAX_SATANG)).toBe(MAX_SATANG); // qty 1.00 x max price
    expect(() => mulQty(100, MAX_SATANG + 1)).toThrow(MoneyError);
    expect(sumSatang([MAX_SATANG - 1, 1])).toBe(MAX_SATANG);
    expect(() => sumSatang([MAX_SATANG, 1])).toThrow(MoneyError);
    expect(formatSatang(MAX_SATANG)).toBe(MAX);
    expect(lineTotalSatang('1', MAX)).toBe(MAX_SATANG);
    expect(() => lineTotalSatang('1.01', MAX)).toThrow(MoneyError);
  });
});
