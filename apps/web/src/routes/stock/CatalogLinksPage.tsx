import { useDeferredValue, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CatalogBindInput, type CatalogLinkPage, type CatalogLinkRow, type Role, type SkuRow } from '@gsms/contracts/index.js';
import { Modal } from '../../components/ui/Modal';
import { Pager } from '../../components/ui/Pager';
import { SkuPicker } from '../../components/ui/SkuPicker';
import { StockFigures } from '../../components/ui/StockFigures';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { SkuFormDialog } from './SkuFormDialog';
import { StockNav, StockNoAccess } from './StockNav';
import { describeStockError } from './stockErrors';
import { STOCK_API, STOCK_CHANGED_EVENT, STOCK_PAGE_SIZE, canWriteStock, stockRoutes } from './stockLabels';

type Bound = 'unbound' | 'bound' | 'all';

export function CatalogLinksRoute({ role }: { role: Role | null }) {
  if (!canWriteStock(role)) return <StockNoAccess role={role} what="การผูกแคตตาล็อกกับสต๊อก" />;
  return <CatalogLinksPage role={role} />;
}

function itemPath(id: string): string {
  return `${STOCK_API}/catalog-items/${encodeURIComponent(id)}/sku`;
}

/**
 * ผูกแคตตาล็อกกับสต๊อก (WO-006 §1): the quotation knows a part by its catalog name, the
 * store room by its SKU code. Until the two are bound, selling the part reserves and
 * issues nothing. Bind to an existing SKU (search / scan), unbind, or make a new SKU from
 * the item in one step. Starts on "ยังไม่ผูก" — that is the work list.
 */
function CatalogLinksPage({ role }: { role: Role | null }) {
  const [q, setQ] = useState('');
  const [bound, setBound] = useState<Bound>('unbound');
  const [offset, setOffset] = useState(0);
  const [binding, setBinding] = useState<CatalogLinkRow | null>(null);
  const [creating, setCreating] = useState<CatalogLinkRow | null>(null);
  const [unbinding, setUnbinding] = useState<CatalogLinkRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const qId = useId();
  const dq = useDeferredValue(q.trim());
  const params = new URLSearchParams({ limit: String(STOCK_PAGE_SIZE), offset: String(offset), bound });
  if (dq) params.set('q', dq);
  const list = useDocument<CatalogLinkPage>(`${STOCK_API}/catalog-links?${params}`, STOCK_CHANGED_EVENT);
  const data = list.data;

  function done(text: string) {
    setNotice(text);
    list.reload?.();
  }

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>ผูกแคตตาล็อกกับสต๊อก</h1>
          <p className="page-sub">รายการอะไหล่ที่ขายในใบเสนอราคา ↔ อะไหล่ในสต๊อก · ยังไม่ผูก = ขายได้ แต่ไม่จองและไม่ตัดสต๊อก</p>
        </div>
      </header>
      <StockNav role={role} />

      <section className="card st-filters" aria-label="ตัวกรอง">
        <label className="field ci-field" htmlFor={qId}>
          <span className="ci-field-label">ค้นหารายการในแคตตาล็อก</span>
          <input id={qId} type="search" value={q} autoComplete="off" onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        </label>
        <div className="dp-chips">
          {([['unbound', 'ยังไม่ผูก'], ['bound', 'ผูกแล้ว'], ['all', 'ทั้งหมด']] as const).map(([k, label]) => (
            <button key={k} type="button" className={`chip${bound === k ? ' active' : ''}`} aria-pressed={bound === k} onClick={() => { setBound(k); setOffset(0); }}>{label}</button>
          ))}
        </div>
      </section>

      {notice && <p className="ci-match" role="status">{notice}</p>}
      {list.loading && !data && <div className="page-loading">กำลังโหลด...</div>}
      {list.error && !data && (
        <div className="empty-state" role="alert">
          โหลดรายการแคตตาล็อกไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => list.reload?.()}>ลองใหม่</button></div>
        </div>
      )}

      {data && (
        <section className="card" aria-label="รายการแคตตาล็อก">
          <p className="qt-line-sub st-count-line">{data.total} รายการ</p>
          {data.items.length === 0 && <p className="qt-line-sub">{bound === 'unbound' ? 'ผูกครบทุกรายการแล้ว' : 'ไม่มีรายการ'}</p>}
          <ul className="st-rows">
            {data.items.map((c) => (
              <li key={c.id} className="st-row">
                <div className="st-row-main">
                  <span className="st-name">{c.name}{c.isSet && <span className="pill pill-muted"> ชุด</span>}</span>
                  <span className="qt-line-sub">{c.category}</span>
                  {c.skuId
                    ? <span className="qt-line-sub">ผูกกับ <Link to={stockRoutes.card(c.skuId)}><span className="mono">{c.skuCode}</span> {c.skuName}</Link></span>
                    : <span className="qt-line-sub">{c.isSet ? 'ชุด — ของจริงคือรายการย่อยในชุด ผูกที่รายการย่อยแต่ละตัว' : 'ยังไม่ผูก'}</span>}
                </div>
                {/* DEFAULT pending Ice: a set's parent row is a price, not a shelf item (WO-006 §3), so it is not offered for binding. */}
                {!c.isSet && (
                  <div className="st-row-actions">
                    {c.skuId ? (
                      // The API refuses binding an already-bound item (catalog_item_bound): changing is unbind, then bind.
                      <button type="button" className="btn danger small" onClick={() => setUnbinding(c)}>ถอดออก</button>
                    ) : (
                      <>
                        <button type="button" className="btn small" onClick={() => setBinding(c)}>ผูกกับอะไหล่ที่มี</button>
                        <button type="button" className="btn secondary small" onClick={() => setCreating(c)}>สร้างอะไหล่ใหม่จากรายการนี้</button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Pager offset={offset} limit={STOCK_PAGE_SIZE} total={data.total} onChange={setOffset} />
        </section>
      )}

      {binding && <BindDialog item={binding} onClose={() => setBinding(null)} onDone={(r) => { setBinding(null); done(`ผูก “${r.name}” กับ ${r.skuCode ?? ''} แล้ว`); }} />}
      {unbinding && <UnbindDialog item={unbinding} onClose={() => setUnbinding(null)} onDone={(r) => { setUnbinding(null); done(`ถอด “${r.name}” ออกจากสต๊อกแล้ว`); }} />}
      {creating && (
        <SkuFormDialog
          mode={{ kind: 'fromCatalog', item: creating }}
          onClose={() => setCreating(null)}
          onSaved={(r) => { setCreating(null); done(`สร้างอะไหล่และผูกกับ “${r.name}” แล้ว`); }}
        />
      )}
    </div>
  );
}

function useOneShot() {
  const [busy, setBusy] = useState(false);
  const ref = useRef(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(call: () => Promise<T>, ok: (v: T) => void) {
    if (ref.current) return;
    ref.current = true;
    setBusy(true);
    setError(null);
    try {
      ok(await call());
    } catch (err) {
      const f = describeStockError(err);
      if (!f.cancelled) setError(f.text);
    } finally {
      ref.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function BindDialog({ item, onClose, onDone }: { item: CatalogLinkRow; onClose: () => void; onDone: (r: CatalogLinkRow) => void }) {
  const [sku, setSku] = useState<SkuRow | null>(null);
  const a = useOneShot();
  return (
    <Modal
      title={`ผูก “${item.name}” กับอะไหล่ในสต๊อก`}
      onClose={() => { if (!a.busy) onClose(); }}
      footer={(
        <div className="row-flex">
          <button type="button" className="btn" disabled={a.busy || !sku}
            onClick={() => { if (sku) void a.run(() => api.put<CatalogLinkRow>(itemPath(item.id), CatalogBindInput.parse({ skuId: sku.id })), onDone); }}>
            {a.busy ? 'กำลังบันทึก...' : 'ผูก'}
          </button>
          <button type="button" className="btn secondary" disabled={a.busy} onClick={onClose}>ยกเลิก</button>
        </div>
      )}
    >
      <SkuPicker onPick={setSku} autoFocus />
      {sku && (
        <div className="st-row">
          <div className="st-row-main">
            <span className="st-name">{sku.name}</span>
            <span className="qt-line-sub mono">{sku.code}</span>
          </div>
          <StockFigures sku={sku} compact />
        </div>
      )}
      {a.error && <p className="ci-form-error" role="alert">{a.error}</p>}
    </Modal>
  );
}

function UnbindDialog({ item, onClose, onDone }: { item: CatalogLinkRow; onClose: () => void; onDone: (r: CatalogLinkRow) => void }) {
  const a = useOneShot();
  return (
    <Modal
      title="ถอดการผูกสต๊อก"
      onClose={() => { if (!a.busy) onClose(); }}
      footer={(
        <div className="row-flex">
          <button type="button" className="btn danger" disabled={a.busy} onClick={() => void a.run(() => api.del<CatalogLinkRow>(itemPath(item.id)), onDone)}>
            {a.busy ? 'กำลังบันทึก...' : 'ยืนยันถอดออก'}
          </button>
          <button type="button" className="btn secondary" disabled={a.busy} onClick={onClose}>ยกเลิก</button>
        </div>
      )}
    >
      <p>“{item.name}” จะไม่ผูกกับ <span className="mono">{item.skuCode}</span> {item.skuName} อีก</p>
      <p className="qt-line-sub">หลังถอด การขายรายการนี้จะไม่จองและไม่ตัดสต๊อก และจะขึ้นในรายงาน “บรรทัดที่ยังไม่ผูกสต๊อก”</p>
      {a.error && <p className="ci-form-error" role="alert">{a.error}</p>}
    </Modal>
  );
}
