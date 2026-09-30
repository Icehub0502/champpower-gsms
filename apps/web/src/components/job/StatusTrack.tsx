import { MAIN_PATH, STATUS_FLOW, statusOf, type StatusKey } from '@champpower/domain';

interface StatusTrackProps {
  status: StatusKey;
}

const BRANCH_LABELS: Partial<Record<StatusKey, string>> = {
  rejected: 'ไม่อนุมัติ',
  carout: 'เอารถลง',
};

/**
 * The straight-through track for jobs still on MAIN_PATH (or sitting at the quoted
 * decision point). A job that ended off the path (rejected/carout) gets its own
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

/** Condenses MAIN_PATH's 8 statuses into the 5 stages the job-detail header shows as
 * cards (รับรถ/ตรวจเช็ก/เสนอราคา/อนุมัติ+ซ่อม/พร้อมส่ง) — grouping is display-only,
 * it doesn't change what pushStatus/MAIN_PATH themselves do. */
const STEPPER_GROUPS: { label: string; keys: StatusKey[] }[] = [
  { label: 'รับรถ', keys: ['received'] },
  { label: 'ตรวจเช็ก', keys: ['inspecting'] },
  { label: 'เสนอราคา', keys: ['quoted'] },
  { label: 'อนุมัติ/ซ่อม', keys: ['approved', 'repairing', 'aligning'] },
  { label: 'พร้อมส่ง', keys: ['ready', 'delivered'] },
];

export function StatusStepper({ status }: StatusTrackProps) {
  const branchLabel = BRANCH_LABELS[status];
  const currentGroupIndex = STEPPER_GROUPS.findIndex((g) => g.keys.includes(status));

  return (
    <div className="status-stepper">
      {STEPPER_GROUPS.map((g, i) => {
        // A job that ended off the path (rejected/carout) is drawn as having left
        // right after the "เสนอราคา" decision point: the first 3 stages done, the
        // remaining two never reached. That is exact for rejected (it leaves from
        // quoted). For carout it is an approximation in the OTHER direction: since
        // DECISION-carout.md a car is only taken away from received or inspecting
        // (CAROUT_SOURCES), i.e. BEFORE any quote exists, so it never got as far
        // as "เสนอราคา" — the track overstates how far it went.
        const state: 'done' | 'current' | 'pending' = branchLabel
          ? i < 3
            ? 'done'
            : 'pending'
          : i < currentGroupIndex
            ? 'done'
            : i === currentGroupIndex
              ? 'current'
              : 'pending';
        return (
          <div key={g.label} className={`status-step status-step-${state} st-${g.keys[0]}`}>
            <span className="status-step-label">{g.label}</span>
            <span className="status-step-state">
              {state === 'done' ? 'เสร็จแล้ว' : state === 'current' ? 'สถานะปัจจุบัน' : 'รอดำเนินการ'}
            </span>
          </div>
        );
      })}
      {branchLabel && (
        <div className={`status-track-branch st-${status}`}>
          <span className="branch-dot" />
          {branchLabel}
        </div>
      )}
    </div>
  );
}
