import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  Deposit, DepositList, DepositStatus, ForfeitDepositInput, PaymentChannelList, RefundDepositInput, Role,
} from '@gsms/contracts/index.js';
import { DepositSlipPrintButton } from '../../components/print/DepositSlipPrintButton';
import { ReasonDialog } from '../../components/ui/ReasonDialog';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { baht } from '../../lib/money';
import { dateKeyThai, thaiDateTime } from '../../lib/printFormat';
import { PAYMENT_CHANNELS_PATH } from '../bill/PaymentPanel';
import { describeDepositError } from './depositErrors';
import {
  DEPOSITS_PATH, DEPOSIT_CHANNEL_LABEL, DEPOSIT_REASON_LABEL, DEPOSIT_SOCKET_EVENT, DEPOSIT_STATUS_LABEL,
  canForfeitDeposit, canRefundDeposit, canWriteDeposit, depositPath,
} from './depositLabels';

const PAGE_SIZE = 50;

/** The route element: /deposits. */
export function DepositsRoute({ role }: { role: Role | null }) {
  if (role === null || role === 'technician') {
    // A technician sees no money (CLAUDE.md §12.1); the API refuses him too.
    return (
      <div className="empty-state" role="alert">
        หน้านี้มียอดเงิน จึงเปิดได้เฉพาะหน้าร้าน ผู้จัดการ บัญชี และเจ้าของ
        <div><Link className="btn secondary" to="/today">กลับหน้างานวันนี้</Link></div>
      </div>
    );
  }
  return <DepositsPage role={role} />;
}

type View = { status: DepositStatus; overdueOnly: boolean };

const TABS: Array<{ key: string; label: string; view: View }> = [
  { key: 'held', label: 'ถืออยู่ทั้งหมด', view: { status: 'held', overdueOnly: false } },
  { key: 'overdue', label: 'เลยวันนัด', view: { status: 'held', overdueOnly: true } },
  { key: 'applied', label: DEPOSIT_STATUS_LABEL.applied, view: { status: 'applied', overdueOnly: false } },
  { key: 'refunded', label: DEPOSIT_STATUS_LABEL.refunded, view: { status: 'refunded', overdueOnly: false } },
  { key: 'forfeited', label: DEPOSIT_STATUS_LABEL.forfeited, view: { status: 'forfeited', overdueOnly: false } },
];

/**
 * มัดจำค้างอยู่ (CLAUDE.md §5.4 item 7): money the shop is holding for customers
 * is the shop's debt — how much, whose, since when, through which channel. A
 * deposit past its expected day is flagged at once (item 8) with two buttons,
 * always both offered to whoever may press them: คืนมัดจำ / ริบมัดจำ. Neither
 * is ever automatic, both need a reason, and ริบ is manager and above only.
 */
export function DepositsPage({ role }: { role: Role }) {
  const [tab, setTab] = useState('held');
  const [offset, setOffset] = useState(0);
  const view = TABS.find((t) => t.key === tab)!.view;
  const path = `${DEPOSITS_PATH}?status=${view.status}&overdue=${view.overdueOnly ? 'true' : 'false'}&limit=${PAGE_SIZE}&offset=${offset}`;
  const list = useDocument<DepositList>(path, DEPOSIT_SOCKET_EVENT);
  const data = list.data;
  const s = data?.summary;
  const mayWrite = canWriteDeposit(role);

  return (
    <div className="qt-page dp-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <h1>มัดจำค้างอยู่</h1>
          <p className="page-sub">เงินลูกค้าที่ร้านถือไว้ = หนี้ของร้าน จนกว่าจะหักเข้าบิล คืน หรือริบ</p>
        </div>
        <div className="qt-header-side">
          {mayWrite && <Link className="btn hazard" to="/deposits/new">รับมัดจำ (ยังไม่มีรถ)</Link>}
        </div>
      </header>

      {s && (
        <section className="card dp-summary" aria-label="ยอดมัดจำที่ถืออยู่">
          <p className="dl-total">ร้านถือเงินมัดจำลูกค้าอยู่ <span className="mono">{baht(s.heldTotal)}</span></p>
          <p className="dl-basis">{s.heldCount} รายการ · ณ วันที่ {dateKeyThai(s.asOf)} (ทุกวันที่รับ ทุกช่องทาง)</p>
          {s.overdueCount > 0 && (
            <p className="dp-overdue-line" role="alert">
              เลยวันนัดแล้ว {s.overdueCount} รายการ รวม <strong className="mono">{baht(s.overdueTotal)}</strong> — ตัดสินใจคืนหรือริบเป็นราย ๆ ไป
            </p>
          )}
        </section>
      )}

      <div className="dp-chips dp-tabs" role="tablist" aria-label="สถานะมัดจำ">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`chip${tab === t.key ? ' active' : ''}`}
            onClick={() => { setTab(t.key); setOffset(0); }}>
            {t.label}
          </button>
        ))}
      </div>

      {list.loading && !data && <div className="page-loading">กำลังโหลด...</div>}
      {list.error && !data && (
        <div className="empty-state" role="alert">
          โหลดรายการมัดจำไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => list.reload?.()}>ลองใหม่</button></div>
        </div>
      )}
      {list.error && data && <p className="ci-nomatch" role="status">โหลดล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม</p>}

      {data && (
        <section className="card" aria-label="รายการมัดจำ">
          {data.items.length === 0 && <p className="qt-line-sub">ไม่มีรายการ</p>}
          <ul className="dp-rows">
            {data.items.map((d) => (
              <DepositRow key={d.id} deposit={d} role={role} onChanged={() => list.reload?.()} />
            ))}
          </ul>
          {data.total > PAGE_SIZE && (
            <div className="row-flex dp-pager">
              <button type="button" className="btn secondary small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>ก่อนหน้า</button>
              <span className="qt-line-sub">{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} จาก {data.total}</span>
              <button type="button" className="btn secondary small" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>ถัดไป</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function DepositRow({ deposit: d, role, onChanged }: { deposit: Deposit; role: Role; onChanged: () => void }) {
  const [dialog, setDialog] = useState<'refund' | 'forfeit' | null>(null);
  const mayRefund = canRefundDeposit(role) && d.next.canRefund;
  // Not even shown below manager (s5.4 item 8); the API refuses it too.
  const mayForfeit = canForfeitDeposit(role) && d.next.canForfeit;
  const held = d.status === 'held';

  return (
    <li className={`dp-row${d.overdue ? ' is-overdue' : ''}`}>
      <div className="dp-row-main">
        <div className="dp-row-top">
          <strong className="mono dp-row-amount">{baht(d.amount)}</strong>
          <span className="dp-row-who">{d.customerName ?? 'ไม่มีชื่อ'}{d.customerPhone ? ` · ${d.customerPhone}` : ''}</span>
          {d.overdue && <span className="pill pill-danger">เลยวันนัด {d.daysOverdue} วัน</span>}
          {!held && <span className="pill pill-muted">{DEPOSIT_STATUS_LABEL[d.status]}</span>}
        </div>
        <span className="qt-line-sub">
          รับเมื่อ {thaiDateTime(d.receivedAt)} · ติดต่อทาง {DEPOSIT_CHANNEL_LABEL[d.channel]}
          {d.paymentChannelName ? ` · รับทาง ${d.paymentChannelName}` : ''} · {DEPOSIT_REASON_LABEL[d.reason]}
        </span>
        <span className={`qt-line-sub${d.overdue ? ' dp-row-due' : ''}`}>
          นัดเอารถเข้า {dateKeyThai(d.expectedDate)}
          {d.slip ? ` · ${d.slip.number}` : ' · ยังไม่ได้พิมพ์ใบมัดจำ'}
          {d.jobNumber ? ` · งาน ${d.jobNumber}` : ''}{d.plate ? ` · ${d.plate}` : ''}
          {d.slipFileId ? ' · มีรูปสลิป' : ''}
        </span>
        {d.status === 'applied' && d.appliedToReceiptNumber && <span className="qt-line-sub">หักเข้าใบเสร็จ {d.appliedToReceiptNumber}</span>}
        {(d.status === 'refunded' || d.status === 'forfeited') && (
          <span className="qt-line-sub">
            {DEPOSIT_STATUS_LABEL[d.status]} {thaiDateTime(d.closedAt)} โดย {d.closedByName ?? '-'} — {d.closeReason ?? '-'}
            {d.refundChannelName ? ` · คืนทาง ${d.refundChannelName}` : ''}
          </span>
        )}
      </div>
      <div className="dp-row-actions">
        {d.next.canPrintSlip && <DepositSlipPrintButton depositId={d.id} className="btn secondary small" label="พิมพ์ใบมัดจำ" onPrinted={onChanged} />}
        {d.jobId && <Link className="btn secondary small" to={`/jobs/${encodeURIComponent(d.jobId)}/quote`}>เปิดงาน</Link>}
        {mayRefund && <button type="button" className="btn secondary small" onClick={() => setDialog('refund')}>คืนมัดจำ</button>}
        {mayForfeit && <button type="button" className="btn danger small" onClick={() => setDialog('forfeit')}>ริบมัดจำ</button>}
      </div>
      {dialog === 'refund' && <RefundDialog deposit={d} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChanged(); }} />}
      {dialog === 'forfeit' && <ForfeitDialog deposit={d} onClose={() => setDialog(null)} onDone={() => { setDialog(null); onChanged(); }} />}
    </li>
  );
}

/** One request at a time per dialog; the reason is mandatory (ReasonDialog required). */
function useDepositAction() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  async function run(call: () => Promise<unknown>, onDone: () => void) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      await call();
      onDone();
    } catch (err) {
      const f = describeDepositError(err);
      if (f.cancelled) return;
      setError(f.text);
      setFieldError(f.fields.reason ?? null);
      if (f.stale) onDone();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return { busy, error, fieldError, run };
}

function RefundDialog({ deposit: d, onClose, onDone }: { deposit: Deposit; onClose: () => void; onDone: () => void }) {
  const a = useDepositAction();
  const id = useId();
  const channels = useDocument<PaymentChannelList>(PAYMENT_CHANNELS_PATH, 'payment-channel:changed');
  const active = (channels.data?.items ?? []).filter((c) => c.active).sort((x, y) => x.sortOrder - y.sortOrder);
  const [refundChannelId, setRefundChannelId] = useState('');
  return (
    <ReasonDialog
      title="คืนมัดจำ"
      confirmLabel={`ยืนยันคืน ${baht(d.amount)}`}
      required
      busy={a.busy}
      errorText={a.error}
      fieldError={a.fieldError}
      reasonLabel="เหตุผลที่คืน (จำเป็น)"
      onCancel={onClose}
      onConfirm={(reason) => {
        const body: RefundDepositInput = { reason: reason ?? '', ...(refundChannelId ? { refundChannelId } : {}) };
        void a.run(() => api.post<Deposit>(`${depositPath(d.id)}/refund`, body), onDone);
      }}
    >
      <p>คืนเงินมัดจำ <strong className="mono">{baht(d.amount)}</strong> ให้ {d.customerName ?? 'ลูกค้า'} — นับเป็นเงินออกในสรุปรายวันของวันนี้</p>
      <label className="field ci-field" htmlFor={id}>
        <span className="ci-field-label">คืนทาง</span>
        <select id={id} value={refundChannelId} disabled={a.busy} onChange={(e) => setRefundChannelId(e.target.value)}>
          <option value="">ช่องทางเดิมที่รับมา{d.paymentChannelName ? ` (${d.paymentChannelName})` : ''}</option>
          {active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
    </ReasonDialog>
  );
}

function ForfeitDialog({ deposit: d, onClose, onDone }: { deposit: Deposit; onClose: () => void; onDone: () => void }) {
  const a = useDepositAction();
  return (
    <ReasonDialog
      title="ริบมัดจำ"
      confirmLabel={`ยืนยันริบ ${baht(d.amount)}`}
      required
      danger
      busy={a.busy}
      errorText={a.error}
      fieldError={a.fieldError}
      reasonLabel="เหตุผลที่ริบ (จำเป็น)"
      onCancel={onClose}
      onConfirm={(reason) => {
        const body: ForfeitDepositInput = { reason: reason ?? '' };
        void a.run(() => api.post<Deposit>(`${depositPath(d.id)}/forfeit`, body), onDone);
      }}
    >
      <p>ริบเงินมัดจำ <strong className="mono">{baht(d.amount)}</strong> ของ {d.customerName ?? 'ลูกค้า'} — เงินลูกค้าจะกลายเป็นรายได้ของร้านในวันนี้</p>
      <p className="qt-line-sub">แยกเป็นหมวด “รายได้จากมัดจำที่ริบ” ไม่ใช่ยอดขายค่าซ่อม และไม่ออกใบกำกับภาษี (ตามที่เจ้าของตัดสินใจ) · ย้อนกลับไม่ได้</p>
    </ReasonDialog>
  );
}
