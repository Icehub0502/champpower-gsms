import { useRef, useState } from 'react';
import { DEPOSIT_SLIP_TITLE, DEPOSIT_STATUS_LABEL } from '@champpower/domain';
import type { CreateDepositSlipInput, DepositSlipHistory, DepositSlipPrint } from '@gsms/contracts/index.js';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../lib/api/client';
import { describeDepositError } from '../../routes/deposits/depositErrors';
import { depositPath } from '../../routes/deposits/depositLabels';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { DepositSlipSheet } from './DepositSlipSheet';
import { PrintCopies } from './PrintCopies';

interface DepositSlipPrintButtonProps {
  depositId: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  /** Called after the server recorded the print (the DEP number exists from the first print on). */
  onPrinted?: (print: DepositSlipPrint) => void;
}

/**
 * "พิมพ์ใบรับเงินมัดจำ" — the same flow as PrintButton (DECISION-2026-10-15 §2):
 * read the history; if the content changed since the last print, warn and wait;
 * then record the print (POST /api/deposits/:id/slip), which numbers the slip
 * DEP-xxxx the first time and answers with the frozen content to print. The
 * paper is rendered only from that answer, so the N on it is the server's.
 */
export function DepositSlipPrintButton({
  depositId, label = 'พิมพ์ใบรับเงินมัดจำ (2 ชุด)', disabled, className, onPrinted,
}: DepositSlipPrintButtonProps) {
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<{ printCount: number } | null>(null);
  const [job, setJob] = useState<DepositSlipPrint | null>(null);

  async function start(acknowledgeChange: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!acknowledgeChange) {
        const history = await api.get<DepositSlipHistory>(`${depositPath(depositId)}/slip?limit=1`);
        if (history.contentChangedSinceLastPrint && history.printCount > 0) {
          setWarning({ printCount: history.printCount });
          return;
        }
      }
      setWarning(null);
      const body: CreateDepositSlipInput = { copySet: 'customer_shop', acknowledgeChange };
      const print = await api.post<DepositSlipPrint>(`${depositPath(depositId)}/slip`, body);
      setJob(print);
      onPrinted?.(print);
    } catch (err) {
      const failure = describeDepositError(err);
      if (failure.cancelled) return;
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

  // A slip printed after the deposit left 'held' says so beside the title.
  const extraStamps = job && job.statusAtPrint !== 'held' ? [DEPOSIT_STATUS_LABEL[job.statusAtPrint]] : [];

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
          title="พิมพ์ใบรับเงินมัดจำอีกครั้ง"
          onClose={() => { if (!busy) setWarning(null); }}
          footer={(
            <div className="row-flex">
              <button type="button" className="btn hazard" disabled={busy} onClick={() => void start(true)}>
                {busy ? 'กำลังเตรียมพิมพ์...' : 'รับทราบ พิมพ์ใบใหม่'}
              </button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setWarning(null)}>ยกเลิก</button>
            </div>
          )}
        >
          <p className="ci-form-error" role="alert">
            ใบนี้เคยพิมพ์ไปแล้ว {warning.printCount} ครั้ง เนื้อหาเปลี่ยนหลังจากนั้น (เช่น คืนหรือหักมัดจำไปแล้ว) — เก็บใบเก่าคืนจากลูกค้า
          </p>
        </Modal>
      )}

      {job && (
        <PrintCopies
          result={{ ...job, mark: null }}
          extraStamps={extraStamps}
          shopName={auth.shop?.name ?? ''}
          // The server's title (pinned to the one allowed literal); the domain constant only if it is somehow absent.
          title={job.content.title || DEPOSIT_SLIP_TITLE}
          documentNumber={job.content.number}
          onDone={() => setJob(null)}
        >
          <DepositSlipSheet content={job.content} />
        </PrintCopies>
      )}
    </>
  );
}
