import type { SkuRow, StockStatus } from '@gsms/contracts/index.js';
import { baht } from '../../lib/money';
import { STOCK_STATUS_LABEL, STOCK_STATUS_PILL, hasCost, isNegative, qty } from '../../routes/stock/stockLabels';

/** "ยังไม่ตั้งยอด" / "หมด" / "ใกล้หมด" / "มีของ" — the server's own status, never recomputed. */
export function StockStatusBadge({ status }: { status: StockStatus }) {
  return <span className={`pill ${STOCK_STATUS_PILL[status]}`}>{STOCK_STATUS_LABEL[status]}</span>;
}

type Figures = Pick<SkuRow, 'counted' | 'onHand' | 'reserved' | 'available' | 'unit'>;

/**
 * คงเหลือ · จอง · พร้อมใช้ for one SKU.
 *
 * A SKU that was never counted has NO numbers (WO-006 §2): it says "ยังไม่ตั้งยอด" once
 * and nothing else — never "0", never "หมด", because "nobody has counted it" and "we
 * counted it and there are none" are different answers. "Do we have it?" reads
 * พร้อมใช้ (available), so that is the figure in bold.
 */
export function StockFigures({ sku, compact }: { sku: Figures; compact?: boolean }) {
  if (!sku.counted) {
    return <span className="st-figs st-figs-none">ยังไม่ตั้งยอด</span>;
  }
  const neg = isNegative(sku.available);
  return (
    <dl className={`st-figs${compact ? ' is-compact' : ''}`}>
      <div><dt>คงเหลือ</dt><dd className="mono">{qty(sku.onHand)}</dd></div>
      <div><dt>จอง</dt><dd className="mono">{qty(sku.reserved)}</dd></div>
      <div className={`st-fig-main${neg ? ' is-neg' : ''}`}>
        <dt>พร้อมใช้</dt>
        <dd className="mono">{qty(sku.available)}</dd>
      </div>
    </dl>
  );
}

/**
 * Cost figures, only for a caller the server sent them to AND only when known
 * (CLAUDE.md s12.2). Absent key or null value: renders nothing at all — no column,
 * no dash, no "ไม่ทราบ" — so a screen never even hints that a number exists.
 */
export function StockCost({ sku }: { sku: Pick<SkuRow, 'avgCost' | 'stockValue'> }) {
  const avg = hasCost(sku.avgCost) ? sku.avgCost : null;
  const value = hasCost(sku.stockValue) ? sku.stockValue : null;
  if (avg === null && value === null) return null;
  return (
    <span className="qt-line-sub st-cost">
      {avg !== null && <>ต้นทุนเฉลี่ย <span className="mono">{baht(avg)}</span></>}
      {avg !== null && value !== null && ' · '}
      {value !== null && <>มูลค่า <span className="mono">{baht(value)}</span></>}
    </span>
  );
}
