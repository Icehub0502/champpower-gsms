import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MoveRef, MoveRow, Role, SkuDetail, StockCard, StockMoveType } from '@gsms/contracts/index.js';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { Icon } from '../../components/ui/Icon';
import { Pager } from '../../components/ui/Pager';
import { StockCost, StockFigures, StockStatusBadge } from '../../components/ui/StockFigures';
import { useDocument } from '../../hooks/useDocument';
import { baht } from '../../lib/money';
import { thaiDateTime } from '../../lib/printFormat';
import { billHref, canReadBill } from '../bill/billLabels';
import { canReadQuote } from '../quote/quoteLabels';
import { StockNav } from './StockNav';
import {
  DOC_TYPE_LABEL, MOVE_TYPE_LABEL, STOCKING_POLICY_LABEL, STOCK_CHANGED_EVENT, STOCK_PAGE_SIZE,
  canIssueStock, canWriteStock, hasCost, isNegative, qty, skuPath, stockRoutes,
} from './stockLabels';

const TYPE_FILTERS: Array<{ key: StockMoveType | 'all'; label: string }> = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'issue', label: MOVE_TYPE_LABEL.issue },
  { key: 'reserve', label: MOVE_TYPE_LABEL.reserve },
  { key: 'unreserve', label: MOVE_TYPE_LABEL.unreserve },
  { key: 'count', label: MOVE_TYPE_LABEL.count },
  { key: 'adjustment', label: MOVE_TYPE_LABEL.adjustment },
];

/** The route element: /stock/skus/:skuId. */
export function StockCardRoute({ role }: { role: Role | null }) {
  const { skuId } = useParams<{ skuId: string }>();
  if (!skuId) return null;
  return (
    <ErrorBoundary key={skuId}>
      <StockCardPage skuId={skuId} role={role} />
    </ErrorBoundary>
  );
}

/**
 * การ์ดสต๊อกรายตัว: the balance, then every move in the ledger, newest first — what, how
 * many, คงเหลือหลังรายการ, why, who, when, and which job / document it came from. The
 * ledger is append-only, so this list is the whole story of the part.
 */
function StockCardPage({ skuId, role }: { skuId: string; role: Role | null }) {
  const [offset, setOffset] = useState(0);
  const [type, setType] = useState<StockMoveType | 'all'>('all');
  const params = new URLSearchParams({ limit: String(STOCK_PAGE_SIZE), offset: String(offset) });
  if (type !== 'all') params.set('type', type);
  const card = useDocument<StockCard>(`${skuPath(skuId)}/card?${params}`, STOCK_CHANGED_EVENT);
  const detail = useDocument<SkuDetail>(skuPath(skuId), STOCK_CHANGED_EVENT);
  const sku = card.data?.sku;
  const moves = card.data?.moves;
  const write = canWriteStock(role);

  return (
    <div className="qt-page st-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <Link className="back-link" to={stockRoutes.skus}><Icon name="back" size={15} /> รายการอะไหล่</Link>
          <h1>{sku ? sku.name : 'การ์ดสต๊อก'}</h1>
          {sku && (
            <p className="page-sub">
              <span className="mono">{sku.code}</span>
              {sku.category ? ` · ${sku.category}` : ''} · หน่วย {sku.unit}
              {sku.shelfLocation ? ` · ชั้น ${sku.shelfLocation}` : ''} · {STOCKING_POLICY_LABEL[sku.stockingPolicy]}
              {sku.reorderPoint !== null && sku.stockingPolicy === 'stocked' ? ` · จุดสั่งซื้อ ${qty(sku.reorderPoint)}` : ''}
              {!sku.isActive && ' · ปิดใช้งาน'}
            </p>
          )}
        </div>
        {sku && write && (
          <div className="qt-header-side">
            <Link className="btn secondary small" to={stockRoutes.countOne(sku.id)}>ตั้งยอด</Link>
            {sku.counted && <Link className="btn secondary small" to={stockRoutes.adjustOne(sku.id)}>ปรับยอด</Link>}
          </div>
        )}
      </header>
      <StockNav role={role} />

      {card.loading && !card.data && <div className="page-loading">กำลังโหลด...</div>}
      {card.error && !card.data && (
        <div className="empty-state" role="alert">
          โหลดการ์ดสต๊อกไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => card.reload?.()}>ลองใหม่</button></div>
        </div>
      )}
      {card.error && card.data && <p className="ci-nomatch" role="status">โหลดล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม</p>}

      {sku && (
        <section className="card" aria-label="ยอดคงเหลือ">
          <div className="st-card-head">
            <StockFigures sku={sku} />
            <span className="st-row-badges">
              <StockStatusBadge status={sku.status} />
            </span>
          </div>
          {!sku.counted && (
            <p className="qt-line-sub">
              ยังไม่มีใครตั้งยอดของตัวนี้ — ขายและจองได้ตามปกติ แต่ระบบยังไม่รู้ว่ามีกี่ชิ้น
              {write && <> · <Link to={stockRoutes.countOne(sku.id)}>ตั้งยอดตอนนี้</Link></>}
            </p>
          )}
          {sku.counted && isNegative(sku.available) && (
            <p className="ci-form-error" role="alert">พร้อมใช้ติดลบ: ของบนชั้นน้อยกว่าที่จองให้งานไว้ — ตรวจงานที่จองของตัวนี้ (ประวัติ “จอง” ด้านล่าง)</p>
          )}
          <StockCost sku={sku} />
          {detail.data && detail.data.catalogItems.length > 0 && (
            <p className="qt-line-sub">ผูกกับรายการขาย: {detail.data.catalogItems.map((c) => `${c.name} (${c.category})`).join(' · ')}</p>
          )}
          {detail.data && detail.data.catalogItems.length === 0 && (
            <p className="qt-line-sub">ยังไม่ผูกกับรายการขายในแคตตาล็อก — ใบเสนอราคาจะยังไม่จอง/เบิกของตัวนี้{write && <> · <Link to={stockRoutes.links}>ผูกแคตตาล็อก</Link></>}</p>
          )}
        </section>
      )}

      {moves && (
        <section className="card" aria-label="ประวัติการเคลื่อนไหว">
          <h3>ประวัติการเคลื่อนไหว</h3>
          <div className="dp-chips st-move-filter" role="group" aria-label="ชนิดรายการ">
            {TYPE_FILTERS.map((t) => (
              <button key={t.key} type="button" className={`chip${type === t.key ? ' active' : ''}`} aria-pressed={type === t.key} onClick={() => { setType(t.key); setOffset(0); }}>
                {t.label}
              </button>
            ))}
          </div>
          <p className="qt-line-sub st-count-line">{moves.total} รายการ · ใหม่สุดก่อน</p>
          {moves.items.length === 0 && <p className="qt-line-sub">ไม่มีรายการ</p>}
          <ul className="st-rows">
            {moves.items.map((m) => <MoveItem key={m.id} move={m} role={role} unit={sku?.unit ?? ''} />)}
          </ul>
          <Pager offset={offset} limit={STOCK_PAGE_SIZE} total={moves.total} onChange={setOffset} />
        </section>
      )}
    </div>
  );
}

/** Where a move's source opens for this role: the quotation / bill for counter staff, the issue list otherwise. */
function refHref(ref: MoveRef, role: Role | null): string | null {
  if (!ref.jobId) return null;
  if (ref.documentType === 'receipt' && canReadBill(role)) return billHref(ref.jobId);
  if (ref.documentType === 'quotation' && canReadQuote(role)) return `/jobs/${encodeURIComponent(ref.jobId)}/quote`;
  if (canIssueStock(role)) return stockRoutes.jobIssue(ref.jobId);
  return null;
}

function MoveItem({ move: m, role, unit }: { move: MoveRow; role: Role | null; unit: string }) {
  const neg = isNegative(m.qty);
  const href = m.ref ? refHref(m.ref, role) : null;
  const docName = m.ref ? (DOC_TYPE_LABEL[m.ref.documentType] ?? m.ref.documentType) : null;
  return (
    <li className="st-row st-move">
      <div className="st-row-main">
        <span className="st-move-top">
          <span className="pill pill-muted">{MOVE_TYPE_LABEL[m.type]}</span>
          <strong className={`mono ${neg ? 'st-neg' : 'st-pos'}`}>{neg ? '' : '+'}{qty(m.qty)} {unit}</strong>
          <span className="qt-line-sub">{thaiDateTime(m.at)} · {m.user?.name ?? 'ระบบ'}</span>
        </span>
        <span className="qt-line-sub">
          คงเหลือหลังรายการ <span className="mono">{m.onHandAfter === null ? '-' : qty(m.onHandAfter)}</span>
          {m.reservedAfter !== null && <> · จองหลังรายการ <span className="mono">{qty(m.reservedAfter)}</span></>}
          {hasCost(m.unitCost) && <> · ต้นทุนต่อหน่วย <span className="mono">{baht(m.unitCost)}</span></>}
        </span>
        {m.reason && <span className="st-move-reason">เหตุผล: {m.reason}</span>}
        {m.ref && (
          <span className="qt-line-sub">
            {m.ref.jobNumber ? `งาน ${m.ref.jobNumber} · ` : ''}
            {docName}{m.ref.documentNumber ? ` ${m.ref.documentNumber}` : ' (ร่าง)'}
            {m.ref.lineName ? ` · ${m.ref.lineName}` : ''}
            {href && <> · <Link to={href}>เปิด</Link></>}
          </span>
        )}
      </div>
    </li>
  );
}
