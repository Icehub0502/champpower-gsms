import { useRef, useState } from 'react';
import { depositOffsetPlan, formatSatang, toSatang } from '@champpower/domain';
import type { DetachDepositInput, Deposit, DepositWarning, JobDeposits } from '@gsms/contracts/index.js';
import { DepositSlipPrintButton } from '../../components/print/DepositSlipPrintButton';
import { ReasonDialog } from '../../components/ui/ReasonDialog';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { baht } from '../../lib/money';
import { dateKeyThai, thaiDateTime } from '../../lib/printFormat';
import { describeDepositError } from './depositErrors';
import { HeldDepositWarning, warningsTotal } from './HeldDepositWarning';
import { DEPOSIT_REASON_LABEL, DEPOSIT_SOCKET_EVENT, depositPath, jobDepositsPath } from './depositLabels';
import { TakeDepositDialog } from './TakeDepositDialog';

interface JobDepositsCardProps {
  jobId: string;
  /** The total the deposits are set against (the quotation's ยอดที่อนุมัติ), as the server sent it; null = none yet. */
  againstTotal: string | null;
  againstLabel?: string;
  /** Whose job it is, for the dialog title. */
  who: string | null;
  canWrite: boolean;
  /** Mutations elsewhere on the page are in flight: the buttons wait. */
  disabled?: boolean;
  /** Open the "รับมัดจำ" dialog straight away (check-in: "บันทึก แล้วรับมัดจำ"). */
  initiallyOpen?: boolean;
}

function safeSatang(v: string | null): number | null {
  if (v === null) return null;
  try {
    return toSatang(v);
  } catch {
    return null;
  }
}

/**
 * Deposits of one job, on the quotation (and check-in) page: the held-deposit
 * warning with its attach button (§5.4 item 3), what is already bound to the
 * job — "รับมัดจำแล้ว ฿X (DEP-…)" — with the balance left after it (item 4b),
 * and the "รับมัดจำ" button. Every amount is the server's; the balance is the
 * domain's depositOffsetPlan, the same one the API closes the bill with.
 */
export function JobDepositsCard({
  jobId, againstTotal, againstLabel = 'ยอดที่อนุมัติ', who, canWrite, disabled, initiallyOpen = false,
}: JobDepositsCardProps) {
  const doc = useDocument<JobDeposits>(jobDepositsPath(jobId), DEPOSIT_SOCKET_EVENT);
  const [open, setOpen] = useState(initiallyOpen && canWrite);
  const [detaching, setDetaching] = useState<DepositWarning | null>(null);
  const data = doc.data;
  const attached = (data?.warnings ?? []).filter((w) => w.attachedToThisJob);
  const attachedTotal = warningsTotal(attached);
  const against = safeSatang(againstTotal);
  const plan = against !== null && attached.length > 0
    ? depositOffsetPlan(against, attached.map((w) => ({ id: w.depositId, amount: w.amount })))
    : null;

  return (
    <>
      {data && <HeldDepositWarning warnings={data.warnings} jobId={jobId} canAttach={canWrite} onAttached={() => doc.reload?.()} />}

      <section className="card dp-job" aria-label="มัดจำของงานนี้">
        <div className="dp-job-head">
          <h3>มัดจำ</h3>
          {canWrite && (
            <button type="button" className="btn secondary small" disabled={disabled} onClick={() => setOpen(true)}>
              รับมัดจำ
            </button>
          )}
        </div>
        {doc.error && !data && (
          <p className="ci-nomatch" role="status">
            โหลดข้อมูลมัดจำไม่สำเร็จ <button type="button" className="btn secondary small" onClick={() => doc.reload?.()}>ลองใหม่</button>
          </p>
        )}
        {data && attached.length === 0 && data.applied.length === 0 && <p className="qt-line-sub">ยังไม่มีมัดจำผูกกับงานนี้</p>}

        {attached.length > 0 && (
          <>
            <ul className="dp-list">
              {attached.map((w) => (
                <li key={w.depositId} className="dp-list-row">
                  <div className="dp-list-main">
                    <span>รับมัดจำแล้ว <strong className="mono">{baht(w.amount)}</strong>{w.slipNumber && <> (<span className="mono">{w.slipNumber}</span>)</>}</span>
                    <span className="qt-line-sub">
                      {DEPOSIT_REASON_LABEL[w.reason]} · รับเมื่อ {thaiDateTime(w.receivedAt)} · นัด {dateKeyThai(w.expectedDate)}
                      {!w.slipNumber && ' · ยังไม่ได้พิมพ์ใบรับเงินมัดจำ'}
                    </span>
                  </div>
                  {canWrite && (
                    <div className="dp-row-actions">
                    <button type="button" className="btn secondary small" disabled={disabled} onClick={() => setDetaching(w)}>
                      ถอดมัดจำออกจากงาน
                    </button>
                    <DepositSlipPrintButton depositId={w.depositId} className="btn secondary small" disabled={disabled}
                      label={w.slipNumber ? 'พิมพ์ใบมัดจำ' : 'พิมพ์ใบมัดจำ (ออกเลข DEP)'} onPrinted={() => doc.reload?.()} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <dl className="bl-kv">
              <dt>รับมัดจำแล้วรวม</dt><dd className="mono">{baht(formatSatang(attachedTotal))}</dd>
              {againstTotal !== null && (<><dt>{againstLabel}</dt><dd className="mono">{baht(againstTotal)}</dd></>)}
            </dl>
            {plan && 'due' in plan && (
              <p className="qt-totals-sum">ยอดคงเหลือที่ลูกค้าต้องจ่าย <span className="mono">{baht(formatSatang(plan.due))}</span></p>
            )}
            {plan && 'code' in plan && plan.code === 'deposit_exceeds_bill' && (
              <p className="ci-nomatch">มัดจำมากกว่า{againstLabel}อยู่ {baht(formatSatang(plan.over))} — ตอนปิดบิลหักได้ไม่เกินยอดบิล ส่วนเกินต้องคืนลูกค้า</p>
            )}
            <p className="qt-line-sub">มัดจำไม่ลดยอดบิล — หักเป็นการรับชำระตอนปิดบิล</p>
          </>
        )}

        {data && data.applied.length > 0 && (
          <ul className="dp-list">
            {data.applied.map((d) => (
              <li key={d.id} className="dp-list-row is-applied">
                <span>
                  หักเข้าบิลแล้ว <strong className="mono">{baht(d.amount)}</strong>
                  {d.slip && <> (<span className="mono">{d.slip.number}</span>)</>}
                  {d.appliedToReceiptNumber && <span className="qt-line-sub"> · ใบเสร็จ {d.appliedToReceiptNumber}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detaching && (
        <DetachDialog deposit={detaching} onClose={() => setDetaching(null)} onDone={() => { setDetaching(null); doc.reload?.(); }} />
      )}

      {open && (
        <TakeDepositDialog jobId={jobId} who={who} onClose={() => setOpen(false)} onSaved={() => doc.reload?.()} />
      )}
    </>
  );
}

/**
 * Undo a wrong attach. The reason is mandatory and goes to the audit log. The server decides whether it is
 * still allowed (deposit_not_held, deposit_job_mismatch, deposit_locked...); its refusal is shown in Thai
 * and, when the card is stale, the card reloads. Same role rule as attach (the write roles).
 */
function DetachDialog({ deposit: w, onClose, onDone }: { deposit: DepositWarning; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  async function detach(reason: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const body: DetachDepositInput = { reason };
      await api.post<Deposit>(`${depositPath(w.depositId)}/detach`, body);
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

  return (
    <ReasonDialog
      title="ถอดมัดจำออกจากงาน"
      confirmLabel="ยืนยันถอดออก"
      required
      busy={busy}
      errorText={error}
      fieldError={fieldError}
      reasonLabel="เหตุผลที่ถอดออก (จำเป็น)"
      onCancel={onClose}
      onConfirm={(reason) => void detach(reason ?? '')}
    >
      <p>ถอดมัดจำ <strong className="mono">{baht(w.amount)}</strong> ออกจากงานนี้ — เงินยังเป็นมัดจำค้างอยู่ของลูกค้า ผูกเข้างานอื่นได้ภายหลัง</p>
    </ReasonDialog>
  );
}
