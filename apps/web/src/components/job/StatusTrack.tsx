import { MAIN_PATH, STATUS_FLOW, statusOf, type StatusKey } from '@champpower/domain';

interface StatusTrackProps {
  status: StatusKey;
}

const BRANCH_LABELS: Partial<Record<StatusKey, string>> = {
  scheduled: 'นัดวันมาทำ',
  rejected: 'ไม่อนุมัติ',
  carout: 'เอารถลง',
};

/**
 * The straight-through track for jobs still on MAIN_PATH (or sitting at the quoted
 * decision point). A job that branched off (scheduled/rejected/carout) gets its own
 * small badge instead — rendering it as "3 of 8 done, 5 to go" on MAIN_PATH would lie,
 * since it's never coming back to that path.
 */
export function StatusTrack({ status }: StatusTrackProps) {
  const branchLabel = BRANCH_LABELS[status];
  if (branchLabel) {
    return (
      <div className={`status-track-branch st-${status}`}>
        <span className="branch-dot" />
        {branchLabel}
      </div>
    );
  }

  const currentIndex = MAIN_PATH.indexOf(status);

  return (
    <div className="status-track">
      {MAIN_PATH.map((key, i) => {
        const def = statusOf(key);
        const done = currentIndex >= 0 && i < currentIndex;
        const current = i === currentIndex;
        return (
          <span
            key={key}
            className={`status-track-seg ${def.cls} ${done ? 'done' : ''} ${current ? 'current' : ''}`}
            title={def.label}
          />
        );
      })}
    </div>
  );
}

export function StatusLabel({ status }: { status: StatusKey }) {
  const def = STATUS_FLOW.find((s) => s.key === status) ?? statusOf(status);
  return <span className={`status-chip ${def.cls}`}>{def.label}</span>;
}
