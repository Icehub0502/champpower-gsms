import { useId, useState } from 'react';
import type { AddLineInput, LineType, Quotation } from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { typedSatang } from '../../lib/money';
import type { QuoteFailure } from './quoteErrors';
import { LINE_TYPE_LABEL } from './quoteLabels';
import { quotationPath, type QuotationState } from './useQuotation';

interface FreeLineFormProps {
  jobId: string;
  initialName: string;
  busyKey: string | null;
  run: QuotationState['run'];
  onDone: () => void;
  onCancel: () => void;
}

/** The answers to the similar-name warning, added to the same request. */
interface SimilarAnswer {
  useExistingItemId?: string;
  confirmNotSimilar?: boolean;
}

/**
 * A line typed by hand (panel A's "+ เพิ่มรายการใหม่": name, then category).
 * "เพิ่มเข้าแคตตาล็อก" is ticked by default (D12) so the catalog grows from
 * real work — and the server warns when the name is close to one already in
 * that category (v3 §4.5): the person picks the existing item or says it
 * really is new. The price must be typed (0 is allowed, but never assumed —
 * the prototype silently saved a blank price as a free line).
 */
export function FreeLineForm({ jobId, initialName, busyKey, run, onDone, onCancel }: FreeLineFormProps) {
  const id = useId();
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState('');
  const [lineType, setLineType] = useState<LineType>('part');
  const [price, setPrice] = useState('');
  const [addToCatalog, setAddToCatalog] = useState(true);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<QuoteFailure | null>(null);
  const busy = busyKey !== null;

  const nameError = failure?.fields.name ?? (touched && name.trim() === '' ? 'จำเป็นต้องกรอก' : null);
  const categoryError = failure?.fields.category ?? (touched && addToCatalog && category.trim() === '' ? 'เพิ่มเข้าแคตตาล็อกต้องระบุหมวดหมู่' : null);
  const priceError = failure?.fields.unitPrice ?? (touched && typedSatang(price) === null ? 'ใส่ราคาเป็นตัวเลข 0 ขึ้นไป (0 = ไม่คิดเงิน)' : null);

  async function send(answer: SimilarAnswer) {
    setTouched(true);
    if (name.trim() === '' || typedSatang(price) === null || (addToCatalog && category.trim() === '' && !answer.useExistingItemId)) return;
    const body: AddLineInput = {
      kind: 'free',
      name: name.trim(),
      lineType,
      qty: '1',
      unitPrice: price.trim(),
      addToCatalog,
      confirmNotSimilar: answer.confirmNotSimilar ?? false,
      ...(addToCatalog && category.trim() !== '' ? { category: category.trim() } : {}),
      ...(answer.useExistingItemId ? { useExistingItemId: answer.useExistingItemId } : {}),
    };
    setFailure(null);
    const result = await run('add-free', () => api.post<Quotation>(`${quotationPath(jobId)}/lines`, body));
    if (result.ok) onDone();
    else if (!result.failure.cancelled) setFailure(result.failure);
  }

  const similar = failure?.body?.error === 'similar_item_found' ? failure.body.similar : null;
  const exists = failure?.body?.error === 'catalog_item_exists' ? failure.body.itemId : null;
  const dialogText = failure && !similar && !exists && Object.keys(failure.fields).length === 0 ? failure.text : null;

  return (
    <form className="qt-free" onSubmit={(e) => { e.preventDefault(); void send({}); }} noValidate>
      <h4>เพิ่มรายการใหม่</h4>
      {dialogText && <p className="ci-form-error" role="alert">{dialogText}</p>}

      {similar && (
        <div className="qt-similar" role="alertdialog" aria-labelledby={`${id}-sim`}>
          <p id={`${id}-sim`}><strong>{failure?.text}</strong></p>
          <div className="ci-dialog-list">
            {similar.map((s) => (
              <button key={s.id} type="button" className="btn secondary" disabled={busy} onClick={() => void send({ useExistingItemId: s.id })}>
                ใช้ของเดิม: {s.name} <span className="qt-line-sub">({s.category})</span>
              </button>
            ))}
            <button type="button" className="btn" disabled={busy} onClick={() => void send({ confirmNotSimilar: true })}>
              ไม่ใช่ — เพิ่ม “{name.trim()}” เป็นรายการใหม่จริง ๆ
            </button>
          </div>
        </div>
      )}
      {exists && (
        <div className="qt-similar" role="alertdialog">
          <p><strong>มีรายการชื่อนี้ในหมวดนี้อยู่แล้ว</strong></p>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => void send({ useExistingItemId: exists })}>
            ใช้รายการที่มีอยู่
          </button>
        </div>
      )}

      <label className={`field ci-field${nameError ? ' has-error' : ''}`}>
        <span className="ci-field-label">ชื่อสินค้า/บริการ</span>
        <input value={name} maxLength={200} disabled={busy} onChange={(e) => { setName(e.target.value); setFailure(null); }} />
        {nameError && <span className="ci-field-error">{nameError}</span>}
      </label>
      <label className={`field ci-field${categoryError ? ' has-error' : ''}`}>
        <span className="ci-field-label">หมวดหมู่{!addToCatalog && <span className="ci-required"> (ไม่บังคับ)</span>}</span>
        <input value={category} maxLength={80} disabled={busy} onChange={(e) => { setCategory(e.target.value); setFailure(null); }} />
        {categoryError && <span className="ci-field-error">{categoryError}</span>}
      </label>
      <div className="row-flex">
        <label className="field ci-field">
          <span className="ci-field-label">ชนิด</span>
          <select value={lineType} disabled={busy} onChange={(e) => setLineType(e.target.value as LineType)}>
            {(Object.keys(LINE_TYPE_LABEL) as LineType[]).map((t) => <option key={t} value={t}>{LINE_TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <label className={`field ci-field${priceError ? ' has-error' : ''}`}>
          <span className="ci-field-label">ราคาต่อหน่วย (บาท)</span>
          <input inputMode="decimal" value={price} disabled={busy} onChange={(e) => setPrice(e.target.value)} />
          {priceError && <span className="ci-field-error">{priceError}</span>}
        </label>
      </div>
      <label className="qt-check">
        <input type="checkbox" checked={addToCatalog} disabled={busy} onChange={(e) => setAddToCatalog(e.target.checked)} />
        เพิ่มเข้าแคตตาล็อก (ครั้งหน้าค้นเจอ)
      </label>
      <div className="row-flex">
        <button type="submit" className="btn" disabled={busy}>{busyKey === 'add-free' ? 'กำลังเพิ่ม...' : 'เพิ่ม'}</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>ยกเลิก</button>
      </div>
    </form>
  );
}
