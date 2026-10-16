import { useState } from 'react';
import {
  SUB_STATES_BY_STATUS,
  SUB_STATE_LABEL,
  statusOf,
  type StatusKey,
  type SubState,
} from '@champpower/domain';
import type { TodayJob } from '@gsms/contracts/index.js';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/ui/Icon';
import { Modal } from '../../components/ui/Modal';
import { leavesBoard } from './legalMoves';

interface CardActionSheetProps {
  job: TodayJob;
  busy: boolean;
  errorText: string | null;
  /** Where "ใบเสนอราคา" goes, or null/absent for a role that sees no prices (technician). */
  quoteHref?: string | null;
  onClose: () => void;
  onMoveStatus: (to: StatusKey) => void;
  onSetSubState: (subState: SubState | null) => void;
}

/** What a closing move means, in the words staff would use to the customer. */
const CLOSING_EXPLANATION: Partial<Record<StatusKey, string>> = {
  rejected: 'ลูกค้าไม่อนุมัติใบเสนอราคา',
  carout: 'ลูกค้าเปลี่ยนใจก่อนเสนอราคา',
};

/** Under a closing button: when it is the right one (DECISION-carout.md §1). */
const CLOSING_HELPER: Partial<Record<StatusKey, string>> = {
  carout: 'ลูกค้าเปลี่ยนใจก่อนเสนอราคา',
};

/** A plain word for the one move whose label alone would hide what it skips. */
function moveLabel(from: StatusKey, to: StatusKey): string {
  if (from === 'repairing' && to === 'ready') return `${statusOf(to).label} (ไม่ต้องตั้งศูนย์)`;
  // The ellipsis says a question follows (TodayPage asks before ส่งแล้ว).
  if (to === 'delivered') return `${statusOf(to).label}…`;
  return statusOf(to).label;
}

/**
 * The tap menu (figma-80 brief + the work order): every card opens this on
 * tap, and it is the ONLY way to change a job on phones — dragging a single
 * kanban column at a time on a 390px screen is not a realistic gesture, and
 * some staff will never try dragging at all. Desktop/tablet users reach the
 * same menu; drag is a shortcut on top of it, not a separate feature.
 *
 * Both actions call the same two endpoints a drag calls
 * (PATCH /api/jobs/:id/status, PATCH /api/jobs/:id/sub-state) through
 * TodayPage, so there is exactly one place that decides what happened. The
 * moves are the card's own `allowedMoves`, decided by the server from the
 * job's real history and the caller's role — never recomputed here.
 */
export function CardActionSheet({ job, busy, errorText, quoteHref, onClose, onMoveStatus, onSetSubState }: CardActionSheetProps) {
  // ไม่อนุมัติ and เอารถลง close the job and take the card off the board for
  // good (DECISION-7-today.md §6), so neither is ever one tap: they wait here
  // for a confirmation that names the car and says what will happen.
  const [confirmTo, setConfirmTo] = useState<StatusKey | null>(null);

  const status: StatusKey = job.status;
  const title = [job.brand, job.model].filter(Boolean).join(' ') || 'ไม่ระบุรุ่น';
  const car = [title, job.plate].filter(Boolean).join(' · ');
  const moves = job.allowedMoves;
  const workMoves = moves.filter((to) => !leavesBoard(to));
  const closingMoves = moves.filter(leavesBoard);
  const subStates = SUB_STATES_BY_STATUS[status] ?? [];

  return (
    <Modal title={`${job.jobNumber} — ${title}`} onClose={onClose}>
      <div className="kb-sheet">
        {errorText && <p className="kb-sheet-error" role="alert">{errorText}</p>}

        <p className="kb-sheet-now">
          สถานะตอนนี้: <strong>{job.statusLabel}</strong>
        </p>

        {quoteHref && confirmTo === null && (
          <Link className="btn secondary" to={quoteHref}>
            <Icon name="list" size={15} /> ใบเสนอราคา
          </Link>
        )}

        {confirmTo === null ? (
          <>
            <section className="kb-sheet-section">
              <h4>เปลี่ยนสถานะ</h4>
              <div className="kb-sheet-grid">
                {workMoves.map((to) => (
                  <button
                    key={to}
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => onMoveStatus(to)}
                  >
                    {moveLabel(status, to)}
                  </button>
                ))}
                {workMoves.length === 0 && <p className="page-sub">ไม่มีสถานะถัดไปให้เลือก</p>}
              </div>
            </section>

            {closingMoves.length > 0 && (
              <section className="kb-sheet-section">
                <h4>ปิดงาน</h4>
                <div className="kb-sheet-grid">
                  {closingMoves.map((to) => (
                    <div key={to} className="kb-sheet-action">
                      <button
                        type="button"
                        className="btn danger"
                        disabled={busy}
                        aria-describedby={CLOSING_HELPER[to] ? `kb-helper-${to}` : undefined}
                        onClick={() => setConfirmTo(to)}
                      >
                        {statusOf(to).label}…
                      </button>
                      {CLOSING_HELPER[to] && (
                        <small id={`kb-helper-${to}`} className="kb-sheet-helper">
                          {CLOSING_HELPER[to]}
                        </small>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <section className="kb-sheet-confirm" role="alertdialog" aria-labelledby="kb-confirm-title">
            <h4 id="kb-confirm-title">ยืนยัน: {statusOf(confirmTo).label}</h4>
            <p>
              {CLOSING_EXPLANATION[confirmTo] && <>{CLOSING_EXPLANATION[confirmTo]} — </>}
              <strong>{car}</strong> ({job.jobNumber}) จะถูกเปลี่ยนเป็น “{statusOf(confirmTo).label}”
              งานนี้จะ<strong>ปิดและออกจากกระดาน</strong> และย้อนกลับไม่ได้
            </p>
            <div className="row-flex">
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() => onMoveStatus(confirmTo)}
              >
                ยืนยัน{statusOf(confirmTo).label}
              </button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirmTo(null)}>
                ย้อนกลับ
              </button>
            </div>
          </section>
        )}

        {confirmTo === null && subStates.length > 0 && (
          <section className="kb-sheet-section">
            <h4>ป้ายบนการ์ด</h4>
            <div className="kb-sheet-grid">
              {([null, ...subStates] as (SubState | null)[]).map((s) => {
                const active = job.subState === s;
                return (
                  <button
                    key={s ?? 'none'}
                    type="button"
                    className={`chip${active ? ' active' : ''}`}
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => onSetSubState(s)}
                  >
                    {/* The selected chip carries a check mark, not only a fill colour. */}
                    {active && '✓ '}
                    {s === null ? 'ไม่มีป้าย' : SUB_STATE_LABEL[s]}
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
