import type { LeadSource } from '@gsms/contracts/index.js';

/**
 * Thai labels for customers.lead_source, exactly the list in CLAUDE.md §5.7.
 * Typed as a Record over the contract's own enum, so a value added to
 * LeadSource without a label here is a compile error, not a blank option.
 * 'unknown' (ไม่ทราบ) is a real answer — without it staff pick at random to
 * get past a required field, and the report is worse than not asking.
 */
export const LEAD_SOURCE_LABEL: Record<LeadSource, string> = {
  page: 'เพจ',
  line: 'LINE',
  shopfront_sign: 'ป้ายหน้าร้าน',
  referral: 'เพื่อนแนะนำ',
  google: 'Google',
  passing_by: 'ผ่านมาเห็น',
  other: 'อื่น ๆ',
  unknown: 'ไม่ทราบ',
};

export const LEAD_SOURCE_ORDER = Object.keys(LEAD_SOURCE_LABEL) as LeadSource[];
