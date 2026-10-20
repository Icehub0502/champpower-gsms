import { useState } from 'react';
import { MoneyError, toSatang } from '@champpower/domain';
import type { QuotationTotals } from '@gsms/contracts/index.js';
import { baht, typedSatang } from '../../lib/money';

interface QuoteTotalsPanelProps {
  totals: QuotationTotals;
  /** Confirmed ("ยืนยันผลลูกค้า" done): the agreed discount may differ from the offered one. */
  confirmed?: boolean;
  /** Draft only: the discount can be edited here (later only inside "ยืนยันผลลูกค้า"). */
  discountEditable: boolean;
  /** Any mutation in flight: the button is disabled. */
  busy: boolean;
  /** This panel's own save is in flight: the button says so. */
  saving?: boolean;
  /** Field error for the discount from the last save. */
  discountError?: string | null;
  /** Resolves true when saved; a failed save keeps what was typed. */
  onSaveDiscount?: (amount: string) => Promise<boolean>;
}

/**
 * The two totals in one line, kept in view by CSS (position: sticky above the
 * phone dock) wherever the full panel is not: below 1024px always, and at any
 * width while the add panel holds the right column (`withCatalog`). Same
 * server figures as the panel; nothing is computed here.
 */
export function QuoteTotalsBar({ totals, withCatalog }: { totals: QuotationTotals; withCatalog: boolean }) {
  return (
    <p className={`qt-totals-bar${withCatalog ? ' is-with-catalog' : ''}`} data-testid="totals-bar">
      <span>ยอดเสนอ <strong className="mono">{baht(totals.offeredTotal)}</strong></span>
      <span aria-hidden="true" className="qt-totals-bar-sep">·</span>
      <span className="is-approved">ยอดอนุมัติ <strong className="mono">{baht(totals.approvedTotal)}</strong></span>
    </p>
  );
}

/**
 * The two totals, always both (CLAUDE.md §5.1 #3): what was offered and what
 * the customer approved — the second is what flows to the receipt. Every figure
 * is the server's (packages/domain quoteTotals, computed in the API); nothing
 * is added up here. The discount is its own line, as on the paper (v2 §8.4).
 */
export function QuoteTotalsPanel({ totals, confirmed = false, discountEditable, busy, saving, discountError, onSaveDiscount }: QuoteTotalsPanelProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // No discount = an EMPTY box with "0.00" as placeholder, not "0.00" as a value: typed after,
  // "200" became "0.00200" and an error (ux P3.1 #2). Chosen over select-all-on-focus, which
  // iOS Safari undoes on the tap's mouseup, and which a second tap into the box loses anyway.
  const shown = draft ?? (typedSatang(totals.discount) === 0 ? '' : totals.discount);
  // An emptied box means what the empty box shows: no discount.
  const typedAmount = draft === null ? null : draft.trim() === '' ? '0' : draft.trim();
  const typedValue = typedAmount === null ? null : typedSatang(typedAmount);
  const invalid = typedAmount !== null && typedValue === null;
  // The same amount as now, in satang ("0", "" and "0.00" at no discount): nothing to save.
  const unchanged = typedValue !== null && typedValue === typedSatang(totals.discount);
  // Compared in satang through the domain parser ("200" vs "200.00" is the same discount).
  // Only after confirm: before it the two can differ only by the offer's clamp, which is not an agreement.
  let agreedDiffers = false;
  try {
    agreedDiffers = confirmed && toSatang(totals.discount) !== toSatang(totals.offeredDiscount);
  } catch (err) {
    // A value the money parser refuses: show nothing rather than guess. Anything else is a bug.
    if (!(err instanceof MoneyError)) throw err;
    agreedDiffers = false;
  }
  const error = invalid ? 'จำนวนเงินไม่ถูกต้อง — ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง' : discountError ?? null;

  function save() {
    if (typedAmount === null || invalid || unchanged) return;
    void onSaveDiscount?.(typedAmount).then((ok) => { if (ok) setDraft(null); });
  }

  return (
    <section className="qt-totals" aria-label="ยอดรวม">
      <div className="qt-totals-col" data-testid="offered-total">
        <h4>ยอดเสนอทั้งหมด</h4>
        <dl>
          <dt>รวมรายการ</dt>
          <dd className="mono">{baht(totals.offeredSubtotal)}</dd>
          <dt>ส่วนลด</dt>
          <dd className="mono">−{baht(totals.offeredDiscount)}</dd>
        </dl>
        <p className="qt-totals-sum mono">{baht(totals.offeredTotal)}</p>
      </div>
      <div className="qt-totals-col is-approved" data-testid="approved-total">
        <h4>ยอดที่ลูกค้าอนุมัติ</h4>
        <dl>
          <dt>รวมรายการ</dt>
          <dd className="mono">{baht(totals.approvedSubtotal)}</dd>
          <dt>ส่วนลด</dt>
          <dd className="mono">−{baht(totals.approvedDiscount)}</dd>
        </dl>
        <p className="qt-totals-sum mono">{baht(totals.approvedTotal)}</p>
        {agreedDiffers && (
          // DECISION-2026-10-15 §1: confirm set a new discount — the offer's stays on the paper, so show both.
          <p className="qt-line-sub" data-testid="discount-offered-agreed">
            ส่วนลดที่เสนอ <span className="mono">{baht(totals.offeredDiscount)}</span>
            {' · '}ส่วนลดที่ตกลง <span className="mono">{baht(totals.discount)}</span>
          </p>
        )}
      </div>

      {discountEditable && onSaveDiscount && (
        <form
          className="qt-discount"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className={`field ci-field${error ? ' has-error' : ''}`}>
            <span className="ci-field-label">ส่วนลดท้ายบิล (บาท)</span>
            <input
              inputMode="decimal"
              value={shown}
              placeholder="0.00"
              disabled={busy}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setDraft(e.target.value)}
            />
            {error && <span className="ci-field-error">{error}</span>}
          </label>
          <button type="submit" className="btn secondary" disabled={busy || draft === null || invalid || unchanged}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกส่วนลด'}
          </button>
        </form>
      )}
    </section>
  );
}
