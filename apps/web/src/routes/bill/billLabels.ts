// Words for billing codes, and which roles the screen OFFERS things to. Display
// only: every rule is enforced by the API (CLAUDE.md §12.1) — these lists only
// decide what to show.

import { PAYMENT_METHOD_LABEL } from '@champpower/domain';
import type { ReceiptBlocker, ReceiptLineState, ReceiptStatus, Role, StatusKey } from '@gsms/contracts/index.js';

export { PAYMENT_METHOD_LABEL };

const BILL_READ_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager', 'advisor', 'accountant', 'viewer'];
const BILL_WRITE_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager', 'advisor'];
/** Who sees "สรุปรายวัน" in the menu: manager and up (the page itself is wider; the API decides). */
const DAILY_MENU_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager'];
const DAILY_READ_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager', 'advisor', 'accountant', 'viewer'];

export function canReadBill(role: Role | null): boolean {
  return role !== null && BILL_READ_ROLES.includes(role);
}
export function canWriteBill(role: Role | null): boolean {
  return role !== null && BILL_WRITE_ROLES.includes(role);
}
export function showsDailyInMenu(role: Role | null): boolean {
  return role !== null && DAILY_MENU_ROLES.includes(role);
}
export function canReadDaily(role: Role | null): boolean {
  return role !== null && DAILY_READ_ROLES.includes(role);
}

/** Who may open ตั้งค่า › ช่องทางชำระ (Ice B3): owner, and manager if the API allows — the API decides saving. */
const CHANNEL_ROLES: readonly Role[] = ['owner', 'manager'];
export function canManageChannels(role: Role | null): boolean {
  return role !== null && CHANNEL_ROLES.includes(role);
}

/** Job statuses where the bill screen is worth linking to (approved up to delivered). */
const BILLABLE_STATUSES: readonly StatusKey[] = ['approved', 'repairing', 'aligning', 'ready', 'delivered'];
export function billLinkFits(status: StatusKey, jobType: 'normal' | 'warranty_claim'): boolean {
  return jobType === 'normal' && BILLABLE_STATUSES.includes(status);
}

/** Statuses where a work order exists to print (the quotation has been confirmed). */
const WORK_ORDER_STATUSES: readonly StatusKey[] = ['approved', 'repairing', 'aligning', 'ready'];
export function workOrderFits(status: StatusKey): boolean {
  return WORK_ORDER_STATUSES.includes(status);
}

export function billHref(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/bill`;
}

export const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, string> = {
  draft: 'ร่าง (ยังไม่ปิดบิล)',
  issued: 'ปิดบิลแล้ว',
  void: 'ยกเลิกแล้ว',
};

export const LINE_STATE_LABEL: Record<ReceiptLineState, string> = {
  unanswered: 'ยังไม่ระบุ',
  done: 'ทำครบ',
  partial: 'ทำบางส่วน',
  not_done: 'ไม่ได้ทำ — ไม่คิดเงิน',
};

export const BLOCKER_TEXT: Record<ReceiptBlocker, string> = {
  job_not_ready: 'งานยังไม่ถึงขั้นเก็บเงิน',
  quotation_changed: 'ใบเสนอราคาเปลี่ยนหลังเริ่มทำบิลนี้ — โหลดรายการใหม่ก่อน',
  lines_unanswered: 'ยังมีรายการที่ยังไม่ระบุว่าทำจริงไหม',
  discount_entry_required: 'ต้องกรอกส่วนลดใหม่ (มีรายการที่ไม่ได้ทำ)',
  discount_exceeds_subtotal: 'ส่วนลดมากกว่ายอดที่คิดเงิน',
  discount_reason_required: 'ส่วนลดต้องมีเหตุผล',
  discount_requires_manager: 'ส่วนลดเกินเพดาน — ต้องให้ผู้จัดการขึ้นไปปิดบิล',
  nothing_to_bill: 'ยอดบิลเป็น 0 — ไม่มีอะไรให้เก็บเงิน',
};
