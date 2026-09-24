export type StatusKey =
  | 'received'
  | 'inspecting'
  | 'quoted'
  | 'approved'
  | 'scheduled'
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
  { key: 'scheduled', label: 'นัดวันมาทำ', cls: 'st-scheduled' },
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

/** Answers to the quote. Each one also decides where the job goes next. */
export const DECISION_KEYS: StatusKey[] = ['approved', 'scheduled', 'rejected'];

/** Branches that finish with the car simply being taken back down. */
export const BRANCH_ENDS: Partial<Record<StatusKey, StatusKey>> = {
  scheduled: 'carout',
  rejected: 'carout',
};

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
