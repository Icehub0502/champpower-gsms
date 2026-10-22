import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { statusOf } from '@champpower/domain';
import type {
  DailyAdjustments, IntegrityReport, Role, StaleReservationPage, UnboundLinePage,
} from '@gsms/contracts/index.js';
import { Pager } from '../../components/ui/Pager';
import { useDocument } from '../../hooks/useDocument';
import { bangkokTodayKey, dateKeyThai, thaiTime } from '../../lib/printFormat';
import { canReadQuote } from '../quote/quoteLabels';
import { StockNav, StockNoAccess } from './StockNav';
import {
  APPROVAL_LABEL, DOC_STATUS_LABEL, STOCK_API, STOCK_CHANGED_EVENT, STOCK_PAGE_SIZE,
  canIssueStock, canReadStockReports, canWriteStock, isNegative, qty, stockRoutes,
} from './stockLabels';

function quoteHref(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/quote`;
}

function LoadState({ loading, error, hasData, what, reload }: { loading: boolean; error: boolean; hasData: boolean; what: string; reload?: () => void }) {
  if (loading && !hasData) return <div className="page-loading">กำลังโหลด...</div>;
  if (error && !hasData) {
    return (
      <div className="empty-state" role="alert">
        โหลด{what}ไม่สำเร็จ
        <div><button type="button" className="btn secondary" onClick={() => reload?.()}>ลองใหม่</button></div>
      </div>
    );
  }
  if (error && hasData) return <p className="ci-nomatch" role="status">โหลดล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม</p>;
  return null;
}

function ReportHeader({ title, sub, side }: { title: string; sub: string; side?: ReactNode }) {
  return (
    <header className="qt-header">
      <div className="qt-header-main">
        <h1>{title}</h1>
        <p className="page-sub">{sub}</p>
      </div>
      {side && <div className="qt-header-side">{side}</div>}
    </header>
  );
}

// ---------------------------------------------------------------------------
// บรรทัดที่ยังไม่ผูกสต๊อก
// ---------------------------------------------------------------------------

export function UnboundLinesRoute({ role }: { role: Role | null }) {
  if (!canWriteStock(role)) return <StockNoAccess role={role} what="รายงานนี้" />;
  return <UnboundLinesReport role={role} />;
}

/** Live part lines with no SKU (CLAUDE.md s5.2): sold, but never reserved or cut from stock. */
function UnboundLinesReport({ role }: { role: Role | null }) {
  const [offset, setOffset] = useState(0);
  const list = useDocument<UnboundLinePage>(`${STOCK_API}/unbound-lines?limit=${STOCK_PAGE_SIZE}&offset=${offset}`, STOCK_CHANGED_EVENT);
  const data = list.data;
  return (
    <div className="qt-page st-page">
      <ReportHeader title="บรรทัดที่ยังไม่ผูกสต๊อก" sub="อะไหล่ในใบเสนอราคาที่ไม่ผูกกับอะไหล่ในสต๊อก — ขายได้ แต่ไม่จองและไม่ตัดสต๊อก" side={<Link className="btn secondary small" to={stockRoutes.links}>ไปผูกแคตตาล็อก</Link>} />
      <StockNav role={role} />
      <LoadState loading={list.loading} error={list.error} hasData={!!data} what="รายงาน" reload={list.reload} />
      {data && (
        <section className="card" aria-label="บรรทัดที่ยังไม่ผูกสต๊อก">
          <p className="qt-line-sub st-count-line">{data.total} บรรทัด</p>
          {data.items.length === 0 && <p className="qt-line-sub">ไม่มีรายการ — ทุกบรรทัดอะไหล่ผูกสต๊อกแล้ว</p>}
          <ul className="st-rows">
            {data.items.map((l) => (
              <li key={l.lineId} className="st-row">
                <div className="st-row-main">
                  <span className="st-name">{l.name}</span>
                  <span className="qt-line-sub">
                    จำนวน <span className="mono">{qty(l.qty)}</span> · {APPROVAL_LABEL[l.approvalStatus]}
                    {l.jobNumber ? ` · งาน ${l.jobNumber}` : ''}
                    {` · ใบเสนอราคา ${l.documentNumber ?? '(ร่าง)'} ${DOC_STATUS_LABEL[l.documentStatus] ?? l.documentStatus}`}
                  </span>
                  <span className="qt-line-sub">{l.catalogItemId ? 'มาจากแคตตาล็อก — ผูกรายการแคตตาล็อกนั้นกับสต๊อก' : 'พิมพ์เอง ไม่ได้มาจากแคตตาล็อก'}</span>
                </div>
                <div className="st-row-actions">
                  {l.jobId && canReadQuote(role) && <Link className="btn secondary small" to={quoteHref(l.jobId)}>เปิดใบเสนอราคา</Link>}
                </div>
              </li>
            ))}
          </ul>
          <Pager offset={offset} limit={STOCK_PAGE_SIZE} total={data.total} onChange={setOffset} />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ของจองค้าง
// ---------------------------------------------------------------------------

export function StaleReservationsRoute({ role }: { role: Role | null }) {
  if (!canWriteStock(role)) return <StockNoAccess role={role} what="รายงานนี้" />;
  return <StaleReservationsReport role={role} />;
}

/**
 * Parts still reserved although the job is over or the quotation closed. Nothing clears
 * itself: a person decides — issue it (it was fitted) or adjust (it was not).
 */
function StaleReservationsReport({ role }: { role: Role | null }) {
  const [offset, setOffset] = useState(0);
  const list = useDocument<StaleReservationPage>(`${STOCK_API}/stale-reservations?limit=${STOCK_PAGE_SIZE}&offset=${offset}`, STOCK_CHANGED_EVENT);
  const data = list.data;
  return (
    <div className="qt-page st-page">
      <ReportHeader title="ของจองค้าง" sub="งานจบแล้ว หรือใบเสนอราคาปิดแล้ว แต่ของยังจองอยู่ — กันของไว้จากงานอื่น ต้องมีคนตัดสินใจ" />
      <StockNav role={role} />
      <LoadState loading={list.loading} error={list.error} hasData={!!data} what="รายงาน" reload={list.reload} />
      {data && (
        <section className="card" aria-label="ของจองค้าง">
          <p className="qt-line-sub st-count-line">{data.total} รายการ</p>
          {data.items.length === 0 && <p className="qt-line-sub">ไม่มีรายการ</p>}
          <ul className="st-rows">
            {data.items.map((r) => (
              <li key={r.lineId} className="st-row">
                <div className="st-row-main">
                  <Link className="st-name" to={stockRoutes.card(r.skuId)}>{r.skuName}</Link>
                  <span className="qt-line-sub"><span className="mono">{r.skuCode}</span> · บรรทัด “{r.lineName}”</span>
                  <span className="qt-line-sub">
                    {r.jobNumber ? `งาน ${r.jobNumber}` : 'ไม่มีงาน'}
                    {r.jobStatus ? ` (${statusOf(r.jobStatus).label})` : ''}
                    {` · ใบเสนอราคา ${DOC_STATUS_LABEL[r.documentStatus] ?? r.documentStatus}`}
                  </span>
                </div>
                <div className="st-row-figs">
                  <span className="qt-line-sub">จองค้าง</span> <strong className="mono">{qty(r.reserved)}</strong>
                </div>
                <div className="st-row-actions">
                  {r.jobId && canIssueStock(role) && <Link className="btn small" to={stockRoutes.jobIssue(r.jobId)}>ใส่จริง → เบิก</Link>}
                  <Link className="btn secondary small" to={stockRoutes.adjustOne(r.skuId)}>ไม่ได้ใส่ → ปรับยอด</Link>
                  {r.jobId && canReadQuote(role) && <Link className="btn secondary small" to={quoteHref(r.jobId)}>ใบเสนอราคา</Link>}
                </div>
              </li>
            ))}
          </ul>
          <Pager offset={offset} limit={STOCK_PAGE_SIZE} total={data.total} onChange={setOffset} />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// การปรับสต๊อกด้วยมือรายวัน
// ---------------------------------------------------------------------------

export function DailyAdjustmentsRoute({ role }: { role: Role | null }) {
  if (!canReadStockReports(role)) return <StockNoAccess role={role} what="รายงานการปรับสต๊อกรายวัน" />;
  return <DailyAdjustmentsReport role={role} />;
}

function shiftDay(key: string, by: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + by));
  return dt.toISOString().slice(0, 10);
}

/**
 * Every count and adjustment of one Bangkok day (CLAUDE.md s12.1: the owner sees it every
 * day, even a quiet one). A day with nothing says "ไม่มีรายการ" — that sentence IS the report.
 */
function DailyAdjustmentsReport({ role }: { role: Role | null }) {
  const today = bangkokTodayKey();
  const [date, setDate] = useState(today);
  const dateId = useId();
  const doc = useDocument<DailyAdjustments>(`${STOCK_API}/adjustments?date=${encodeURIComponent(date)}`, STOCK_CHANGED_EVENT);
  const data = doc.data;
  return (
    <div className="qt-page st-page">
      <ReportHeader title="การปรับสต๊อกด้วยมือรายวัน" sub="ทุกการตั้งยอดและปรับยอดของวันนั้น · ใคร · ยอดเดิม → ยอดใหม่ · เหตุผล" />
      <StockNav role={role} />
      <section className="card st-filters" aria-label="เลือกวัน">
        <div className="row-flex">
          <button type="button" className="btn secondary small" onClick={() => setDate(shiftDay(date, -1))}>← วันก่อน</button>
          <label className="field ci-field dl-date" htmlFor={dateId}>
            <span className="ci-field-label">วันที่</span>
            <input id={dateId} type="date" value={date} max={today} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} />
          </label>
          <button type="button" className="btn secondary small" disabled={date >= today} onClick={() => setDate(shiftDay(date, 1))}>วันถัดไป →</button>
        </div>
      </section>
      <LoadState loading={doc.loading} error={doc.error} hasData={!!data} what="รายงาน" reload={doc.reload} />
      {data && (
        <section className="card" aria-label={`การปรับสต๊อก ${dateKeyThai(data.date)}`}>
          <h3>{dateKeyThai(data.date)} · ปรับยอด {data.adjustments} · ตั้งยอด {data.counts}</h3>
          {data.items.length === 0 && <p className="st-empty-day">ไม่มีรายการ</p>}
          <ul className="st-rows">
            {data.items.map((r) => {
              const neg = isNegative(r.delta);
              return (
                <li key={r.moveId} className="st-row">
                  <div className="st-row-main">
                    <span className="st-move-top">
                      <span className={`pill ${r.kind === 'adjustment' ? 'pill-warning' : 'pill-info'}`}>{r.kind === 'adjustment' ? 'ปรับยอด' : 'ตั้งยอด'}</span>
                      <Link className="st-name" to={stockRoutes.card(r.sku.id)}>{r.sku.name}</Link>
                      <span className="qt-line-sub mono">{r.sku.code}</span>
                    </span>
                    <span>
                      <span className="mono">{r.before === null ? 'ยังไม่ตั้งยอด' : qty(r.before)}</span> → <strong className="mono">{qty(r.after)}</strong>{' '}
                      <span className={`mono ${neg ? 'st-neg' : 'st-pos'}`}>({neg ? '' : '+'}{qty(r.delta)})</span>
                    </span>
                    <span className="st-move-reason">เหตุผล: {r.reason ?? '-'}</span>
                    <span className="qt-line-sub">{thaiTime(r.at)} · {r.user?.name ?? '-'}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ตรวจความถูกต้องของยอด
// ---------------------------------------------------------------------------

export function IntegrityRoute({ role }: { role: Role | null }) {
  if (!canReadStockReports(role)) return <StockNoAccess role={role} what="การตรวจความถูกต้องของยอด" />;
  return <IntegrityPage role={role} />;
}

/** Replays the ledger per SKU and lists every disagreement with the balance (CLAUDE.md s13 invariant 2). Read-only. */
function IntegrityPage({ role }: { role: Role | null }) {
  // A full ledger replay: NOT re-run on every stock:changed (its default event never fires) — only on open and on the button.
  const doc = useDocument<IntegrityReport>(`${STOCK_API}/integrity`);
  const r = doc.data;
  return (
    <div className="qt-page st-page">
      <ReportHeader
        title="ตรวจความถูกต้องของยอด"
        sub="รวมประวัติการเคลื่อนไหวทุกรายการ แล้วเทียบกับยอดคงเหลือ/ยอดจองที่ระบบเก็บไว้"
        side={<button type="button" className="btn secondary small" disabled={doc.loading} onClick={() => doc.reload?.()}>{doc.loading ? 'กำลังตรวจ...' : 'ตรวจอีกครั้ง'}</button>}
      />
      <StockNav role={role} />
      <LoadState loading={doc.loading} error={doc.error} hasData={!!r} what="ผลตรวจ" reload={doc.reload} />
      {r && r.ok && (
        <section className="card st-result" role="status">
          <h3>ยอดตรงกันทุกตัว</h3>
          <p className="qt-line-sub">ตรวจ {r.checkedSkus} รายการ ไม่พบความต่าง</p>
        </section>
      )}
      {r && !r.ok && (
        <section className="card" aria-label="รายการที่ยอดไม่ตรง">
          <p className="ci-form-error" role="alert">พบ {r.drift.length} รายการที่ยอดไม่ตรงกับประวัติ (จาก {r.checkedSkus} รายการ) — แจ้งทีมพัฒนา อย่าปรับยอดกลบ</p>
          <div className="table-wrap">
            <table className="st-moves">
              <thead>
                <tr><th>อะไหล่</th><th className="num">คงเหลือตามประวัติ</th><th className="num">คงเหลือที่เก็บ</th><th className="num">จองตามประวัติ</th><th className="num">จองที่เก็บ</th></tr>
              </thead>
              <tbody>
                {r.drift.map((d) => (
                  <tr key={d.skuId}>
                    <td><Link to={stockRoutes.card(d.skuId)}>{d.name}</Link> <span className="mono qt-line-sub">{d.code}</span></td>
                    <td className="num mono">{qty(d.ledgerOnHand)}</td>
                    <td className={`num mono${d.ledgerOnHand !== d.balanceOnHand ? ' neg' : ''}`}>{qty(d.balanceOnHand)}</td>
                    <td className="num mono">{qty(d.ledgerReserved)}</td>
                    <td className={`num mono${d.ledgerReserved !== d.balanceReserved ? ' neg' : ''}`}>{qty(d.balanceReserved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
