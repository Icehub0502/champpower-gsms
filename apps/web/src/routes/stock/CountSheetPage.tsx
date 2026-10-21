import { useDeferredValue, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CountInput,
  type CountSheetPage as CountSheetPageT, type CountSheetRow, type Role, type SkuDetail, type StockChangeResult,
} from '@gsms/contracts/index.js';
import { Pager } from '../../components/ui/Pager';
import { QtyStepper, focusNextQty } from '../../components/ui/QtyStepper';
import { SkuPicker } from '../../components/ui/SkuPicker';
import { StockFigures } from '../../components/ui/StockFigures';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { thaiDateTime } from '../../lib/printFormat';
import { StockNav, StockNoAccess } from './StockNav';
import { contractFieldErrors, describeStockError } from './stockErrors';
import {
  DEFAULT_COUNT_REASON, STOCK_API, STOCK_CHANGED_EVENT, STOCK_PAGE_SIZE, canWriteStock, newRequestId, qty, skuPath, stockRoutes,
} from './stockLabels';

/** What the person has typed for one SKU, kept by SKU id so a refetch (any stock:changed) or a page turn never loses it. */
interface RowDraft {
  qty: string;
  reason: string;
  /** One per row attempt; resent on retry, replaced after the server says yes. */
  requestId: string;
  saving: boolean;
  error: string | null;
  fields: Record<string, string>;
  saved: StockChangeResult | null;
}

function freshDraft(): RowDraft {
  return { qty: '', reason: DEFAULT_COUNT_REASON, requestId: newRequestId(), saving: false, error: null, fields: {}, saved: null };
}

type CountRow = Pick<CountSheetRow, 'id' | 'code' | 'name' | 'category' | 'shelfLocation' | 'unit' | 'counted' | 'onHand' | 'reserved' | 'available' | 'legacyHadStock' | 'isActive'> & {
  lastCountedAt?: string | null;
};

export function CountSheetRoute({ role }: { role: Role | null }) {
  if (!canWriteStock(role)) return <StockNoAccess role={role} what="การตั้งยอด" />;
  return <CountSheetPage role={role} />;
}

/**
 * ตั้งยอดตั้งต้น (WO-006 §2): count what is on the shelf and type it in. Parts the old
 * system showed stock for come first (the server orders the sheet), so staff are not
 * scrolling past 200 parts that never existed. Each row saves on its own — Enter saves
 * and jumps to the next box on a keyboard — and "บันทึกทั้งหน้า" saves every row that
 * has a number, one request per row, each with its own requestId. 0 is a real answer.
 * A count can be done again at any time; every one is in the daily adjustments report.
 */
function CountSheetPage({ role }: { role: Role | null }) {
  const [search] = useSearchParams();
  const focusSkuId = search.get('sku');
  const [q, setQ] = useState('');
  const [onlyUncounted, setOnlyUncounted] = useState(false);
  const [offset, setOffset] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [picked, setPicked] = useState<CountRow | null>(null);
  const savingRef = useRef(new Set<string>());
  const [bulk, setBulk] = useState(false);
  const [sessionSaved, setSessionSaved] = useState(0);
  const qId = useId();

  const dq = useDeferredValue(q.trim());
  const params = new URLSearchParams({ limit: String(STOCK_PAGE_SIZE), offset: String(offset), onlyUncounted: String(onlyUncounted) });
  if (dq) params.set('q', dq);
  const sheet = useDocument<CountSheetPageT>(`${STOCK_API}/count-sheet?${params}`, STOCK_CHANGED_EVENT);

  const draftOf = (id: string) => drafts[id] ?? freshDraft();
  const patch = (id: string, p: Partial<RowDraft>) => setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? freshDraft()), ...p } }));

  async function saveRow(row: CountRow): Promise<boolean> {
    if (savingRef.current.has(row.id)) return false;
    const d = draftOf(row.id);
    if (d.qty.trim() === '') { patch(row.id, { fields: { qty: 'ใส่จำนวนที่นับได้ (0 ก็ได้)' } }); return false; }
    const parsed = CountInput.safeParse({ requestId: d.requestId, qty: d.qty.trim(), reason: d.reason.trim() });
    if (!parsed.success) { patch(row.id, { fields: contractFieldErrors(parsed.error.issues), error: null }); return false; }
    if (parsed.data.reason.length === 0) { patch(row.id, { fields: { reason: 'จำเป็นต้องกรอก' } }); return false; }
    savingRef.current.add(row.id);
    patch(row.id, { saving: true, error: null, fields: {} });
    try {
      const result = await api.post<StockChangeResult>(`${skuPath(row.id)}/count`, parsed.data);
      // The next count of this SKU is a new fact: a new requestId, an empty box.
      setDrafts((all) => ({ ...all, [row.id]: { ...freshDraft(), reason: d.reason, saved: result } }));
      if (!result.replayed) setSessionSaved((n) => n + 1);
      // The picked row is a snapshot from the search: show the server's figures after the count.
      setPicked((p) => (p && p.id === row.id ? result.sku : p));
      return true;
    } catch (err) {
      const f = describeStockError(err);
      if (f.cancelled) { patch(row.id, { saving: false }); return false; }
      // Same requestId kept: pressing again after a timeout is answered with replayed:true, never a second count.
      patch(row.id, { saving: false, error: f.text, fields: f.fields });
      return false;
    } finally {
      savingRef.current.delete(row.id);
    }
  }

  async function saveAll(rows: CountRow[]) {
    if (bulk) return;
    setBulk(true);
    try {
      for (const r of rows) {
        if (draftOf(r.id).qty.trim() !== '') await saveRow(r);
      }
    } finally {
      setBulk(false);
    }
  }

  const rows: CountRow[] = sheet.data?.items ?? [];
  const typedOnPage = rows.filter((r) => (drafts[r.id]?.qty ?? '').trim() !== '').length;

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>ตั้งยอด (นับของจริง)</h1>
          <p className="page-sub">กรอกจำนวนที่นับได้จริงบนชั้น · ของที่ระบบเดิมเคยมียอดขึ้นก่อน · Enter = บันทึกแล้วไปช่องถัดไป</p>
        </div>
        {sessionSaved > 0 && <div className="qt-header-side"><span className="pill pill-success">บันทึกแล้ว {sessionSaved} รายการในรอบนี้</span></div>}
      </header>
      <StockNav role={role} />

      <section className="card" aria-label="ตั้งยอดอะไหล่ตัวเดียว">
        <h3>ตั้งยอดตัวเดียว (ค้นหา / สแกน)</h3>
        <SkuPicker onPick={(s) => setPicked(s)} />
        {picked && (
          <ul className="st-rows">
            <CountRowView row={picked} draft={draftOf(picked.id)} onPatch={(p) => patch(picked.id, p)} onSave={() => void saveRow(picked)} autoFocus />
          </ul>
        )}
        {!picked && focusSkuId && (
          <FocusedSku skuId={focusSkuId}>
            {(row) => (
              <ul className="st-rows">
                <CountRowView row={row} draft={draftOf(row.id)} onPatch={(p) => patch(row.id, p)} onSave={() => void saveRow(row)} autoFocus />
              </ul>
            )}
          </FocusedSku>
        )}
      </section>

      <section className="card st-filters" aria-label="ตัวกรองใบตั้งยอด">
        <div className="st-filter-row">
          <label className="field ci-field" htmlFor={qId}>
            <span className="ci-field-label">กรองรายการ (ชื่อ / รหัส)</span>
            <input id={qId} type="search" value={q} autoComplete="off" onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
          </label>
        </div>
        <div className="dp-chips">
          <button type="button" className={`chip${!onlyUncounted ? ' active' : ''}`} aria-pressed={!onlyUncounted} onClick={() => { setOnlyUncounted(false); setOffset(0); }}>ทั้งหมด</button>
          <button type="button" className={`chip${onlyUncounted ? ' active' : ''}`} aria-pressed={onlyUncounted} onClick={() => { setOnlyUncounted(true); setOffset(0); }}>เฉพาะที่ยังไม่ตั้งยอด</button>
        </div>
      </section>

      {sheet.loading && !sheet.data && <div className="page-loading">กำลังโหลด...</div>}
      {sheet.error && !sheet.data && (
        <div className="empty-state" role="alert">
          โหลดใบตั้งยอดไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => sheet.reload?.()}>ลองใหม่</button></div>
        </div>
      )}
      {sheet.error && sheet.data && <p className="ci-nomatch" role="status">โหลดล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม — ตัวเลขที่กรอกไว้ยังอยู่</p>}

      {sheet.data && (
        <section className="card" aria-label="ใบตั้งยอด">
          <p className="qt-line-sub st-count-line">{sheet.data.total} รายการ{onlyUncounted ? ' ที่ยังไม่ตั้งยอด' : ''}</p>
          {rows.length === 0 && <p className="qt-line-sub">{onlyUncounted ? 'ตั้งยอดครบทุกรายการแล้ว' : 'ไม่มีรายการ'}</p>}
          <ul className="st-rows">
            {rows.map((r) => (
              <CountRowView
                key={r.id}
                row={r}
                draft={draftOf(r.id)}
                onPatch={(p) => patch(r.id, p)}
                onSave={() => { void saveRow(r).then((ok) => { if (ok) focusNextQty(r.id); }); }}
              />
            ))}
          </ul>
          <Pager offset={offset} limit={STOCK_PAGE_SIZE} total={sheet.data.total} onChange={setOffset} disabled={bulk} />
        </section>
      )}

      {typedOnPage > 0 && (
        <div className="st-issue-bar" role="region" aria-label="บันทึกทั้งหน้า">
          <span>กรอกไว้ {typedOnPage} รายการในหน้านี้ (ยังไม่บันทึก)</span>
          <button type="button" className="btn hazard" disabled={bulk} onClick={() => void saveAll(rows)}>
            {bulk ? 'กำลังบันทึก...' : `บันทึกทั้งหน้า (${typedOnPage})`}
          </button>
        </div>
      )}
    </div>
  );
}

/** The SKU named in ?sku= (from "ตั้งยอด" on the list, the stock card, or a sku_not_counted refusal). Live: refetched on stock:changed. */
function FocusedSku({ skuId, children }: { skuId: string; children: (row: CountRow) => ReactNode }) {
  const doc = useDocument<SkuDetail>(skuPath(skuId), STOCK_CHANGED_EVENT);
  if (doc.data) return <>{children(doc.data)}</>;
  if (doc.error) return <p className="ci-form-error" role="alert">ไม่พบอะไหล่ที่เลือก</p>;
  return <p className="qt-line-sub">กำลังโหลด...</p>;
}

function CountRowView({ row, draft, onPatch, onSave, autoFocus }: {
  row: CountRow; draft: RowDraft; onPatch: (p: Partial<RowDraft>) => void; onSave: () => void; autoFocus?: boolean;
}) {
  const reasonId = useId();
  const s = draft.saved;
  return (
    <li className={`st-row${s ? ' is-saved' : ''}`}>
      <div className="st-row-main">
        <Link className="st-name" to={stockRoutes.card(row.id)}>{row.name}</Link>
        <span className="qt-line-sub">
          <span className="mono">{row.code}</span>
          {row.category ? ` · ${row.category}` : ''}
          {row.shelfLocation ? ` · ชั้น ${row.shelfLocation}` : ''}
          {row.legacyHadStock ? ' · ระบบเดิมเคยมีของ' : ''}
        </span>
        <span className="qt-line-sub">
          {row.lastCountedAt ? `ตั้งยอดล่าสุด ${thaiDateTime(row.lastCountedAt)}` : row.counted ? '' : 'ยังไม่เคยตั้งยอด'}
        </span>
      </div>
      <div className="st-row-figs"><StockFigures sku={row} compact /></div>
      <div className="st-entry">
        <QtyStepper
          label={`นับได้ (${row.unit})`}
          value={draft.qty}
          disabled={draft.saving}
          error={draft.fields.qty}
          dataKey={row.id}
          autoFocus={autoFocus}
          onChange={(v) => onPatch({ qty: v, fields: { ...draft.fields, qty: '' }, error: null })}
          onEnter={onSave}
        />
        <label className={`st-reason${draft.fields.reason ? ' has-error' : ''}`} htmlFor={reasonId}>
          <span>เหตุผล</span>
          <input id={reasonId} value={draft.reason} maxLength={500} disabled={draft.saving} onChange={(e) => onPatch({ reason: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSave(); } }} />
          {draft.fields.reason && <span className="ci-field-error">{draft.fields.reason}</span>}
        </label>
        <button type="button" className="btn" disabled={draft.saving} onClick={onSave}>{draft.saving ? 'กำลังบันทึก...' : 'บันทึก'}</button>
      </div>
      {draft.error && <p className="ci-form-error st-row-msg" role="alert">{draft.error}</p>}
      {s && (
        <p className="qt-line-sub st-row-msg" role="status">
          {s.replayed ? 'รายการนี้บันทึกไปแล้วก่อนหน้า (ไม่บันทึกซ้ำ) — ' : 'บันทึกแล้ว — '}
          คงเหลือ {s.beforeOnHand === null ? 'ยังไม่ตั้งยอด' : qty(s.beforeOnHand)} → <strong className="mono">{qty(s.afterOnHand)}</strong>
          {s.belowReserved && <strong className="st-warn"> · นับได้น้อยกว่าที่จองให้งานไว้ พร้อมใช้ติดลบ — ตรวจงานที่จองของตัวนี้</strong>}
        </p>
      )}
    </li>
  );
}
