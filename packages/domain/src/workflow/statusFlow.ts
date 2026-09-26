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
 * The customer's answer to the quote: yes, or no.
 *
 * "Not now, I'll come back on the 15th" is no longer a third answer. It is the
 * car leaving (`carout`) plus a new BOOKING for the 15th — the job does not wait
 * for an appointment, because a car that is not in the workshop has no job.
 */
export const DECISION_KEYS: StatusKey[] = ['approved', 'rejected'];

/**
 * Statuses a job never leaves: CLOSED, and nothing — no button, no drag — moves
 * it again. Off the board, and — unlike before — with no `rejected -> carout`
 * step: a declined quote closes the job there and then.
 *
 * `delivered` is deliberately NOT here (code review, MEDIUM). It is finished,
 * but not closed: `delivered -> ready` stays possible, because column 4 holds
 * both and a mis-drag between them is easy, and until billing exists nothing
 * numbered is attached to a delivered job. This set means one thing only —
 * "cannot move" — and must not be reused to mean "not on the board" (that is
 * kanbanColumnOf(status) === null) or "finished" (delivered is finished and can
 * still move). One name, one meaning. When billing lands, a delivered job with
 * a receipt that is not void must refuse the step back — see
 * docs/WORK-ORDERS/WO-005-billing.md.
 *
 * `rejected` and `carout` stay DISTINCT and must never be merged
 * (DECISION-7-today.md §6): `rejected` means the customer said no at the quote
 * and feeds the decline-reason report (CLAUDE.md §5.7); `carout` means the
 * customer took the car back part-way through. Counting one as the other
 * corrupts the owner's "why don't customers go ahead" report.
 */
export const TERMINAL_STATUSES: StatusKey[] = ['rejected', 'carout'];

/**
 * From where a customer may take the car away unfinished (`carout`).
 *
 * THIS TABLE IS A PROPOSAL FOR THE OWNER TO CONFIRM, not a settled rule:
 *
 *   status       -> carout?   why
 *   received        yes       changed their mind before anyone looked
 *   inspecting      yes       did not want to wait for the inspection
 *   quoted          yes       "not now" — leaves, and comes back as a new booking
 *   approved        yes       said yes, then took the car before work began
 *   repairing       yes       rare, but it happens mid-job
 *   aligning        yes       as above
 *   ready           NO        the work is FINISHED; a finished car leaving is
 *                             `delivered`, and this shop never lets a car leave
 *                             owing (CLAUDE.md §5.3 rule 3), so it cannot be a
 *                             carout
 *   delivered, rejected, carout   no — terminal
 */
export const CAROUT_SOURCES: StatusKey[] = [
  'received', 'inspecting', 'quoted', 'approved', 'repairing', 'aligning',
];

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
