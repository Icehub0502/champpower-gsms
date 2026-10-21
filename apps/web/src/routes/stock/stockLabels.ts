// Words for stock, paths, and which roles the screen OFFERS things to. Display only:
// every rule is enforced by the API (apps/api/src/routes/stock.ts checks the role on
// every route, CLAUDE.md s12.1). These lists mirror that file's header so the menu
// never shows a door the server will refuse.

import { STOCK_CHANGED_EVENT, type Role, type StockMoveType, type StockStatus, type StockingPolicy } from '@gsms/contracts/index.js';
import { qtyText } from '../../lib/printFormat';

export { STOCK_CHANGED_EVENT };

const ISSUE_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager', 'advisor', 'technician'];
const WRITE_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager', 'advisor'];
const REPORT_ROLES: readonly Role[] = ['owner', 'manager', 'assistant_manager'];

/** Every signed-in role may read quantities. */
export function canReadStock(role: Role | null): boolean {
  return role !== null;
}
/** เบิกของ. Technicians too: issue is a shelf action, not a money one. */
export function canIssueStock(role: Role | null): boolean {
  return role !== null && ISSUE_ROLES.includes(role);
}
/** ตั้งยอด / ปรับยอด / SKU master / catalog link / unbound + stale lists. */
export function canWriteStock(role: Role | null): boolean {
  return role !== null && WRITE_ROLES.includes(role);
}
/** การปรับสต๊อกด้วยมือรายวัน + integrity. */
export function canReadStockReports(role: Role | null): boolean {
  return role !== null && REPORT_ROLES.includes(role);
}

export const STOCK_API = '/api/stock';
export const SKUS_PATH = `${STOCK_API}/skus`;

export function skuPath(id: string): string {
  return `${SKUS_PATH}/${encodeURIComponent(id)}`;
}
export function skuByCodePath(code: string): string {
  return `${SKUS_PATH}/by-code/${encodeURIComponent(code)}`;
}
export function jobStockPath(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/stock`;
}

/** Screen routes. */
export const stockRoutes = {
  hub: '/stock',
  skus: '/stock/skus',
  card: (skuId: string) => `/stock/skus/${encodeURIComponent(skuId)}`,
  count: '/stock/count',
  countOne: (skuId: string) => `/stock/count?sku=${encodeURIComponent(skuId)}`,
  low: '/stock/low',
  adjust: '/stock/adjust',
  adjustOne: (skuId: string) => `/stock/adjust?sku=${encodeURIComponent(skuId)}`,
  issue: '/stock/issue',
  jobIssue: (jobId: string) => `/jobs/${encodeURIComponent(jobId)}/stock`,
  links: '/stock/catalog-links',
  unbound: '/stock/reports/unbound',
  stale: '/stock/reports/stale',
  adjustments: '/stock/reports/adjustments',
  integrity: '/stock/reports/integrity',
} as const;

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  not_counted: 'ยังไม่ตั้งยอด',
  out: 'หมด',
  low: 'ใกล้หมด',
  ok: 'มีของ',
};

export const STOCK_STATUS_PILL: Record<StockStatus, string> = {
  not_counted: 'pill-muted',
  out: 'pill-danger',
  low: 'pill-warning',
  ok: 'pill-success',
};

export const STOCKING_POLICY_LABEL: Record<StockingPolicy, string> = {
  stocked: 'สต๊อกไว้',
  buy_to_order: 'ซื้อเฉพาะงาน',
};

export const MOVE_TYPE_LABEL: Record<StockMoveType, string> = {
  receipt: 'รับเข้า',
  reserve: 'จอง',
  unreserve: 'คืนของจอง',
  issue: 'เบิก',
  return: 'คืนของ',
  adjustment: 'ปรับยอด',
  count: 'ตั้งยอด',
  transfer_out: 'โอนออก',
  transfer_in: 'โอนเข้า',
};

/** Words for a document type a move points at (MoveRef.documentType). Unknown types fall back to the raw code. */
export const DOC_TYPE_LABEL: Record<string, string> = {
  quotation: 'ใบเสนอราคา',
  receipt: 'ใบเสร็จ',
  work_order: 'ใบสั่งงาน',
};

/** Job statuses where there is something to pull (the quotation is confirmed and the car is still in). */
export const ISSUABLE_JOB_STATUSES = ['approved', 'repairing', 'aligning', 'ready'] as const;

/** Pre-filled reason on the count sheet (the contract allows the screen to). DEFAULT pending Ice (wording). */
export const DEFAULT_COUNT_REASON = 'ตั้งยอดตั้งต้น';

export const STOCK_PAGE_SIZE = 50;

/** One per dialog open / button press; resent unchanged on a retry. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/** A quantity for display: "3", "1.5". Null is never shown as 0 — the caller decides what null means. */
export function qty(q: string | null | undefined): string {
  return q == null ? '-' : qtyText(q);
}

/** True when a cost figure may be rendered: the key is present (cost role) AND the server knows a value. */
export function hasCost(v: string | null | undefined): v is string {
  return v !== undefined && v !== null;
}

/** "Do we have it?" is always `available`, never on_hand. Negative = a count found less than is reserved. */
export function isNegative(q: string | null): boolean {
  return q !== null && q.trim().startsWith('-');
}
