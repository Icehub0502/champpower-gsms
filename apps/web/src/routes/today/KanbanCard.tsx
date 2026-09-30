import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TodayJob } from '@gsms/contracts/index.js';
import { CardTimer } from './CardTimer';

interface KanbanCardProps {
  job: TodayJob;
  /** A request for this card is in flight — it cannot be dragged or opened. */
  busy: boolean;
  /** This card is the one currently being dragged (the ghost follows the finger). */
  dragging: boolean;
  onOpen: (job: TodayJob) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, job: TodayJob) => void;
  /** True when the click that just fired is the tail end of a drag, not a tap. */
  swallowClick: () => boolean;
  /** The card just created by check-in — briefly outlined and scrolled to,
   * so staff who just saved a car can see it landed (App.tsx CheckInRoute). */
  highlighted?: boolean;
}

/**
 * One job on the board (figma-80 brief, "Card anatomy").
 *
 * The whole card is ONE button: tap (or Enter/Space) opens the action sheet,
 * which is the non-drag way to move a job or set its label. Drag starts from
 * the same surface — after 6px of mouse movement, or a 350ms long-press with a
 * finger so an ordinary swipe still scrolls the columns (useCardDrag.ts).
 *
 * Everything shown is what the server sent: `label` (text + tone) comes from
 * cardLabelOf() in packages/domain, and the card decides nothing itself.
 * The left stripe takes the LABEL's tone, not the column's.
 */
export function KanbanCard({ job, busy, dragging, onOpen, onPointerDown, swallowClick, highlighted }: KanbanCardProps) {
  const title = [job.brand, job.model].filter(Boolean).join(' ') || 'ไม่ระบุรุ่น';
  const who = [job.plate, job.customerName ? `คุณ${job.customerName}` : null].filter(Boolean).join(' • ');

  return (
    <button
      type="button"
      className={[
        'kb-card',
        `tone-${job.label.tone}`,
        busy ? 'is-busy' : '',
        dragging ? 'is-dragging' : '',
        highlighted ? 'is-highlighted' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={`${job.jobNumber} ${title} ${job.plate ?? ''} — ${job.statusLabel} · ${job.label.text}. แตะเพื่อเปลี่ยนสถานะ`}
      data-job-id={job.jobId}
      onPointerDown={(e) => onPointerDown(e, job)}
      onClick={() => {
        if (swallowClick()) return;
        onOpen(job);
      }}
      // Long-press on Android raises a context menu; the long-press here means "pick up".
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="kb-card-top">
        <span className="kb-card-no mono">{job.jobNumber}</span>
        <span className="kb-pill">{busy ? 'กำลังบันทึก…' : job.label.text}</span>
      </span>
      <span className="kb-card-title">{title}</span>
      {who && <span className="kb-card-who">{who}</span>}
      <span className="kb-card-divider" aria-hidden="true" />
      {/* In this release the detail line is the first complaint. Money arrives
          with billing (W3) — never a placeholder amount. */}
      <span className="kb-card-detail">{job.symptom ?? '—'}</span>
      <span className="kb-card-foot">
        <span className="kb-card-status">{job.statusLabel}</span>
        <CardTimer job={job} />
      </span>
    </button>
  );
}
