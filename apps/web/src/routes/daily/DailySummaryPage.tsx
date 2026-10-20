import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { cashVariance, countNeedsNote, toSatang } from '@champpower/domain';
import type { CashClosing, CashCountInput, DailySummary, Role } from '@gsms/contracts/index.js';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { baht, bahtDelta, typedSatang } from '../../lib/money';
import { bangkokTodayKey, dateKeyThai, thaiDateTime, thaiTime } from '../../lib/printFormat';
import { describeBillError, type BillFailure } from '../bill/billErrors';
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

function safeSatang(v: string): number {
  try {
    return toSatang(v);
  } catch {
    return 0;
  }
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
          <CashCard s={s} period={period} onSaved={() => summary.reload?.()} />
        </>
      )}
    </div>
  );
}

function MoneyInCard({ s, period }: { s: DailySummary; period: string }) {
  const m = s.moneyIn;
  return (
    <section className="card dl-card dl-in" aria-label="เงินเข้าวันนี้">
      <h3>เงินเข้าวันนี้</h3>
      <p className="dl-basis">{period} · นับตาม<strong>วันที่รับเงิน</strong> · หักเงินทอนและเงินที่คืนลูกค้าแล้ว{m.label ? ` · ${m.label}` : ''}</p>
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

function CashCard({ s, period, onSaved }: { s: DailySummary; period: string; onSaved: () => void }) {
  const c = s.cash;
  return (
    <section className="card dl-card dl-cash" aria-label="เงินสดในลิ้นชัก">
      <h3>เงินสดในลิ้นชัก</h3>
      <p className="dl-basis">{period} · เงินสดที่รับ − ทอน − คืน ของวันนั้น · ไม่มีเงินทอนตั้งต้น</p>
      <p className="dl-total">ควรมีในลิ้นชัก <span className="mono">{baht(c.expected)}</span></p>
      {c.closing && (
        <dl className="bl-kv">
          <dt>นับล่าสุด (ครั้งที่ {c.closing.revision})</dt><dd className="mono">{baht(c.closing.countedCash)} · {thaiDateTime(c.closing.closedAt)}</dd>
          <dt>ส่วนต่าง</dt><dd className={`mono${c.closing.variance.startsWith('-') ? ' dl-neg' : ''}`}>{varianceText(c.closing)}</dd>
          <dt>นับโดย</dt><dd>{c.closing.closedByName ?? '-'}</dd>
          {c.closing.note && (<><dt>หมายเหตุ</dt><dd>{c.closing.note}</dd></>)}
        </dl>
      )}
      {c.closing && safeSatang(c.receivedAfterCount) > 0 && (
        <p className="ci-form-error" role="alert">รับเงินสดหลังนับไปแล้ว {baht(c.receivedAfterCount)} — ยอดนับล่าสุดยังไม่รวมก้อนนี้ ควรนับใหม่</p>
      )}
      {c.canCount && <CashCountForm s={s} onSaved={onSaved} />}
      {!c.canCount && <p className="qt-line-sub">การนับเงินลิ้นชักทำได้เฉพาะผู้จัดการขึ้นไป</p>}
      {c.history.length > 1 && (
        <details className="dl-history">
          <summary>ประวัติการนับ ({c.history.length} ครั้ง — เก็บทุกครั้ง ไม่ทับของเดิม)</summary>
          <ol>
            {c.history.map((h) => (
              <li key={h.id}>
                ครั้งที่ {h.revision} · {thaiTime(h.closedAt)} · นับได้ {baht(h.countedCash)} · ส่วนต่าง {varianceText(h)} · {h.closedByName ?? '-'}
                {h.recountReason && <span className="qt-line-sub"> — นับใหม่เพราะ: {h.recountReason}</span>}
                {h.note && <span className="qt-line-sub"> — {h.note}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function varianceText(c: CashClosing): string {
  const v = safeSatang(c.variance.replace(/^-/, ''));
  return bahtDelta(c.variance.startsWith('-') ? -v : v);
}

/** AC-F7/F8, B7: expected is the system's; a count that does not match needs a note; a re-count is a NEW row with a reason. */
function CashCountForm({ s, onSaved }: { s: DailySummary; onSaved: () => void }) {
  const countedId = useId();
  const noteId = useId();
  const recountId = useId();
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [recount, setRecount] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<BillFailure | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const isRecount = s.cash.closing !== null;

  const countedSatang = counted.trim() === '' ? null : typedSatang(counted.trim());
  const variance = countedSatang === null ? null : cashVariance(safeSatang(s.cash.expected), countedSatang);
  const needsNote = variance !== null && countNeedsNote(variance);
  const noteMissing = needsNote && note.trim() === '';
  const recountMissing = isRecount && recount.trim() === '';

  async function save() {
    setTouched(true);
    if (countedSatang === null || noteMissing || recountMissing || busy) return;
    setBusy(true);
    setFailure(null);
    setSaved(null);
    const body: CashCountInput = { date: s.date, countedCash: counted.trim() };
    if (note.trim() !== '') body.note = note.trim();
    if (isRecount) body.recountReason = recount.trim();
    try {
      const row = await api.post<CashClosing>('/api/daily-closings', body);
      setSaved(`บันทึกการนับครั้งที่ ${row.revision} แล้ว · ส่วนต่าง ${varianceText(row)}`);
      setCounted('');
      setNote('');
      setRecount('');
      setTouched(false);
      onSaved();
    } catch (err) {
      const f = describeBillError(err);
      if (!f.cancelled) setFailure(f);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="dl-count" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h4>{isRecount ? 'นับใหม่' : 'บันทึกการนับเงินสด'}</h4>
      {saved && <p className="ci-match" role="status">{saved}</p>}
      {failure && <p className="ci-form-error" role="alert">{failure.text}</p>}
      <label className={`field${touched && countedSatang === null ? ' has-error' : ''}`} htmlFor={countedId}>
        <span>นับได้จริง (บาท)</span>
        <input id={countedId} inputMode="decimal" value={counted} disabled={busy} onChange={(e) => setCounted(e.target.value)} />
        {touched && countedSatang === null && <span className="ci-field-error">ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง</span>}
        {failure?.fields.countedCash && <span className="ci-field-error">{failure.fields.countedCash}</span>}
      </label>
      {variance !== null && (
        <p className={`dl-variance${variance < 0 ? ' dl-neg' : ''}`} role="status">
          ส่วนต่าง {bahtDelta(variance)} {variance < 0 ? '(ขาด)' : variance > 0 ? '(เกิน)' : '(ตรง)'}
        </p>
      )}
      {needsNote && (
        <label className={`field${touched && noteMissing ? ' has-error' : ''}`} htmlFor={noteId}>
          <span>หมายเหตุ — ทำไมไม่ตรง (บังคับ)</span>
          <textarea id={noteId} className="qt-textarea" rows={2} maxLength={500} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} />
          {touched && noteMissing && <span className="ci-field-error">จำเป็นต้องกรอก</span>}
        </label>
      )}
      {isRecount && (
        <label className={`field${touched && recountMissing ? ' has-error' : ''}`} htmlFor={recountId}>
          <span>เหตุผลที่นับใหม่ (บังคับ — การนับเดิมยังเก็บไว้)</span>
          <textarea id={recountId} className="qt-textarea" rows={2} maxLength={500} value={recount} disabled={busy} onChange={(e) => setRecount(e.target.value)} />
          {touched && recountMissing && <span className="ci-field-error">จำเป็นต้องกรอก</span>}
        </label>
      )}
      <button type="submit" className="btn" disabled={busy}>{busy ? 'กำลังบันทึก...' : 'บันทึกการนับ'}</button>
    </form>
  );
}
