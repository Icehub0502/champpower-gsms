import type { PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import type { KanbanColumnDef } from '@champpower/domain';
import type { TodayJob } from '@gsms/contracts/index.js';
import { KanbanCard } from './KanbanCard';

const TINT_CLASS: Record<number, string> = {
  1: 'col-intake',
  2: 'col-inspect',
  3: 'col-repair',
  4: 'col-ready',
};

interface KanbanColumnViewProps {
  def: KanbanColumnDef;
  jobs: TodayJob[];
  busyJobId: string | null;
  draggingJobId: string | null;
  isDropTarget: boolean;
  onOpen: (job: TodayJob) => void;
  onCardPointerDown: (e: ReactPointerEvent<HTMLElement>, job: TodayJob) => void;
  swallowClick: () => boolean;
  bodyRef: (el: HTMLElement | null) => void;
  highlightedJobId: string | null;
}

/**
 * One kanban column (figma-80 brief). "+ เพิ่มงานในขั้นตอนนี้" only makes
 * sense on column 1 (received) — it opens check-in; creating a job directly
 * into "กำลังซ่อม" would skip intake, so columns 2–4 render nothing there.
 */
export function KanbanColumnView({
  def,
  jobs,
  busyJobId,
  draggingJobId,
  isDropTarget,
  onOpen,
  onCardPointerDown,
  swallowClick,
  bodyRef,
  highlightedJobId,
}: KanbanColumnViewProps) {
  return (
    <div className={`kb-column ${TINT_CLASS[def.column]}${isDropTarget ? ' is-drop-target' : ''}`}>
      <div className="kb-column-head">
        <span className="kb-column-dot" aria-hidden="true" />
        <span className="kb-column-title">{def.title}</span>
        <span className="kb-column-count">{jobs.length}</span>
      </div>
      <div className="kb-column-body" ref={bodyRef}>
        {jobs.map((job) => (
          <KanbanCard
            key={job.jobId}
            job={job}
            busy={busyJobId === job.jobId}
            dragging={draggingJobId === job.jobId}
            onOpen={onOpen}
            onPointerDown={onCardPointerDown}
            swallowClick={swallowClick}
            highlighted={job.jobId === highlightedJobId}
          />
        ))}
        {jobs.length === 0 && <p className="kb-column-empty">ไม่มีงาน</p>}
      </div>
      {def.column === 1 && (
        <Link className="kb-column-add" to="/checkin">
          + เพิ่มงานในขั้นตอนนี้
        </Link>
      )}
    </div>
  );
}
