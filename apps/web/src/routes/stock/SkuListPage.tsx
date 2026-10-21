import { useDeferredValue, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Role, SkuPage, SkuPatchInput, SkuRow } from '@gsms/contracts/index.js';
import { Modal } from '../../components/ui/Modal';
import { Pager } from '../../components/ui/Pager';
import { StockCost, StockFigures, StockStatusBadge } from '../../components/ui/StockFigures';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { SkuFormDialog } from './SkuFormDialog';
import { StockNav } from './StockNav';
import { describeStockError } from './stockErrors';
import {
  SKUS_PATH, STOCKING_POLICY_LABEL, STOCK_CHANGED_EVENT, STOCK_PAGE_SIZE, canWriteStock, qty, skuPath, stockRoutes,
} from './stockLabels';

type StatusFilter = 'all' | 'not_counted' | 'counted' | 'out' | 'low';
type ActiveFilter = 'active' | 'inactive' | 'all';

const STATUS_CHIPS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'not_counted', label: 'ยังไม่ตั้งยอด' },
  { key: 'counted', label: 'ตั้งยอดแล้ว' },
  { key: 'low', label: 'ใกล้หมด' },
  { key: 'out', label: 'หมด' },
];

/**
 * รายการอะไหล่: search, category, status, paging. คงเหลือ / จอง / พร้อมใช้ per row, or one
 * "ยังไม่ตั้งยอด" when nobody has counted it yet. Cost appears only for a role the server
 * sent it to, and only when it is known (Release 1: never).
 *
 * Filters live in this component, never in a width-dependent subtree, so rotating a tablet
 * keeps the search text and the page.
 */
export function SkuListPage({ role }: { role: Role | null }) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [active, setActive] = useState<ActiveFilter>('active');
  const [offset, setOffset] = useState(0);
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; sku: SkuRow } | null>(null);
  const [toggle, setToggle] = useState<SkuRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const write = canWriteStock(role);
  const qId = useId();
  const catId = useId();
  const catListId = useId();

  // Typing must stay instant; the request follows the deferred text.
  const dq = useDeferredValue(q.trim());
  const dcat = useDeferredValue(category.trim());
  const params = new URLSearchParams({ limit: String(STOCK_PAGE_SIZE), offset: String(offset), status, active });
  if (dq) params.set('q', dq);
  if (dcat) params.set('category', dcat);
  const list = useDocument<SkuPage>(`${SKUS_PATH}?${params}`, STOCK_CHANGED_EVENT);
  const data = list.data;
  // Categories seen so far, offered as suggestions (there is no category list endpoint).
  const seen = useRef(new Set<string>());
  data?.items.forEach((s) => { if (s.category) seen.current.add(s.category); });

  const filterChange = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setOffset(0); };

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>รายการอะไหล่</h1>
          <p className="page-sub">พร้อมใช้ = คงเหลือ − ที่จองให้งานไว้ · “ยังไม่ตั้งยอด” ไม่ใช่ “หมด”</p>
        </div>
        <div className="qt-header-side">
          {write && <button type="button" className="btn hazard" onClick={() => setDialog({ kind: 'create' })}>+ เพิ่มอะไหล่</button>}
        </div>
      </header>
      <StockNav role={role} />

      <section className="card st-filters" aria-label="ตัวกรอง">
        <div className="st-filter-row">
          <label className="field ci-field" htmlFor={qId}>
            <span className="ci-field-label">ค้นหา (ชื่อ / รหัส)</span>
            <input id={qId} type="search" value={q} autoComplete="off" onChange={(e) => filterChange(setQ)(e.target.value)} />
          </label>
          <label className="field ci-field" htmlFor={catId}>
            <span className="ci-field-label">หมวด</span>
            <input id={catId} list={catListId} value={category} autoComplete="off" onChange={(e) => filterChange(setCategory)(e.target.value)} />
            <datalist id={catListId}>{[...seen.current].sort().map((c) => <option key={c} value={c} />)}</datalist>
          </label>
        </div>
        <div className="dp-chips" role="group" aria-label="สถานะสต๊อก">
          {STATUS_CHIPS.map((c) => (
            <button key={c.key} type="button" className={`chip${status === c.key ? ' active' : ''}`} aria-pressed={status === c.key} onClick={() => filterChange(setStatus)(c.key)}>
              {c.label}
            </button>
          ))}
          <span className="st-chip-gap" aria-hidden="true" />
          {(['active', 'inactive', 'all'] as const).map((a) => (
            <button key={a} type="button" className={`chip${active === a ? ' active' : ''}`} aria-pressed={active === a} onClick={() => filterChange(setActive)(a)}>
              {a === 'active' ? 'ใช้งานอยู่' : a === 'inactive' ? 'ปิดใช้งาน' : 'ทุกสถานะ'}
            </button>
          ))}
        </div>
      </section>

      {notice && <p className="ci-match" role="status">{notice}</p>}
      {list.loading && !data && <div className="page-loading">กำลังโหลด...</div>}
      {list.error && !data && (
        <div className="empty-state" role="alert">
          โหลดรายการอะไหล่ไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => list.reload?.()}>ลองใหม่</button></div>
        </div>
      )}
      {list.error && data && <p className="ci-nomatch" role="status">โหลดล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม</p>}

      {data && (
        <section className="card" aria-label="รายการอะไหล่">
          <p className="qt-line-sub st-count-line">{data.total} รายการ</p>
          {data.items.length === 0 && <p className="qt-line-sub">ไม่มีรายการ</p>}
          <ul className="st-rows">
            {data.items.map((s) => (
              <li key={s.id} className={`st-row${s.isActive ? '' : ' is-off'}`}>
                <div className="st-row-main">
                  <Link className="st-name" to={stockRoutes.card(s.id)}>{s.name}</Link>
                  <span className="qt-line-sub">
                    <span className="mono">{s.code}</span>
                    {s.category ? ` · ${s.category}` : ''}
                    {s.shelfLocation ? ` · ชั้น ${s.shelfLocation}` : ''}
                    {s.stockingPolicy === 'buy_to_order' ? ` · ${STOCKING_POLICY_LABEL.buy_to_order}` : ''}
                    {s.reorderPoint !== null && s.stockingPolicy === 'stocked' ? ` · จุดสั่งซื้อ ${qty(s.reorderPoint)}` : ''}
                  </span>
                  <StockCost sku={s} />
                </div>
                <div className="st-row-figs">
                  <StockFigures sku={s} />
                  <span className="st-row-badges">
                    {s.counted && <StockStatusBadge status={s.status} />}
                    {!s.isActive && <span className="pill pill-muted">ปิดใช้งาน</span>}
                  </span>
                </div>
                <div className="st-row-actions">
                  <Link className="btn secondary small" to={stockRoutes.card(s.id)}>ประวัติ</Link>
                  {write && <Link className="btn secondary small" to={stockRoutes.countOne(s.id)}>ตั้งยอด</Link>}
                  {write && <button type="button" className="btn secondary small" onClick={() => setDialog({ kind: 'edit', sku: s })}>แก้ไข</button>}
                  {write && (
                    <button type="button" className={`btn small ${s.isActive ? 'danger' : 'secondary'}`} onClick={() => setToggle(s)}>
                      {s.isActive ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Pager offset={offset} limit={STOCK_PAGE_SIZE} total={data.total} onChange={setOffset} />
        </section>
      )}

      {dialog && (
        <SkuFormDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaved={(r) => {
            setDialog(null);
            setNotice(`บันทึก “${r.name}” แล้ว`);
            list.reload?.();
          }}
        />
      )}
      {toggle && <ActiveToggleDialog sku={toggle} onClose={() => setToggle(null)} onDone={(s) => { setToggle(null); setNotice(`${s.isActive ? 'เปิด' : 'ปิด'}ใช้งาน “${s.name}” แล้ว`); list.reload?.(); }} />}
    </div>
  );
}

/** ปิด / เปิดใช้งาน. Refused while the SKU still has stock reserved for a job: that refusal is spelled out. */
function ActiveToggleDialog({ sku, onClose, onDone }: { sku: SkuRow; onClose: () => void; onDone: (s: SkuRow) => void }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<{ text: string; reserved: boolean } | null>(null);
  const turningOff = sku.isActive;

  async function go() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const body: SkuPatchInput = { isActive: !sku.isActive };
      onDone(await api.patch<SkuRow>(skuPath(sku.id), body));
    } catch (err) {
      const f = describeStockError(err);
      if (!f.cancelled) setError({ text: f.text, reserved: f.body?.error === 'sku_has_reservations' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      title={turningOff ? 'ปิดใช้งานอะไหล่' : 'เปิดใช้งานอะไหล่'}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <div className="row-flex">
          {!error?.reserved && (
            <button type="button" className={`btn${turningOff ? ' danger' : ''}`} disabled={busy} onClick={() => void go()}>
              {busy ? 'กำลังบันทึก...' : turningOff ? 'ยืนยันปิดใช้งาน' : 'ยืนยันเปิดใช้งาน'}
            </button>
          )}
          <button type="button" className="btn secondary" disabled={busy} onClick={onClose}>{error?.reserved ? 'ปิด' : 'ยกเลิก'}</button>
        </div>
      )}
    >
      <p><strong>{sku.name}</strong> <span className="mono">({sku.code})</span></p>
      {turningOff
        ? <p className="qt-line-sub">ปิดแล้วจะไม่ขึ้นในการค้นหาสำหรับเบิก/ผูกแคตตาล็อก แต่ประวัติทั้งหมดยังอยู่ เปิดกลับได้ภายหลัง</p>
        : <p className="qt-line-sub">เปิดแล้วจะกลับมาค้นหาและใช้งานได้ตามปกติ</p>}
      {error && (
        <div className="ci-form-error st-block-error" role="alert">
          <span>{error.text}</span>
          {error.reserved && sku.reserved !== null && <span>จองอยู่ตอนนี้ {qty(sku.reserved)} {sku.unit} — ดูว่าจองให้งานไหนได้ที่ <Link to={stockRoutes.card(sku.id)} onClick={onClose}>ประวัติของตัวนี้</Link></span>}
        </div>
      )}
    </Modal>
  );
}
