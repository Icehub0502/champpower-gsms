import { useRef, useState } from 'react';
import { sumSatang, toSatang, formatSatang } from '@champpower/domain';
import type { AttachDepositInput, Deposit, DepositWarning } from '@gsms/contracts/index.js';
import { baht } from '../../lib/money';
import { api } from '../../lib/api/client';
import { dateKeyThai, thaiDateTime } from '../../lib/printFormat';
import { describeDepositError } from './depositErrors';
import { DEPOSIT_CHANNEL_LABEL, DEPOSIT_REASON_LABEL, depositPath } from './depositLabels';

/** Σ of the warnings' amounts in satang, through the domain parser; 0 if any value is not money. */
export function warningsTotal(warnings: readonly DepositWarning[]): number {
  try {
    return sumSatang(warnings.map((w) => toSatang(w.amount)));
  } catch {
    return 0;
  }
}

interface HeldDepositWarningProps {
  warnings: DepositWarning[];
  /** The job to attach to; null before the job exists (the phone lookup at check-in): no button then. */
  jobId: string | null;
  /** Read-only roles see the warning but get no button. */
  canAttach: boolean;
  onAttached?: (deposit: Deposit) => void;
}

/**
 * "ลูกค้ารายนี้มีมัดจำค้าง ฿X (โอนมาเมื่อ ...)" — CLAUDE.md §5.4 item 3. Shown
 * prominently wherever a job is opened or viewed: if the counter is not told,
 * they take the full amount and the customer who already paid is charged twice.
 * Each held deposit has its own "ผูกเข้างานนี้" button (POST /attach).
 */
export function HeldDepositWarning({ warnings, jobId, canAttach, onAttached }: HeldDepositWarningProps) {
  const pending = warnings.filter((w) => !w.attachedToThisJob);
  const [busyId, setBusyId] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (pending.length === 0) return null;
  const total = formatSatang(warningsTotal(pending));

  async function attach(depositId: string) {
    if (busyRef.current || !jobId) return;
    busyRef.current = true;
    setBusyId(depositId);
    setError(null);
    try {
      const body: AttachDepositInput = { jobId };
      const deposit = await api.post<Deposit>(`${depositPath(depositId)}/attach`, body);
      onAttached?.(deposit);
    } catch (err) {
      const failure = describeDepositError(err);
      if (!failure.cancelled) setError(failure.text);
    } finally {
      busyRef.current = false;
      setBusyId(null);
    }
  }

  return (
    <section className="card dp-warning" role="alert" aria-label="มัดจำค้าง">
      <h3>ลูกค้ารายนี้มีมัดจำค้าง <span className="mono">{baht(total)}</span></h3>
      <ul className="dp-warning-list">
        {pending.map((w) => (
          <li key={w.depositId} className="dp-warning-row">
            <div className="dp-warning-main">
              <strong className="mono">{baht(w.amount)}</strong>{' '}
              <span>(โอนมาเมื่อ {thaiDateTime(w.receivedAt)})</span>
              <span className="qt-line-sub">
                {DEPOSIT_REASON_LABEL[w.reason]} · ติดต่อทาง {DEPOSIT_CHANNEL_LABEL[w.channel]}
                {w.paymentChannelName ? ` · รับทาง ${w.paymentChannelName}` : ''}
                {w.slipNumber ? ` · ${w.slipNumber}` : ''}
                {' · '}นัดไว้ {dateKeyThai(w.expectedDate)}{w.overdue ? ' (เลยวันนัดแล้ว)' : ''}
                {w.matchedBy === 'phone' ? ' · พบจากเบอร์โทร ตรวจว่าเป็นคนเดียวกัน' : ''}
              </span>
            </div>
            {jobId && canAttach && (
              <button type="button" className="btn hazard small" disabled={busyId !== null} onClick={() => void attach(w.depositId)}>
                {busyId === w.depositId ? 'กำลังผูก...' : 'ผูกเข้างานนี้'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!jobId && <p className="qt-line-sub">บันทึกรับรถก่อน แล้วผูกมัดจำเข้างานได้ทันทีหลังบันทึก</p>}
      {jobId && <p className="qt-line-sub">ผูกแล้ว จะหักมัดจำได้ตอนรับเงินที่หน้าเก็บเงิน</p>}
      {error && <p className="ci-form-error">{error}</p>}
    </section>
  );
}
