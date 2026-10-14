import { useState } from 'react';
import type { QuotationTotals } from '@gsms/contracts/index.js';
import { baht, typedSatang } from '../../lib/money';

interface QuoteTotalsPanelProps {
  totals: QuotationTotals;
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
 * The two totals, always both (CLAUDE.md §5.1 #3): what was offered and what
 * the customer approved — the second is what flows to the receipt. Every figure
 * is the server's (packages/domain quoteTotals, computed in the API); nothing
 * is added up here. The discount is its own line, as on the paper (v2 §8.4).
 */
export function QuoteTotalsPanel({ totals, discountEditable, busy, saving, discountError, onSaveDiscount }: QuoteTotalsPanelProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? totals.discount;
  const invalid = draft !== null && typedSatang(draft) === null;
  const error = invalid ? 'จำนวนเงินไม่ถูกต้อง — ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง' : discountError ?? null;

  function save() {
    if (draft === null || invalid) return;
    const typed = draft.trim();
    void onSaveDiscount?.(typed).then((ok) => { if (ok) setDraft(null); });
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
              disabled={busy}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setDraft(e.target.value)}
            />
            {error && <span className="ci-field-error">{error}</span>}
          </label>
          <button type="submit" className="btn secondary" disabled={busy || draft === null || invalid}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกส่วนลด'}
          </button>
        </form>
      )}
    </section>
  );
}
