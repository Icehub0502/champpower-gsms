/**
 * The ten statuses of a JOB (DECISION-7-today.md §6, 24 Sep 2026).
 *
 * `scheduled` (นัดวันมาทำ) is deliberately NOT here. An appointment is a
 * BOOKING — `bookings.status` 'booked' / 'confirmed' — and a car that is not in
 * the workshop must have no jobs row at all. Letting "appointment" be a job
 * status is exactly how the prototype produced two job rows for one car: the
 * booking became a job too early, and when the car really arrived a second job
 * was opened beside it. Migration 0017 removes the value from the table's CHECK.
 */
export type StatusKey =
  | 'received'
  | 'inspecting'
  | 'quoted'
  | 'approved'
  | 'rejected'
  | 'repairing'
  | 'aligning'
  | 'ready'
  | 'delivered'
  | 'carout';

export interface StatusDef {
  key: StatusKey;
  label: string;
  cls: string;
}

export const STATUS_FLOW: StatusDef[] = [
  { key: 'received', label: 'รับรถ', cls: 'st-received' },
  // ก, not ค — as spelled in Figma 51–58 and 80 and confirmed in
  // DECISION-job-status.md §1.
  { key: 'inspecting', label: 'ตรวจเช็ก', cls: 'st-inspecting' },
  { key: 'quoted', label: 'เสนอราคา', cls: 'st-quoted' },
  { key: 'approved', label: 'อนุมัติ', cls: 'st-approved' },
  { key: 'rejected', label: 'ไม่อนุมัติ', cls: 'st-rejected' },
  { key: 'repairing', label: 'กำลังซ่อม', cls: 'st-repairing' },
  { key: 'aligning', label: 'รอตั้งศูนย์', cls: 'st-aligning' },
  { key: 'ready', label: 'พร้อมส่ง', cls: 'st-ready' },
  { key: 'delivered', label: 'ส่งแล้ว', cls: 'st-delivered' },
  { key: 'carout', label: 'เอารถลง', cls: 'st-carout' },
];

/** The straight-through route, used for the progress track and the "next step" button. */
export const MAIN_PATH: StatusKey[] = [
  'received',
  'inspecting',
  'quoted',
  'approved',
  'repairing',
  'aligning',
  'ready',
  'delivered',
];

/**
 * The customer's answer to the quote: yes, or no. Asked at `quoted` only.
 *
 * "Not now, I'll come back later" is NOT a third answer and NOT a carout: it is
 * `rejected` with the decline reason "ไว้ครั้งหน้า" (DECISION-carout.md §1). When
 * the customer does come back, a NEW job is opened and linked to the old job and
 * its quotation — the old job is never reopened (DECISION-carout.md §4).
 */
export const DECISION_KEYS: StatusKey[] = ['approved', 'rejected'];

/**
 * THE THREE WAYS A JOB ENDS (docs/WORK-ORDERS/DECISION-carout.md, owner,
 * 30 Sep 2026). They are INDEPENDENT exits — none is a step after another,
 * each is one click, and each takes the card off /today and the TV at once:
 *
 *   status      meaning                                        only from
 *   delivered   work done, the customer collected the car      ready
 *   rejected    the customer saw the quote and said no          quoted
 *               (including "ไว้ครั้งหน้า" — that is a reason)
 *   carout      the customer changed their mind BEFORE any      received, inspecting
 *               quotation existed and took the car back
 *
 * There is no carout after a quote exists, and no carout "after" delivered or
 * rejected. At this shop a car is never taken away mid-repair, so approved,
 * repairing, aligning and ready have no exit but finishing the work.
 *
 * `rejected` and `carout` must never be merged: `rejected` feeds the owner's
 * "why don't customers go ahead" report (CLAUDE.md §5.7, decline_reason);
 * `carout` happens before there was anything to decline. Counting one as the
 * other corrupts that report.
 */
export const EXIT_STATUSES: StatusKey[] = ['delivered', 'rejected', 'carout'];

/**
 * Statuses a job never leaves: CLOSED, and nothing — no button, no drag — moves
 * it again.
 *
 * `delivered` is deliberately NOT here. It is an exit (off the board), but a
 * mistaken "ส่งแล้ว" may be undone — `delivered -> ready`, by the same staff
 * who may deliver, always with a reason (DECISION-carout.md §3; see
 * moveRequiresReason in transitions.ts). This set means one thing only —
 * "cannot move" — and must not be reused to mean "off the board" (that is
 * EXIT_STATUSES / kanbanColumnOf(status) === null). When billing lands, a
 * delivered job with a numbered document that is not void must refuse the step
 * back (CLAUDE.md §5 rule 5) — that rule does not change.
 */
export const TERMINAL_STATUSES: StatusKey[] = ['rejected', 'carout'];

/**
 * From where the customer may take the car away unfinished (`carout`):
 * only BEFORE a quotation exists (DECISION-carout.md §1).
 *
 *   received     changed their mind before anyone looked
 *   inspecting   changed their mind while the car was being checked
 *
 * Once a quote exists the customer's "no" is `rejected` (from quoted), and
 * from approved onwards the car does not leave until the work is done.
 */
export const CAROUT_SOURCES: StatusKey[] = ['received', 'inspecting'];

export const WARRANTY_OPTIONS = [
  { value: 0, label: 'ไม่มีประกัน' },
  { value: 7, label: '7 วัน' },
  { value: 30, label: '30 วัน' },
  { value: 90, label: '90 วัน' },
  { value: 180, label: '180 วัน' },
  { value: 365, label: '1 ปี' },
] as const;

export function warrantyOptionLabel(days: number): string {
  const o = WARRANTY_OPTIONS.find((o) => o.value === days);
  return o ? o.label : `${days} วัน`;
}

/** Old status name kept only so historical jobs still resolve to a valid status. */
export const LEGACY_STATUS_MAP: Record<string, StatusKey> = { customerout: 'quoted' };

export function statusOf(key: StatusKey | string): StatusDef {
  return STATUS_FLOW.find((s) => s.key === key) ?? STATUS_FLOW[0]!;
}
