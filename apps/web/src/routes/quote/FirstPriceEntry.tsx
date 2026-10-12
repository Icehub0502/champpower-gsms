import { useState } from 'react';
import type { CatalogHit, CatalogPriceCreateInput, CatalogPriceWritten } from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { baht, typedSatang } from '../../lib/money';
import type { QuotationState } from './useQuotation';

interface FirstPriceEntryProps {
  jobId: string;
  hit: CatalogHit & { itemId: string };
  busyKey: string | null;
  guard: QuotationState['guard'];
  /** Add the line. `unitPrice` undefined = let the server look the price up (it now exists). */
  onAdd: (unitPrice: string | undefined, notice: string | null) => Promise<boolean>;
  onCancel: () => void;
}

/**
 * The item has no price for this car yet (D8): the first price typed becomes
 * the standard price of this car's model (or the base price if the car is not
 * matched to a model). If someone else set it a moment earlier the server
 * answers 409 price_already_set with the price that stands, and the person
 * chooses: use that price, or keep what they typed for THIS quotation only —
 * an override never writes back to the catalog (v3 §4.4).
 */
export function FirstPriceEntry({ jobId, hit, busyKey, guard, onAdd, onCancel }: FirstPriceEntryProps) {
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const [conflict, setConflict] = useState<{ existing: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = busyKey !== null;
  const invalid = typedSatang(typed) === null;
  const fieldError = touched && invalid ? 'ใส่ราคาเป็นตัวเลข 0 ขึ้นไป ทศนิยมไม่เกิน 2 ตำแหน่ง' : null;

  async function submit() {
    setTouched(true);
    setError(null);
    if (invalid) return;
    const body: CatalogPriceCreateInput = { jobId, itemId: hit.itemId, price: typed.trim() };
    const result = await guard('price', () => api.post<CatalogPriceWritten>('/api/catalog/prices', body));
    if (result.ok) {
      const notice = result.value.scope === 'model'
        ? `บันทึก ${baht(result.value.price)} เป็นราคากลางของรุ่นรถคันนี้แล้ว`
        : `บันทึก ${baht(result.value.price)} เป็นราคากลางแล้ว (รถคันนี้ยังไม่ได้จับคู่รุ่น)`;
      await onAdd(undefined, notice);
      return;
    }
    if (result.failure.cancelled) return;
    const body409 = result.failure.body;
    if (body409?.error === 'price_already_set') {
      setConflict({ existing: body409.existingPrice });
      return;
    }
    setError(result.failure.fields.price ?? result.failure.text);
  }

  if (conflict) {
    return (
      <div className="qt-price-entry" role="alertdialog" aria-labelledby="qt-conflict-title">
        <p id="qt-conflict-title"><strong>ราคานี้ถูกตั้งไปแล้วเป็น {baht(conflict.existing)}</strong> — มีคนบันทึกราคากลางก่อนหน้านี้</p>
        <div className="row-flex">
          <button type="button" className="btn small" disabled={busy} onClick={() => void onAdd(undefined, null)}>
            ใช้ {baht(conflict.existing)}
          </button>
          <button type="button" className="btn secondary small" disabled={busy} onClick={() => void onAdd(typed.trim(), null)}>
            ใช้ {baht(typed.trim())} เฉพาะใบนี้
          </button>
          <button type="button" className="btn secondary small" disabled={busy} onClick={onCancel}>ยกเลิก</button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="qt-price-entry"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p><strong>{hit.name}</strong> ยังไม่มีราคาสำหรับรถคันนี้ — พิมพ์ราคาครั้งแรก ระบบจะจำไว้เป็นราคากลาง</p>
      {error && <p className="ci-form-error" role="alert">{error}</p>}
      <label className={`field ci-field${fieldError ? ' has-error' : ''}`}>
        <span className="ci-field-label">ราคาต่อหน่วย (บาท)</span>
        <input inputMode="decimal" autoFocus value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} />
        {fieldError && <span className="ci-field-error">{fieldError}</span>}
      </label>
      <div className="row-flex">
        <button type="submit" className="btn small" disabled={busy}>
          {busyKey === 'price' || busyKey === 'add' ? 'กำลังบันทึก...' : 'บันทึกราคาและเพิ่ม'}
        </button>
        <button type="button" className="btn secondary small" disabled={busy} onClick={onCancel}>ยกเลิก</button>
      </div>
    </form>
  );
}
