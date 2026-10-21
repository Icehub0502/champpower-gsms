import { Link } from 'react-router-dom';
import type { CheckInResult } from '@gsms/contracts/index.js';
import { useAuth } from '../../hooks/useAuth';
import { JobDepositsCard } from '../deposits/JobDepositsCard';
import { canWriteDeposit } from '../deposits/depositLabels';

interface CheckInDepositStepProps {
  result: CheckInResult;
  customerName: string | null;
  /** The counter pressed "บันทึก แล้วรับมัดจำ": the dialog opens by itself. */
  openDialog: boolean;
  onDone: () => void;
}

/**
 * Right after a check-in saved, when there is deposit work to do (P3.3,
 * CLAUDE.md §5.4 item 3): this customer still has a held deposit — attach it to
 * the new job here, while the person is at the counter — or the counter asked
 * to take a deposit for the job. The job exists already; leaving is one tap.
 */
export function CheckInDepositStep({ result, customerName, openDialog, onDone }: CheckInDepositStepProps) {
  const auth = useAuth();
  const canWrite = canWriteDeposit(auth.role);
  return (
    <div className="page ci-page">
      <header className="ci-header">
        <h1>รับรถแล้ว · คิว {result.queueNo}</h1>
        <p className="page-sub">บันทึกใบงานเรียบร้อย{customerName ? ` — ${customerName}` : ''}</p>
      </header>

      <JobDepositsCard jobId={result.jobId} againstTotal={null} who={customerName} canWrite={canWrite} initiallyOpen={openDialog} />

      <div className="ci-actions dp-step-actions">
        <Link className="btn secondary" to={`/jobs/${encodeURIComponent(result.jobId)}/quote`}>ไปใบเสนอราคา</Link>
        <button type="button" className="btn ci-submit" onClick={onDone}>เสร็จ ไปงานวันนี้</button>
      </div>
    </div>
  );
}
