import { useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  CatalogCreateSkuInput, SkuCreateInput, SkuPatchInput,
  type CatalogLinkRow, type SkuRow, type StockingPolicy,
} from '@gsms/contracts/index.js';
import { Modal } from '../../components/ui/Modal';
import { api } from '../../lib/api/client';
import { contractFieldErrors, describeStockError } from './stockErrors';
import { SKUS_PATH, STOCKING_POLICY_LABEL, qty, skuPath, stockRoutes } from './stockLabels';

type Mode =
  | { kind: 'create' }
  | { kind: 'edit'; sku: SkuRow }
  /** A new SKU made from a catalog item and bound to it in the same request. */
  | { kind: 'fromCatalog'; item: CatalogLinkRow };

interface Draft {
  code: string;
  name: string;
  category: string;
  unit: string;
  stockingPolicy: StockingPolicy;
  reorderPoint: string;
  shelfLocation: string;
}

function draftOf(mode: Mode): Draft {
  if (mode.kind === 'edit') {
    const s = mode.sku;
    return {
      code: s.code, name: s.name, category: s.category ?? '', unit: s.unit, stockingPolicy: s.stockingPolicy,
      reorderPoint: s.reorderPoint === null ? '' : qty(s.reorderPoint), shelfLocation: s.shelfLocation ?? '',
    };
  }
  if (mode.kind === 'fromCatalog') {
    // name / category default from the item on the server; shown here so the person sees what they get.
    return { code: '', name: mode.item.name, category: mode.item.category, unit: '', stockingPolicy: 'stocked', reorderPoint: '', shelfLocation: '' };
  }
  // DEFAULT pending Ice: a new SKU is "stocked" unless the person says otherwise.
  return { code: '', name: '', category: '', unit: '', stockingPolicy: 'stocked', reorderPoint: '', shelfLocation: '' };
}

const opt = (v: string) => (v.trim() === '' ? undefined : v.trim());

interface SkuFormDialogProps {
  mode: Mode;
  onClose: () => void;
  onSaved: (result: SkuRow | CatalogLinkRow) => void;
}

/**
 * Create / edit one SKU. The code is typed once, at creation, and never again: it is on
 * the shelf label and inside the QR (contracts SkuPatchInput has no `code`). The form is
 * checked with the same contract schema the API parses with before anything is sent.
 */
export function SkuFormDialog({ mode, onClose, onSaved }: SkuFormDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(mode));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const formId = useId();
  const editing = mode.kind === 'edit';
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  function build(): { ok: true; send: () => Promise<SkuRow | CatalogLinkRow> } | { ok: false; fields: Record<string, string> } {
    if (mode.kind === 'edit') {
      const s = mode.sku;
      const before = draftOf(mode);
      const patch: Record<string, unknown> = {};
      if (draft.name.trim() !== before.name) patch.name = draft.name.trim();
      if (draft.category.trim() !== before.category) patch.category = opt(draft.category) ?? null;
      if (draft.unit.trim() !== before.unit && draft.unit.trim() !== '') patch.unit = draft.unit.trim();
      if (draft.stockingPolicy !== before.stockingPolicy) patch.stockingPolicy = draft.stockingPolicy;
      if (draft.reorderPoint.trim() !== before.reorderPoint) patch.reorderPoint = opt(draft.reorderPoint) ?? null;
      if (draft.shelfLocation.trim() !== before.shelfLocation) patch.shelfLocation = opt(draft.shelfLocation) ?? null;
      const parsed = SkuPatchInput.safeParse(patch);
      if (!parsed.success) {
        const f = contractFieldErrors(parsed.error.issues);
        // "Nothing changed" is not a field's fault.
        if (f._) { delete f._; if (Object.keys(f).length === 0) return { ok: true, send: async () => s }; }
        return { ok: false, fields: f };
      }
      return { ok: true, send: () => api.patch<SkuRow>(skuPath(s.id), parsed.data) };
    }
    const common = {
      code: draft.code.trim(),
      category: opt(draft.category), unit: opt(draft.unit), stockingPolicy: draft.stockingPolicy,
      reorderPoint: opt(draft.reorderPoint), shelfLocation: opt(draft.shelfLocation),
    };
    if (mode.kind === 'fromCatalog') {
      const parsed = CatalogCreateSkuInput.safeParse({ ...common, name: opt(draft.name) });
      if (!parsed.success) return { ok: false, fields: contractFieldErrors(parsed.error.issues) };
      return { ok: true, send: () => api.post<CatalogLinkRow>(`/api/stock/catalog-items/${encodeURIComponent(mode.item.id)}/sku/create`, parsed.data) };
    }
    const parsed = SkuCreateInput.safeParse({ ...common, name: draft.name.trim() });
    if (!parsed.success) return { ok: false, fields: contractFieldErrors(parsed.error.issues) };
    return { ok: true, send: () => api.post<SkuRow>(SKUS_PATH, parsed.data) };
  }

  async function submit() {
    if (busyRef.current) return;
    setFormError(null);
    setExistingId(null);
    const b = build();
    if ('fields' in b) { setErrors(b.fields); return; }
    setErrors({});
    busyRef.current = true;
    setBusy(true);
    try {
      onSaved(await b.send());
    } catch (err) {
      const f = describeStockError(err);
      if (f.cancelled) return;
      setFormError(f.text);
      setErrors(f.fields);
      if (f.body?.error === 'sku_code_exists') {
        setErrors((e) => ({ ...e, code: 'มีรหัสนี้อยู่แล้ว' }));
        setExistingId(f.body.skuId);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const title = mode.kind === 'edit' ? `แก้ไขอะไหล่ ${mode.sku.code}` : mode.kind === 'fromCatalog' ? 'สร้างอะไหล่ในสต๊อกจากรายการแคตตาล็อก' : 'เพิ่มอะไหล่ใหม่';

  return (
    <Modal
      title={title}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <div className="row-flex">
          <button type="submit" form={formId} className="btn" disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึก'}</button>
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>ยกเลิก</button>
        </div>
      )}
    >
      <form id={formId} className="st-form" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {mode.kind === 'fromCatalog' && (
          <p className="qt-line-sub">จาก “{mode.item.name}” ({mode.item.category}) — สร้างแล้วผูกให้ทันที ใบเสนอราคาที่ใช้รายการนี้จะจองและเบิกของตัวนี้</p>
        )}
        {formError && (
          <p className="ci-form-error" role="alert">
            {formError}
            {existingId && <> <Link to={stockRoutes.card(existingId)} onClick={onClose}>เปิดตัวที่มีอยู่</Link></>}
          </p>
        )}
        {editing ? (
          <div className="field ci-field">
            <span className="ci-field-label">รหัสอะไหล่ (อยู่บนป้าย QR — แก้ไม่ได้)</span>
            <span className="mono st-code-locked">{draft.code}</span>
          </div>
        ) : (
          <Field label="รหัสอะไหล่ (ค่าที่อยู่ใน QR · แก้ไม่ได้หลังบันทึก)" error={errors.code}>
            {(id) => <input id={id} className="mono" value={draft.code} disabled={busy} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => set('code')(e.target.value)} />}
          </Field>
        )}
        <Field label={mode.kind === 'fromCatalog' ? 'ชื่อ (เว้นว่าง = ใช้ชื่อในแคตตาล็อก)' : 'ชื่ออะไหล่'} error={errors.name}>
          {(id) => <input id={id} value={draft.name} disabled={busy} onChange={(e) => set('name')(e.target.value)} />}
        </Field>
        <div className="st-form-grid">
          <Field label="หมวด" error={errors.category} optional>
            {(id) => <input id={id} value={draft.category} disabled={busy} onChange={(e) => set('category')(e.target.value)} />}
          </Field>
          <Field label="หน่วย" error={errors.unit} optional>
            {(id) => <input id={id} value={draft.unit} disabled={busy} placeholder="ชิ้น" onChange={(e) => set('unit')(e.target.value)} />}
          </Field>
          <Field label="ที่วางของ (ชั้น / แร็ค)" error={errors.shelfLocation} optional>
            {(id) => <input id={id} value={draft.shelfLocation} disabled={busy} onChange={(e) => set('shelfLocation')(e.target.value)} />}
          </Field>
          <Field label="จุดสั่งซื้อ (เตือนเมื่อพร้อมใช้ไม่เกินนี้)" error={errors.reorderPoint} optional>
            {(id) => <input id={id} className="mono" inputMode="decimal" value={draft.reorderPoint} disabled={busy || draft.stockingPolicy === 'buy_to_order'} onChange={(e) => set('reorderPoint')(e.target.value)} />}
          </Field>
        </div>
        <fieldset className="dp-group">
          <legend className="ci-field-label">วิธีเก็บของ</legend>
          <div className="dp-chips">
            {(['stocked', 'buy_to_order'] as const).map((p) => (
              <button key={p} type="button" className={`chip${draft.stockingPolicy === p ? ' active' : ''}`} aria-pressed={draft.stockingPolicy === p} disabled={busy} onClick={() => setDraft((d) => ({ ...d, stockingPolicy: p }))}>
                {draft.stockingPolicy === p && '✓ '}{STOCKING_POLICY_LABEL[p]}
              </button>
            ))}
          </div>
          <span className="qt-line-sub">“ซื้อเฉพาะงาน” ไม่เตือนของใกล้หมด และไม่เตือนของไม่พอตอนอนุมัติ แต่ยังมีประวัติครบ</span>
        </fieldset>
      </form>
    </Modal>
  );
}

function Field({ label, error, optional, children }: { label: string; error?: string; optional?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <label className={`field ci-field${error ? ' has-error' : ''}`} htmlFor={id}>
      <span className="ci-field-label">{label}{optional && <span className="ci-required"> (ไม่บังคับ)</span>}</span>
      {children(id)}
      {error && <span className="ci-field-error">{error}</span>}
    </label>
  );
}
