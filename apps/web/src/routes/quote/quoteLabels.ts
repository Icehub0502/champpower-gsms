// The words the quotation screen shows for server-side codes. Display text
// only — no rule lives here (the rules are in packages/domain and the API).

import { DECLINE_REASONS, type DeclineReason } from '@champpower/domain';
import type { LineType, PriceSource, QuotationStatus, Role } from '@gsms/contracts/index.js';

/**
 * Why the customer said no — the short list the counter actually uses
 * (CLAUDE.md §5.7 #1). `chose_alternative` is listed for the decision itself
 * but is not a refusal (D13): it reads "เลือกอีกตัวเลือก" everywhere.
 */
export const DECLINE_REASON_LABEL: Record<DeclineReason, string> = {
  too_expensive: 'ราคาสูง',
  next_time: 'ไว้ครั้งหน้า',
  going_elsewhere: 'ไปทำที่อื่น',
  not_needed_yet: 'ยังไม่จำเป็น',
  chose_alternative: 'เลือกอีกตัวเลือก',
  other: 'อื่น ๆ',
};

/** Dropdown order: the domain's list, with "อื่น ๆ" last where people look for it. */
export const DECLINE_REASON_OPTIONS: DeclineReason[] = [
  ...DECLINE_REASONS.filter((r) => r !== 'other'),
  'other',
];

export const QUOTATION_STATUS_LABEL: Record<QuotationStatus, string> = {
  draft: 'ร่าง (ยังไม่ออกเลข)',
  issued: 'รอลูกค้าตัดสินใจ',
  signed: 'ยืนยันผลลูกค้าแล้ว',
  superseded: 'มีฉบับใหม่แทนแล้ว',
  void: 'ปิดแล้ว',
};

export const LINE_TYPE_LABEL: Record<LineType, string> = {
  part: 'อะไหล่',
  labor: 'ค่าแรง',
  fee: 'ค่าบริการ',
};

export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = {
  model: 'ราคากลางของรุ่นนี้',
  base: 'ราคากลาง',
  manual: 'ราคาพิมพ์เอง',
};

/**
 * Who may use this screen at all, and who may change anything on it. These
 * mirror the API's role lists (routes/quotation.ts PRICE_READ_ROLES and
 * INTAKE_WRITE_ROLES) only to decide what to SHOW — the API enforces both on
 * every request (CLAUDE.md §12.1). A technician sees no prices at all.
 */
const READ_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager', 'advisor', 'accountant', 'viewer'];
const WRITE_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager', 'advisor'];

export function canReadQuote(role: Role | null): boolean {
  return role !== null && READ_ROLES.includes(role);
}

export function canWriteQuote(role: Role | null): boolean {
  return role !== null && WRITE_ROLES.includes(role);
}
