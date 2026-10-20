import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DailySummary, Role } from '@gsms/contracts/index.js';
import { useDocument } from '../../hooks/useDocument';
import { baht } from '../../lib/money';
import type { MoneyInChannelRow } from '../../lib/pendingContracts';
import { bangkokTodayKey, dateKeyThai } from '../../lib/printFormat';
import { canReadDaily, PAYMENT_METHOD_LABEL } from '../bill/billLabels';

/** The route element: /daily. */
export function DailyRoute({ role }: { role: Role | null }) {
  if (!canReadDaily(role)) {
    return (
      <div className="empty-state" role="alert">
        หน้านี้มียอดเงิน จึงเปิดได้เฉพาะหน้าร้าน ผู้จัดการ บัญชี และเจ้าของ
        <div><Link className="btn secondary" to="/today">กลับหน้างานวันนี้</Link></div>
      </div>
    );
  }
  return <DailySummaryPage />;
}

/**
 * สรุปรายวัน (CLAUDE.md §5.4 rule 9, AC-F1..F8). Two figures that are NEVER
 * added together or put on one line: money IN by the day it was received, and
 * SALES by the day the bill was closed. They differ on purpose (a deposit on
 * the 3rd billed on the 8th). Every number says its period and its basis
 * (§5.7 rule 10). All figures are the server's.
 */
export function DailySummaryPage() {
  const [date, setDate] = useState(() => bangkokTodayKey());
  const today = bangkokTodayKey();
  const summary = useDocument<DailySummary>(`/api/daily-summary?date=${date}`, 'daily-summary:changed');
  const s = summary.data && summary.data.date === date ? summary.data : null;
  const period = `${dateKeyThai(date)} (00:00–23:59 เวลาไทย)`;

  return (
    <div className="qt-page dl-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>สรุปรายวัน</h1>
          <p className="page-sub">เงินเข้า กับ ยอดขาย เป็นคนละตัวเลข นับคนละวิธี — ไม่รวมกัน และไม่จำเป็นต้องเท่ากัน</p>
        </div>
        <div className="qt-header-side">
          <label className="field dl-date">
            <span>วันที่</span>
            <input type="date" value={date} max={today} onChange={(e) => { if (e.target.value) setDate(e.target.value); }} />
          </label>
          {date !== today && <button type="button" className="btn secondary small" onClick={() => setDate(today)}>วันนี้</button>}
        </div>
      </header>

      {summary.loading && !s && <div className="page-loading">กำลังโหลดสรุป...</div>}
      {summary.error && !s && (
        <div className="empty-state" role="alert">
          โหลดสรุปไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => summary.reload?.()}>ลองใหม่</button></div>
        </div>
      )}
      {summary.error && s && <p className="ci-nomatch" role="status">โหลดล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม</p>}

      {s && (
        <>
          <div className="dl-grid">
            <MoneyInCard s={s} period={period} />
            <SalesCard s={s} period={period} />
          </div>
          <OtherCard s={s} period={period} />
        </>
      )}
    </div>
  );
}

/** B3 (ASSUMED shape, see lib/pendingContracts.ts): the API may add these to moneyIn; absent on the f25038f API. */
type MoneyInPending = DailySummary['moneyIn'] & { byChannel?: MoneyInChannelRow[]; surchargeTotal?: string };

const KIND_LABEL: Record<MoneyInChannelRow['kind'], string> = { cash: 'เงินสด', transfer: 'โอน', card: 'บัตร' };

function MoneyInCard({ s, period }: { s: DailySummary; period: string }) {
  const m: MoneyInPending = s.moneyIn;
  return (
    <section className="card dl-card dl-in" aria-label="เงินเข้าวันนี้">
      <h3>เงินเข้าวันนี้</h3>
      <p className="dl-basis">{period} · นับตาม<strong>วันที่รับเงิน</strong> · หักเงินทอนและเงินที่คืนลูกค้าแล้ว{m.label ? ` · ${m.label}` : ''}</p>
      {m.byChannel && m.byChannel.length > 0 && (
        <>
          <h4 className="dl-sub">แยกตามช่องทางของร้าน</h4>
          <table className="dl-table">
            <thead>
              <tr><th>ช่องทาง</th><th className="num">รับมา</th><th className="num">ค่าธรรมเนียม</th><th className="num">ทอน/คืน</th><th className="num">สุทธิ</th></tr>
            </thead>
            <tbody>
              {m.byChannel.map((r) => (
                <tr key={r.channelId ?? r.name}>
                  <td>{r.name} <span className="qt-line-sub">({KIND_LABEL[r.kind]})</span></td>
                  <td className="num mono">{baht(r.received)}</td>
                  <td className="num mono">{baht(r.surcharge)}</td>
                  <td className="num mono">{baht(r.changeGiven)} / {baht(r.reversed)}</td>
                  <td className="num mono"><strong>{baht(r.net)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 className="dl-sub">แยกตามประเภท</h4>
        </>
      )}
      <table className="dl-table">
        <thead>
          <tr><th>ช่องทาง</th><th className="num">รับมา</th><th className="num">ทอน</th><th className="num">คืน</th><th className="num">สุทธิ</th></tr>
        </thead>
        <tbody>
          {m.byMethod.map((r) => (
            <tr key={r.method}>
              <td>{PAYMENT_METHOD_LABEL[r.method]}</td>
              <td className="num mono">{baht(r.received)}</td>
              <td className="num mono">{baht(r.changeGiven)}</td>
              <td className="num mono">{baht(r.reversed)}</td>
              <td className="num mono"><strong>{baht(r.net)}</strong></td>
            </tr>
          ))}
          {m.byMethod.length === 0 && <tr><td colSpan={5}>ไม่มีเงินเข้าในวันนี้</td></tr>}
        </tbody>
      </table>
      {m.surchargeTotal !== undefined && m.surchargeTotal !== '0.00' && (
        <p className="dl-basis">ในจำนวนนี้เป็นค่าธรรมเนียมช่องทางชำระ (เช่น รูดบัตร) {baht(m.surchargeTotal)} — ไม่ใช่ยอดขาย</p>
      )}
      <p className="dl-total">เงินเข้าสุทธิ <span className="mono">{baht(m.total)}</span></p>
      <p className="dl-basis">
        จาก {m.paymentCount} รายการรับเงิน · คืนเงิน {m.reversalCount} รายการ · ทอน {m.changeCount} ครั้ง รวม {baht(m.changeTotal)}
      </p>
    </section>
  );
}

function SalesCard({ s, period }: { s: DailySummary; period: string }) {
  const x = s.sales;
  return (
    <section className="card dl-card dl-sales" aria-label="ยอดขายวันนี้">
      <h3>ยอดขายวันนี้</h3>
      <p className="dl-basis">{period} · นับตาม<strong>วันที่ปิดบิล (ออกใบเสร็จ)</strong> · เฉพาะใบเสร็จที่ไม่ถูกยกเลิก{x.label ? ` · ${x.label}` : ''}</p>
      <dl className="bl-kv">
        <dt>จำนวนบิล</dt><dd className="mono">{x.billCount} บิล · {x.customerCount} ลูกค้า</dd>
        <dt>รวมก่อนส่วนลด</dt><dd className="mono">{baht(x.subtotal)}</dd>
        <dt>ส่วนลดรวม</dt><dd className="mono">{baht(x.discountTotal)}</dd>
      </dl>
      <p className="dl-total">ยอดขาย <span className="mono">{baht(x.billTotal)}</span></p>
      <p className="dl-basis">ตัวหาร: {x.billCount} บิลที่ปิดในวันนี้ · ไม่รวมงานเคลมประกัน · ไม่รวมใบเสร็จที่ยกเลิก</p>

      {x.overCeiling.length > 0 && (
        <div className="dl-flag">
          <h4>ส่วนลดเกินเพดาน ({x.overCeiling.length} บิล)</h4>
          <ul>
            {x.overCeiling.map((o) => (
              <li key={o.receiptId}>
                <span className="mono">{o.number}</span> · ลด {baht(o.discount)} ({o.percent}%) · อนุมัติโดย {o.approvedByName ?? '-'}
                {o.reason && <span className="qt-line-sub"> — {o.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {x.belowAgreed.length > 0 && (
        <div className="dl-flag">
          <h4>บิลที่น้อยกว่ายอดที่ตกลง ({x.belowAgreed.length} บิล — มีรายการที่ไม่ได้ทำ)</h4>
          <ul>
            {x.belowAgreed.map((b) => (
              <li key={b.receiptId}>
                <span className="mono">{b.number}</span> · เก็บ {baht(b.billTotal)} จากที่ตกลง {baht(b.agreedTotal)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function OtherCard({ s, period }: { s: DailySummary; period: string }) {
  const v = s.voided;
  return (
    <section className="card dl-card" aria-label="ไม่นับเป็นยอดขาย">
      <h3>แสดงแยก — ไม่นับในยอดขาย</h3>
      <p className="dl-basis">{period}</p>
      <dl className="bl-kv">
        <dt>ออกวันนี้แล้วถูกยกเลิก</dt><dd className="mono">{v.issuedToday.count} ใบ · {baht(v.issuedToday.billTotal)}</dd>
        <dt>ยกเลิกในวันนี้ (ทุกวันที่ออก)</dt><dd className="mono">{v.voidedToday.count} ใบ · {baht(v.voidedToday.billTotal)}</dd>
        <dt>งานเคลมประกันที่ส่งรถวันนี้</dt><dd className="mono">{s.warrantyClaimsDelivered} คัน (ไม่มีใบเสร็จ ไม่มีรายได้)</dd>
      </dl>
      <p className="dl-basis">เงินที่คืนลูกค้าจากการยกเลิก หักอยู่ในการ์ด “เงินเข้าวันนี้” ช่อง “คืน” แล้ว</p>
    </section>
  );
}

