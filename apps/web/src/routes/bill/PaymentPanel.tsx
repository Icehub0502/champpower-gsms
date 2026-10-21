import { Fragment, useId, useState } from 'react';
import {
  MoneyError, depositOffsetPlan, formatSatang, settlePayments, sumSatang, surchargeSatang, toSatang,
  type PaymentEntry, type PaymentSettlement,
} from '@champpower/domain';
import type {
  CloseReceiptInput, CloseReceiptResult, DepositWarning, PaymentChannel, PaymentChannelList, Receipt,
} from '@gsms/contracts/index.js';
import { HeldDepositWarning } from '../deposits/HeldDepositWarning';
import { thaiDateTime } from '../../lib/printFormat';
import { Modal } from '../../components/ui/Modal';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { baht, typedSatang } from '../../lib/money';
import type { BillFailure } from './billErrors';
import { BLOCKER_TEXT } from './billLabels';
import { isPresented } from './PresentStep';
import { receiptPath, type ReceiptState } from './useReceipt';

export const PAYMENT_CHANNELS_PATH = '/api/payment-channels';

interface PaymentPanelProps {
  jobId: string;
  receipt: Receipt;
  busy: string | null;
  guard: ReceiptState['guard'];
  show: ReceiptState['show'];
  reload: ReceiptState['reload'];
  onClosed: (result: CloseReceiptResult) => void;
}

/** channelId -> what was typed: the part of the BILL paid that way (the surcharge goes on top). */
type Typed = Record<string, string>;

function safeSatang(v: string): number {
  try {
    return toSatang(v);
  } catch {
    return 0;
  }
}

/** The channel's fee on one typed amount, from the one domain function; 0 while the amount or percent is not valid. */
function rowSurcharge(satang: number | null, percent: string): number {
  if (satang === null) return 0;
  try {
    return surchargeSatang(satang, percent);
  } catch (e) {
    if (e instanceof MoneyError) return 0;
    throw e;
  }
}

interface Row {
  channel: PaymentChannel;
  text: string;
  /** null = not a valid amount. */
  satang: number | null;
  surcharge: number;
}

function rowsOf(typed: Typed, channels: PaymentChannel[]): Row[] {
  return channels
    .filter((c) => typed[c.id] !== undefined)
    .map((c) => {
      const text = typed[c.id]!.trim();
      const satang = text === '' ? null : typedSatang(text);
      return { channel: c, text, satang, surcharge: rowSurcharge(satang, c.surchargePercent) };
    });
}

/** One entry per channel — the same domain settle function the API closes with. */
function entriesOf(rows: Row[]): PaymentEntry[] {
  return rows
    .filter((r) => r.text !== '')
    .map((r) => ({ key: r.channel.id, method: r.channel.kind, surchargePercent: r.channel.surchargePercent, amount: r.text }));
}

function settlementText(s: PaymentSettlement): string | null {
  // `'code' in s` narrows the failure arm; apps/web compiles without strictNullChecks, where `!s.ok` does not.
  if (!('code' in s)) return null;
  switch (s.code) {
    case 'payment_short': return `ขาดอีก ${baht(s.short)} — ปิดบิลไม่ได้จนกว่าจะรับครบ`;
    case 'payment_over_noncash': return `โอน/บัตร เกินยอดไป ${baht(s.over)} — ทอนได้เฉพาะเงินสด แก้ยอดให้พอดี`;
    case 'payment_cash_unneeded': return 'มีเงินทอนแต่เงินสดที่รับไม่พอจะทอน — ตรวจยอดแต่ละช่องทางอีกครั้ง';
    default: return s.field === 'amount' ? 'ยอดเงินไม่ถูกต้อง — ใส่ตัวเลขมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง' : 'เลือกช่องทางชำระ';
  }
}

function surchargeLabel(c: PaymentChannel): string | null {
  const s = safeSatang(c.surchargePercent);
  return s > 0 ? `+${c.surchargePercent.replace(/\.00$/, '')}%` : null;
}

/**
 * รับเงิน + ปิดบิล (§5.3, Ice B1/B3). Locked until the bill was shown to the
 * customer and nothing changed since (B1). Buttons are the shop's own payment
 * channels (B3); one channel per kind, so the shortfall / change preview can
 * use the domain settle function the API uses. A surcharge channel shows its
 * surcharge on its own line and what to charge in total; the API computes the
 * real figures at close and the client never sends a total (AC-E6).
 */
export function PaymentPanel({ jobId, receipt, busy, guard, show, reload, onClosed }: PaymentPanelProps) {
  const channelsDoc = useDocument<PaymentChannelList>(PAYMENT_CHANNELS_PATH, 'payment-channel:changed');
  const channels = (channelsDoc.data?.items ?? []).filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const [typed, setTyped] = useState<Typed>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [failure, setFailure] = useState<BillFailure | null>(null);
  // P3.3: held deposits bound to this job, ticked to offset into the bill (each in full, §5.4 item 6).
  const deposits = receipt.deposits ?? null;
  const available = deposits?.available ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = available.filter((d) => picked.includes(d.depositId));
  const billSatang = safeSatang(receipt.totals.billTotal);
  // The domain's own plan, the one the API closes with: grand_total is NOT reduced, the deposits only
  // cover part of what is owed; above the bill is refused, never clamped.
  const plan = depositOffsetPlan(billSatang, chosen.map((d) => ({ id: d.depositId, amount: d.amount })));
  const planOk = 'due' in plan;
  const offsetTotal = planOk ? plan.offsetTotal : 0;
  const due = planOk ? plan.due : billSatang;
  const dueText = formatSatang(due);
  const rows = rowsOf(typed, channels);
  const entries = entriesOf(rows);
  // Deposits that cover the whole bill: nothing else to take (an entry then is refused: payment_not_needed).
  const coveredByDeposits = planOk && chosen.length > 0 && due === 0;
  const settlement = coveredByDeposits && entries.length === 0
    ? ({ ok: true, rows: [], netPaid: '0.00', change: '0.00', surchargeTotal: '0.00' } as PaymentSettlement)
    : settlePayments(due, entries);
  // Once the money settles, the surcharge shown is the settle function's own figure.
  const surchargeTotal = settlement.ok ? safeSatang(settlement.surchargeTotal) : sumSatang(rows.map((r) => r.surcharge));
  const next = receipt.next;
  const presented = isPresented(receipt);
  const ceilingBlocked = receipt.discount.exceedsCeiling && !next.canApproveOverCeiling;
  const anyBusy = busy !== null;
  const extraEntry = coveredByDeposits && entries.length > 0;
  const canClose = presented && next.canClose && planOk && settlement.ok && !extraEntry && !ceilingBlocked && !anyBusy;

  function toggleDeposit(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  function toggle(c: PaymentChannel) {
    setTyped((t) => {
      const copy = { ...t };
      if (copy[c.id] !== undefined) {
        delete copy[c.id];
        return copy;
      }
      // One channel per kind: picking "คลิก" (transfer) replaces "ออมสิน" (transfer).
      for (const other of channels) if (other.kind === c.kind) delete copy[other.id];
      copy[c.id] = '';
      return copy;
    });
  }

  /** "ยอดพอดี": the part of the bill not yet covered by the OTHER channels, from the domain settle function. */
  function fillRemaining(c: PaymentChannel) {
    const others = entriesOf(rows.filter((r) => r.channel.id !== c.id));
    const s = settlePayments(due, others);
    const remaining = others.length === 0 ? dueText : 'code' in s && s.code === 'payment_short' ? s.short : null;
    if (remaining !== null) setTyped((t) => ({ ...t, [c.id]: remaining }));
  }

  async function close(discountReason: string | undefined): Promise<void> {
    setFailure(null);
    const body: CloseReceiptInput = {
      payments: rows.filter((r) => r.text !== '').map((r) => ({ channelId: r.channel.id, amount: r.text })),
      depositIds: chosen.map((d) => d.depositId),
    };
    if (discountReason) body.discountReason = discountReason;
    const result = await guard('close', () => api.post<CloseReceiptResult>(`${receiptPath(jobId)}/close`, body));
    if (result.ok) {
      show(result.value.receipt);
      setConfirmOpen(false);
      setTyped({});
      setPicked([]);
      onClosed(result.value);
    } else if (!result.failure.cancelled) {
      setFailure(result.failure);
      // A channel was switched off or removed while this screen was open: fetch the buttons again.
      const code = result.failure.body?.error;
      if (code === 'channel_inactive' || code === 'channel_not_found') channelsDoc.reload?.();
      // A deposit was refunded / applied / detached meanwhile: forget the ticks and read the receipt again.
      if (code === 'deposit_not_held' || code === 'deposit_not_attached' || code === 'deposit_not_found') {
        setPicked([]);
        void reload();
      }
    }
  }

  const previewText = extraEntry
    ? 'มัดจำครอบคลุมยอดบิลทั้งหมดแล้ว — ไม่ต้องรับเงินช่องทางอื่น เอาช่องทางที่เลือกออก'
    : entries.length === 0 ? null : settlementText(settlement);

  return (
    <section className={`card bl-pay${presented ? '' : ' is-locked'}`} aria-label="รับเงินและปิดบิล">
      <h3>รับเงิน</h3>
      {!presented && (
        <p className="ci-nomatch bl-attn">แสดงยอดให้ลูกค้าก่อน (กด “แสดงยอดให้ลูกค้าแล้ว”) จึงจะรับเงินได้</p>
      )}
      <p className="bl-due">ยอดบิล <strong className="mono">{baht(receipt.totals.billTotal)}</strong></p>

      {/* P3.3: a held deposit matched to this customer but not bound to the job yet — attach first. */}
      {deposits && deposits.unattached.length > 0 && (
        <HeldDepositWarning warnings={deposits.unattached} jobId={jobId} canAttach onAttached={() => void reload()} />
      )}
      {available.length > 0 && (
        <fieldset className="dp-group dp-offsets" aria-label="หักมัดจำ">
          <legend className="ci-field-label">หักมัดจำของงานนี้</legend>
          {available.map((d) => {
            const on = picked.includes(d.depositId);
            return (
              <label key={d.depositId} className={`dp-offset${on ? ' is-on' : ''}`}>
                <input type="checkbox" checked={on} disabled={anyBusy || !presented} onChange={() => toggleDeposit(d.depositId)} />
                <span className="dp-offset-main">
                  <span>มัดจำ <strong className="mono">{baht(d.amount)}</strong>{d.slipNumber ? <> · <span className="mono">{d.slipNumber}</span></> : ' · (ยังไม่ได้พิมพ์ใบมัดจำ)'}</span>
                  <span className="qt-line-sub">รับเมื่อ {thaiDateTime(d.receivedAt)}{d.paymentChannelName ? ` · ทาง ${d.paymentChannelName}` : ''}</span>
                </span>
              </label>
            );
          })}
          {'code' in plan && plan.code === 'deposit_exceeds_bill' && (
            <p className="ci-form-error" role="alert">
              มัดจำที่เลือกมากกว่ายอดบิล {baht(formatSatang(plan.over))} — หักได้ไม่เกิน {baht(formatSatang(plan.max))} เลือกน้อยลง หรือคืนมัดจำส่วนนั้นที่หน้า “มัดจำค้างอยู่”
            </p>
          )}
          {chosen.length > 0 && planOk && (
            <dl className="bl-kv">
              <dt>หักมัดจำ</dt><dd className="mono">−{baht(formatSatang(offsetTotal))}</dd>
              <dt className="bl-strong">ลูกค้าต้องจ่ายเพิ่ม</dt><dd className="mono bl-strong">{baht(dueText)}</dd>
            </dl>
          )}
          <p className="qt-line-sub">มัดจำไม่ลดยอดบิล และไม่ใช่เงินเข้าวันนี้ (นับไปแล้ววันที่รับมัดจำ)</p>
        </fieldset>
      )}
      {coveredByDeposits && <p className="ci-match" role="status">มัดจำครอบคลุมยอดบิลทั้งหมด — ไม่ต้องรับเงินเพิ่ม กดปิดบิลได้เลย</p>}

      {channelsDoc.error && !channelsDoc.data && (
        <p className="ci-form-error" role="alert">
          โหลดช่องทางชำระไม่สำเร็จ <button type="button" className="btn secondary small" onClick={() => channelsDoc.reload?.()}>ลองใหม่</button>
        </p>
      )}
      {channelsDoc.data && channels.length === 0 && (
        <p className="ci-form-error" role="alert">สาขานี้ยังไม่ได้ตั้งช่องทางชำระ — ให้เจ้าของตั้งที่ ตั้งค่า › ช่องทางชำระ</p>
      )}

      <div className="bl-methods" role="group" aria-label="ช่องทางชำระ">
        {channels.map((c) => {
          const on = typed[c.id] !== undefined;
          const extra = surchargeLabel(c);
          return (
            <button
              key={c.id}
              type="button"
              className={`chip bl-method${on ? ' active' : ''}`}
              aria-pressed={on}
              disabled={anyBusy || !presented}
              onClick={() => toggle(c)}
            >
              {on && '✓ '}{c.name}{extra && <span className="bl-surcharge-tag"> {extra}</span>}
            </button>
          );
        })}
      </div>
      {presented && rows.length === 0 && channels.length > 0 && (
        <p className="qt-line-sub">เลือกช่องทางที่ลูกค้าจ่าย (จ่ายหลายทางได้ ช่องทางละหนึ่งประเภท)</p>
      )}

      {rows.map((r) => (
        <AmountField
          key={r.channel.id}
          row={r}
          disabled={anyBusy || !presented}
          onChange={(v) => setTyped((t) => ({ ...t, [r.channel.id]: v }))}
          onFill={() => fillRemaining(r.channel)}
        />
      ))}

      {settlement.ok && entries.length > 0 && (
        <div className="bl-change" role="status">
          {surchargeTotal > 0 && (
            <p>ค่าธรรมเนียมช่องทาง <strong className="mono">{baht(formatSatang(surchargeTotal))}</strong> · ยอดเรียกเก็บรวม <strong className="mono">{baht(formatSatang(sumSatang([due, surchargeTotal])))}</strong></p>
          )}
          {settlement.change !== '0.00' ? (
            <p>เงินทอน (เงินสด) <strong className="mono">{baht(settlement.change)}</strong></p>
          ) : (
            <p>รับครบพอดี ไม่มีเงินทอน</p>
          )}
        </div>
      )}
      {previewText && <p className="ci-form-error" role="alert">{previewText}</p>}

      {next.blockers.length > 0 && receipt.status === 'draft' && (
        <ul className="bl-blockers" aria-label="สิ่งที่ยังต้องทำก่อนปิดบิล">
          {next.blockers.filter((b) => BLOCKER_TEXT[b]).map((b) => <li key={b}>{BLOCKER_TEXT[b]}</li>)}
        </ul>
      )}
      {ceilingBlocked && <p className="qt-line-sub">ส่วนลดเกินเพดาน — ผู้จัดการ รองผู้จัดการ หรือเจ้าของต้องเข้าระบบด้วยชื่อตัวเองแล้วกดปิดบิล</p>}
      {failure && !confirmOpen && <p className="ci-form-error" role="alert">{failure.text}</p>}

      <button type="button" className="btn hazard block" disabled={!canClose} onClick={() => { setFailure(null); setConfirmOpen(true); }}>
        ปิดบิล
      </button>

      {confirmOpen && settlement.ok && (
        <CloseConfirmDialog
          receipt={receipt}
          rows={rows.filter((r) => r.text !== '')}
          offsets={chosen}
          dueText={dueText}
          change={settlement.change}
          surchargeTotal={surchargeTotal}
          busy={busy === 'close'}
          failure={failure}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(reason) => void close(reason)}
        />
      )}
    </section>
  );
}

function AmountField({ row, disabled, onChange, onFill }: {
  row: Row; disabled: boolean; onChange: (v: string) => void; onFill: () => void;
}) {
  const id = useId();
  const bad = row.text !== '' && row.satang === null;
  const hasSurcharge = safeSatang(row.channel.surchargePercent) > 0;
  return (
    <div className="bl-amount">
      <label className={`field${bad ? ' has-error' : ''}`} htmlFor={id}>
        <span>
          {row.channel.name} — {row.channel.kind === 'cash' ? 'เงินที่ลูกค้ายื่นมา (บาท)' : hasSurcharge ? 'ส่วนของยอดบิลที่จ่ายทางนี้ (บาท)' : 'ยอดที่รับ (บาท)'}
        </span>
        <input id={id} inputMode="decimal" value={row.text} disabled={disabled} aria-invalid={bad ? true : undefined} onChange={(e) => onChange(e.target.value)} />
        {bad && <span className="ci-field-error">ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง</span>}
        {hasSurcharge && row.satang !== null && (
          <span className="qt-line-sub">
            ค่าธรรมเนียม {row.channel.surchargePercent.replace(/\.00$/, '')}% = {baht(formatSatang(row.surcharge))} · เรียกเก็บทางนี้ {baht(formatSatang(sumSatang([row.satang, row.surcharge])))}
          </span>
        )}
      </label>
      <button type="button" className="btn secondary small" disabled={disabled} onClick={onFill}>ยอดพอดี</button>
    </div>
  );
}

function CloseConfirmDialog({ receipt, rows, offsets, dueText, change, surchargeTotal, busy, failure, onCancel, onConfirm }: {
  receipt: Receipt;
  rows: Row[];
  offsets: DepositWarning[];
  dueText: string;
  change: string;
  surchargeTotal: number;
  busy: boolean;
  failure: BillFailure | null;
  onCancel: () => void;
  onConfirm: (discountReason: string | undefined) => void;
}) {
  const id = useId();
  const d = receipt.discount;
  // Above the ceiling the closer types the reason personally (B4); otherwise only when the draft has none yet.
  const askReason = d.exceedsCeiling || (d.reasonRequired && !d.reason);
  const [reason, setReason] = useState(d.exceedsCeiling ? '' : d.reason ?? '');
  const [touched, setTouched] = useState(false);
  const missing = askReason && reason.trim() === '';

  return (
    <Modal
      title="ยืนยันปิดบิล"
      onClose={() => { if (!busy) onCancel(); }}
      footer={(
        <div className="row-flex">
          <button
            type="button"
            className="btn hazard"
            disabled={busy}
            onClick={() => { setTouched(true); if (!missing) onConfirm(askReason ? reason.trim() : undefined); }}
          >
            {busy ? 'กำลังปิดบิล...' : 'ยืนยัน ปิดบิลและออกใบเสร็จ'}
          </button>
          <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>กลับไปแก้</button>
        </div>
      )}
    >
      <div className="bl-confirm">
        {failure && <p className="ci-form-error" role="alert">{failure.text}</p>}
        <dl className="bl-kv">
          <dt>ยอดบิล</dt><dd className="mono">{baht(receipt.totals.billTotal)}</dd>
          {offsets.map((d) => (
            <Fragment key={d.depositId}>
              <dt>หักมัดจำ {d.slipNumber ?? ''}</dt><dd className="mono">−{baht(d.amount)}</dd>
            </Fragment>
          ))}
          {offsets.length > 0 && (<><dt>ลูกค้าต้องจ่ายเพิ่ม</dt><dd className="mono">{baht(dueText)}</dd></>)}
          {rows.map((r) => (
            <Fragment key={r.channel.id}>
              <dt>{r.channel.name}</dt><dd className="mono">{baht(r.text)}</dd>
            </Fragment>
          ))}
          {surchargeTotal > 0 && (<><dt>ค่าธรรมเนียมช่องทาง (แยกจากยอดบิล)</dt><dd className="mono">{baht(formatSatang(surchargeTotal))}</dd></>)}
          <dt>เงินทอน</dt><dd className="mono bl-strong">{baht(change)}</dd>
        </dl>
        {askReason && (
          <label className={`field${touched && missing ? ' has-error' : ''}`} htmlFor={id}>
            <span>
              เหตุผลของส่วนลด {d.percent}%{d.exceedsCeiling ? ` (เกินเพดาน ${d.ceilingPercent}% — คุณเป็นผู้อนุมัติ)` : ''}
            </span>
            <textarea id={id} className="qt-textarea" rows={2} maxLength={500} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
            {touched && missing && <span className="ci-field-error">จำเป็นต้องกรอก</span>}
            {failure?.fields.discountReason && <span className="ci-field-error">{failure.fields.discountReason}</span>}
          </label>
        )}
        <p className="qt-line-sub">ปิดบิลแล้วแก้ยอดหรือช่องทางไม่ได้ — ถ้าผิดต้องให้เจ้าของยกเลิกใบเสร็จ</p>
      </div>
    </Modal>
  );
}
