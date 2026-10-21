import { useRef, useState, type ReactNode } from 'react';
import type { CreatePrintInput, PrintDocType, PrintHistory, PrintResult } from '@gsms/contracts/index.js';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../lib/api/client';
import { describeBillError } from '../../routes/bill/billErrors';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { PrintCopies } from './PrintCopies';

export function printsPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/prints`;
}

interface PrintButtonProps<D> {
  jobId: string;
  docType: PrintDocType;
  label: string;
  title: string;
  /** Fetches the content fresh, right before the print is recorded — the paper shows what the server holds now. */
  loadData: () => Promise<D>;
  documentNumber: (data: D) => string | null;
  render: (data: D) => ReactNode;
  disabled?: boolean;
  className?: string;
}

type Warning = { printCount: number };

/**
 * "พิมพ์" for one document (DECISION-2026-10-15 §2, AC-G3..G6):
 *
 *  1. read the print history; if the content changed since the last print,
 *     stop and say "ใบนี้เคยพิมพ์ไปแล้ว N ครั้ง ..." until the person accepts;
 *  2. fetch the content fresh;
 *  3. record the print on the server (POST /prints) — the N on the paper is
 *     the server's count, never one the browser made up (AC-G11);
 *  4. only then render the copies and open the browser's print dialog.
 *
 * If step 3 fails nothing is printed: a paper whose N is not in the history must not exist.
 */
export function PrintButton<D>({
  jobId, docType, label, title, loadData, documentNumber, render, disabled, className,
}: PrintButtonProps<D>) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<Warning | null>(null);
  const [job, setJob] = useState<{ result: PrintResult; data: D } | null>(null);

  async function record(acknowledgeChange: boolean) {
    const data = await loadData();
    const body: CreatePrintInput = { docType, copySet: 'customer_shop', acknowledgeChange };
    const result = await api.post<PrintResult>(printsPath(jobId), body);
    setJob({ result, data });
  }

  async function start(acknowledgeChange: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!acknowledgeChange) {
        const history = await api.get<PrintHistory>(`${printsPath(jobId)}?docType=${docType}&limit=1`);
        if (history.contentChangedSinceLastPrint && history.printCount > 0) {
          setWarning({ printCount: history.printCount });
          return;
        }
      }
      setWarning(null);
      await record(acknowledgeChange);
    } catch (err) {
      const failure = describeBillError(err);
      if (failure.cancelled) return;
      // Someone printed or changed it between our read and our record: same warning, same choice.
      if (failure.body?.error === 'print_content_changed') {
        setWarning({ printCount: failure.body.printCount });
        return;
      }
      setError(`พิมพ์ไม่ได้: ${failure.text}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={className ?? 'btn secondary'}
        disabled={disabled || busy || job !== null}
        onClick={() => void start(false)}
      >
        <Icon name="printer" size={15} /> {busy ? 'กำลังเตรียมพิมพ์...' : label}
      </button>
      {error && <p className="ci-form-error" role="alert">{error}</p>}

      {warning && (
        <Modal
          title={`พิมพ์${title}อีกครั้ง`}
          onClose={() => { if (!busy) setWarning(null); }}
          footer={(
            <div className="row-flex">
              <button type="button" className="btn hazard" disabled={busy} onClick={() => void start(true)}>
                {busy ? 'กำลังเตรียมพิมพ์...' : 'รับทราบ พิมพ์ใบใหม่'}
              </button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setWarning(null)}>
                ยกเลิก
              </button>
            </div>
          )}
        >
          <p className="ci-form-error" role="alert">
            ใบนี้เคยพิมพ์ไปแล้ว {warning.printCount} ครั้ง เนื้อหาเปลี่ยนหลังจากนั้น — เก็บใบเก่าคืนจากลูกค้า
          </p>
          <p className="page-sub">กระดาษเก่ากับใบใหม่มีเลขเดียวกันแต่เนื้อหาต่างกัน ถ้าไม่เก็บคืน จะมีกระดาษสองแบบอยู่กับลูกค้า</p>
        </Modal>
      )}

      {job && (
        <PrintCopies
          result={job.result}
          shopName={auth.shop?.name ?? ''}
          title={title}
          documentNumber={job.result.documentNumber ?? documentNumber(job.data)}
          onDone={() => setJob(null)}
        >
          {render(job.data)}
        </PrintCopies>
      )}
    </>
  );
}
