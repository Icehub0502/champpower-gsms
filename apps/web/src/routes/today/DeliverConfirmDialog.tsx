import type { TodayJob } from '@gsms/contracts/index.js';
import { Modal } from '../../components/ui/Modal';

interface DeliverConfirmDialogProps {
  job: TodayJob;
  busy: boolean;
  errorText: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * DECISION-carout.md §2: every ready -> delivered asks first, once, because the
 * card leaves the board the moment it is confirmed. One dialog for every way
 * of getting here (the card's action sheet today; a drop target if one is ever
 * added) — TodayPage routes them all through it, so no path can skip the ask.
 */
export function DeliverConfirmDialog({ job, busy, errorText, onConfirm, onCancel }: DeliverConfirmDialogProps) {
  const title = [job.brand, job.model].filter(Boolean).join(' ') || 'ไม่ระบุรุ่น';
  const car = [title, job.plate].filter(Boolean).join(' · ');
  return (
    <Modal title={`ส่งแล้ว — ${job.jobNumber}`} onClose={busy ? () => {} : onCancel}>
      <section className="kb-sheet-confirm kb-deliver-confirm" role="alertdialog" aria-labelledby="kb-deliver-title">
        <h4 id="kb-deliver-title">ยืนยันว่ารถออกจากอู่แล้ว</h4>
        {errorText && (
          <p className="kb-sheet-error" role="alert">
            {errorText}
          </p>
        )}
        <p>
          <strong>{car}</strong> ({job.jobNumber}) จะเปลี่ยนเป็น “ส่งแล้ว” และ<strong>หายจากกระดานทันที</strong>
        </p>
        <p className="kb-sheet-hint">กดผิดแก้ได้: ใช้ปุ่ม “ส่งแล้ววันนี้” ด้านบนของหน้านี้ (ต้องระบุเหตุผลที่ย้อนกลับ)</p>
        <div className="row-flex">
          <button type="button" className="btn" disabled={busy} onClick={onConfirm}>
            {busy ? 'กำลังบันทึก…' : 'ยืนยัน รถออกแล้ว'}
          </button>
          <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>
            ยกเลิก
          </button>
        </div>
      </section>
    </Modal>
  );
}
