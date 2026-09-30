import { useEffect, useRef, useState } from 'react';
import type { JobDetail } from '@gsms/contracts/index.js';
import { Icon } from '../../components/ui/Icon';
import { Modal } from '../../components/ui/Modal';
import { DELIVERED_PAGE_SIZE, useDeliveredJobs } from './useDeliveredData';
import { DeliveredJobDetail, formatWhen } from './DeliveredJobDetail';

function DeliveredList({
  page,
  onPage,
  onOpen,
}: {
  page: number;
  onPage: (page: number) => void;
  onOpen: (jobId: string) => void;
}) {
  const { state, reload } = useDeliveredJobs(page);

  const total = state.kind === 'ok' ? state.data.total : 0;
  const pageCount = Math.max(1, Math.ceil(total / DELIVERED_PAGE_SIZE));
  const emptyPastEnd = state.kind === 'ok' && state.data.items.length === 0 && total > 0 && page > pageCount;

  // The last card on the last page was just taken back: land on the new last page.
  useEffect(() => {
    if (emptyPastEnd) onPage(pageCount);
  }, [emptyPastEnd, pageCount, onPage]);

  if (state.kind === 'loading' || emptyPastEnd) {
    return <p className="page-loading" role="status">กำลังโหลดรายการ…</p>;
  }
  if (state.kind === 'error') {
    return (
      <div className="empty-state" role="alert">
        โหลดรายการที่ส่งแล้วไม่สำเร็จ
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn secondary" onClick={() => void reload()}>
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  const { items } = state.data;
  if (total === 0) {
    return <p className="empty-state">วันนี้ยังไม่มีรถที่ส่งแล้ว</p>;
  }

  return (
    <>
      <p className="kb-dl-count" role="status">
        ส่งแล้ววันนี้ {total} คัน · หน้า {page} จาก {pageCount}
      </p>
      <ul className="kb-dl-list">
        {items.map((it) => {
          const car = [it.brand, it.model].filter(Boolean).join(' ') || 'ไม่ระบุรุ่น';
          return (
            <li key={it.jobId}>
              <button type="button" className="kb-dl-item" onClick={() => onOpen(it.jobId)}>
                <span className="kb-dl-item-top">
                  <span className="kb-dl-plate">{it.plate ?? '—'}</span>
                  <span className="kb-dl-time">ส่งเมื่อ {formatWhen(it.deliveredAt)}</span>
                </span>
                <span className="kb-dl-item-car">{car}</span>
                <span className="kb-dl-item-meta">
                  <span className="mono">{it.jobNumber}</span>
                  {it.customerName && <span> · คุณ{it.customerName}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {pageCount > 1 && (
        <nav className="kb-dl-pager" aria-label="เปลี่ยนหน้า">
          <button type="button" className="btn secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <Icon name="back" size={14} /> ก่อนหน้า
          </button>
          <button type="button" className="btn secondary" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
            ถัดไป <Icon name="forward" size={14} />
          </button>
        </nav>
      )}
    </>
  );
}

interface DeliveredPanelProps {
  onClose: () => void;
  /** A delivery was taken back: the board must reload so the card reappears. */
  onUndone: (detail: JobDetail) => void;
}

/**
 * "ส่งแล้ววันนี้" — where a mistaken ส่งแล้ว is found and undone (DECISION-carout
 * §3). The card is gone from /today the moment it is pressed, so this list is
 * the only way back to it. List -> job -> (reason dialog) all live inside one
 * modal, so at 390px it is one full-width surface, not stacked overlays.
 */
export function DeliveredPanel({ onClose, onUndone }: DeliveredPanelProps) {
  const [page, setPage] = useState(1);
  const [jobId, setJobId] = useState<string | null>(null);
  // Esc and the backdrop must not abandon an undo that is on the wire: the
  // answer would arrive with nobody looking at it.
  const busyRef = useRef(false);

  return (
    <Modal
      title={jobId ? 'รายละเอียดงานที่ส่งแล้ว' : 'ส่งแล้ววันนี้'}
      onClose={() => {
        if (!busyRef.current) onClose();
      }}
    >
      <div className="kb-dl-root">
        {jobId ? (
          <DeliveredJobDetail
            jobId={jobId}
            onBack={() => setJobId(null)}
            onUndone={onUndone}
            onBusyChange={(b) => {
              busyRef.current = b;
            }}
          />
        ) : (
          <DeliveredList page={page} onPage={setPage} onOpen={setJobId} />
        )}
      </div>
    </Modal>
  );
}
