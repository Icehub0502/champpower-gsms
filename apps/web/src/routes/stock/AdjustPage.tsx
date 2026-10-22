import { useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AdjustInput, type Role, type SkuDetail, type SkuRow, type StockChangeResult } from '@gsms/contracts/index.js';
import { QtyStepper } from '../../components/ui/QtyStepper';
import { SkuPicker } from '../../components/ui/SkuPicker';
import { StockFigures, StockStatusBadge } from '../../components/ui/StockFigures';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { StockNav, StockNoAccess } from './StockNav';
import { contractFieldErrors } from './stockErrors';
import { STOCK_CHANGED_EVENT, canWriteStock, isNegative, qty, skuPath, stockRoutes } from './stockLabels';
import { useStockMutation } from './useStockMutation';

export function AdjustRoute({ role }: { role: Role | null }) {
  if (!canWriteStock(role)) return <StockNoAccess role={role} what="การปรับยอด" />;
  return <AdjustPage role={role} />;
}

/**
 * ปรับยอด (WO-006 §5): find the part (search or scan), type the quantity that is REALLY on
 * the shelf, and say why in your own words. The reason is free text and required
 * (CLAUDE.md s12.1: the person who pulls parts can also correct the count, so every
 * correction must explain itself, and every one lands in the owner's daily report).
 * Only a counted part can be adjusted — a never-counted one is sent to ตั้งยอด.
 */
function AdjustPage({ role }: { role: Role | null }) {
  const [search, setSearch] = useSearchParams();
  const skuParam = search.get('sku');
  const [picked, setPicked] = useState<SkuRow | null>(null);
  const [result, setResult] = useState<StockChangeResult | null>(null);

  function pick(s: SkuRow) {
    setPicked(s);
    setResult(null);
    if (skuParam) setSearch({}, { replace: true });
  }

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>ปรับยอดสต๊อก</h1>
          <p className="page-sub">ยอดในระบบไม่ตรงของจริง · ใส่จำนวนที่มีจริงบนชั้น แล้วเขียนเหตุผล — ทุกรายการขึ้นรายงานให้เจ้าของเห็นทุกวัน</p>
        </div>
      </header>
      <StockNav role={role} />

      <section className="card" aria-label="เลือกอะไหล่">
        <SkuPicker onPick={pick} autoFocus={!skuParam} />
      </section>

      {result && <AdjustResult result={result} onAgain={() => setResult(null)} />}

      {!result && picked && <AdjustForm key={picked.id} sku={picked} onDone={(r) => { setResult(r); setPicked(r.sku); }} />}
      {!result && !picked && skuParam && (
        <LoadSku skuId={skuParam}>{(s) => <AdjustForm key={s.id} sku={s} onDone={(r) => { setResult(r); setPicked(r.sku); }} />}</LoadSku>
      )}
    </div>
  );
}

function LoadSku({ skuId, children }: { skuId: string; children: (s: SkuRow) => ReactNode }) {
  const doc = useDocument<SkuDetail>(skuPath(skuId), STOCK_CHANGED_EVENT);
  if (doc.data) return <>{children(doc.data)}</>;
  if (doc.error) return <p className="ci-form-error" role="alert">ไม่พบอะไหล่ที่เลือก</p>;
  return <p className="qt-line-sub">กำลังโหลด...</p>;
}

/** Keyed by SKU: a new SKU is a new form AND a new requestId (useStockMutation starts fresh on mount). */
function AdjustForm({ sku, onDone }: { sku: SkuRow; onDone: (r: StockChangeResult) => void }) {
  const m = useStockMutation();
  const [newQty, setNewQty] = useState(sku.onHand === null ? '' : qty(sku.onHand));
  const [reason, setReason] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const reasonId = useId();

  if (!sku.counted) {
    return (
      <section className="card" aria-label="อะไหล่ที่เลือก">
        <SkuHead sku={sku} />
        <p className="ci-form-error" role="alert">อะไหล่นี้ยังไม่ตั้งยอด จึงยังปรับยอดไม่ได้ (ไม่มียอดเดิมให้ปรับ) — ตั้งยอดจากการนับจริงก่อน</p>
        <Link className="btn hazard" to={stockRoutes.countOne(sku.id)}>ไปตั้งยอดตัวนี้</Link>
      </section>
    );
  }

  async function submit() {
    const parsed = AdjustInput.safeParse({ requestId: m.requestId(), newQty: newQty.trim(), reason: reason.trim() });
    if (!parsed.success) { setFields(contractFieldErrors(parsed.error.issues)); return; }
    if (parsed.data.reason === '') { setFields({ reason: 'จำเป็นต้องกรอก — เขียนว่าทำไมยอดไม่ตรง' }); return; }
    setFields({});
    const r = await m.run((requestId) => api.post<StockChangeResult>(`${skuPath(sku.id)}/adjust`, { ...parsed.data, requestId }));
    if (!r) return;
    if (r.ok === true) { onDone(r.value); return; }
    if (r.ok === false) setFields(r.failure.fields);
  }

  const notCountedRefusal = m.failure?.body?.error === 'sku_not_counted';

  return (
    <section className="card" aria-label="ปรับยอด">
      <SkuHead sku={sku} />
      <form className="st-entry" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <QtyStepper label={`ยอดที่มีจริง (${sku.unit})`} value={newQty} disabled={m.busy} error={fields.newQty} onChange={(v) => { setNewQty(v); m.clearFailure(); }} />
        <label className={`st-reason${fields.reason ? ' has-error' : ''}`} htmlFor={reasonId}>
          <span>เหตุผล (จำเป็น — เขียนเอง)</span>
          <textarea id={reasonId} rows={2} maxLength={500} value={reason} disabled={m.busy} placeholder="เช่น นับใหม่แล้วเจอเพิ่ม 2 ตัวที่ชั้นล่าง / ของเสียจากการติดตั้ง"
            onChange={(e) => { setReason(e.target.value); m.clearFailure(); }} />
          {fields.reason && <span className="ci-field-error">{fields.reason}</span>}
        </label>
        <button type="submit" className="btn hazard" disabled={m.busy}>{m.busy ? 'กำลังบันทึก...' : 'บันทึกการปรับยอด'}</button>
      </form>
      {m.failure && (
        <p className="ci-form-error" role="alert">
          {m.failure.text}
          {notCountedRefusal && <> <Link to={stockRoutes.countOne(sku.id)}>ไปตั้งยอด</Link></>}
        </p>
      )}
    </section>
  );
}

function SkuHead({ sku }: { sku: SkuRow }) {
  return (
    <div className="st-row">
      <div className="st-row-main">
        <Link className="st-name" to={stockRoutes.card(sku.id)}>{sku.name}</Link>
        <span className="qt-line-sub"><span className="mono">{sku.code}</span>{sku.shelfLocation ? ` · ชั้น ${sku.shelfLocation}` : ''}</span>
      </div>
      <div className="st-row-figs">
        <StockFigures sku={sku} />
        {sku.counted && <StockStatusBadge status={sku.status} />}
      </div>
    </div>
  );
}

/** The server's answer, not the screen's guess: before → after as the ledger recorded it. */
function AdjustResult({ result: r, onAgain }: { result: StockChangeResult; onAgain: () => void }) {
  const neg = isNegative(r.deltaQty);
  return (
    <section className={`card st-result${r.replayed ? ' is-replay' : ''}`} role="status" aria-label="ผลการปรับยอด">
      <h3>{r.replayed ? 'รายการนี้บันทึกไปแล้วก่อนหน้า (ไม่บันทึกซ้ำ)' : 'ปรับยอดแล้ว'}</h3>
      <p><strong>{r.sku.name}</strong> <span className="mono">({r.sku.code})</span></p>
      <p className="st-result-figs">
        คงเหลือ <span className="mono">{r.beforeOnHand === null ? '-' : qty(r.beforeOnHand)}</span> → <strong className="mono">{qty(r.afterOnHand)}</strong>
        <span className={`mono ${neg ? 'st-neg' : 'st-pos'}`}>({neg ? '' : '+'}{qty(r.deltaQty)})</span>
      </p>
      <StockFigures sku={r.sku} />
      {r.belowReserved && <p className="ci-form-error" role="alert">ยอดใหม่น้อยกว่าที่จองให้งานไว้ — พร้อมใช้ติดลบ ตรวจงานที่จองของตัวนี้ในประวัติ</p>}
      <div className="row-flex">
        <Link className="btn secondary" to={stockRoutes.card(r.sku.id)}>ดูประวัติตัวนี้</Link>
        <button type="button" className="btn" onClick={onAgain}>ปรับตัวนี้อีกครั้ง</button>
      </div>
    </section>
  );
}
