// Display helpers for the quotation screen, kept out of the component files
// so those export components only (fast refresh). Nothing here decides a rule:
// it arranges what the server sent, or words a domain helper's answer.

import { checkApprovedAmount } from '@champpower/domain';
import type { Quotation, QuotationLine } from '@gsms/contracts/index.js';
import { bahtDelta, typedSatang } from '../../lib/money';

export type RevisionMark = 'carried' | 'ask' | null;

export interface LineGroup {
  head: QuotationLine;
  children: QuotationLine[];
}

/** Top-level lines in the server's order, each with its set pieces right under it. */
export function groupLines(lines: readonly QuotationLine[]): LineGroup[] {
  const bySort = [...lines].sort((a, b) => a.sortOrder - b.sortOrder);
  return bySort
    .filter((l) => l.parentLineId === null)
    .map((head) => ({ head, children: bySort.filter((c) => c.parentLineId === head.id) }));
}

export function isRevision(q: Quotation): boolean {
  return q.revision > 1 || q.supersedesDocumentId !== null;
}

/**
 * "ตกลงไว้แล้ว" vs "ต้องถามใหม่" on a revision, from the server's
 * `decisionCarriedFrom` only (the API decides whether a decision still holds —
 * packages/domain decisionCarries). A new or changed line is "ต้องถามใหม่"
 * until the customer has answered it on this revision.
 */
export function revisionMark(q: Quotation, line: QuotationLine): RevisionMark {
  if (!isRevision(q)) return null;
  if (line.decisionCarriedFrom !== null) return 'carried';
  return line.approvalStatus === 'pending' ? 'ask' : null;
}

/**
 * The hint under a typed set amount (Q2). checkApprovedAmount is the same
 * domain function the API runs, used here ONLY to tell the person in advance —
 * nothing is blocked on it; the API decides. Above the offer the difference is
 * spelled out as a number ("+฿1,200.00 จากราคาชุดเดิม"), never just an icon.
 */
export function amountHint(offeredSatang: number, typed: string): { text: string; tone: 'info' | 'warning' | 'danger' } | null {
  const agreed = typedSatang(typed);
  if (agreed === null) return null;
  const check = checkApprovedAmount(offeredSatang, agreed);
  if ('code' in check) {
    if (check.code === 'over_double') {
      return { tone: 'danger', text: `${bahtDelta(check.delta)} จากราคาชุดเดิม — เกิน 2 เท่าของราคาที่เสนอ น่าจะพิมพ์ผิด ถ้าตั้งใจจริงให้ออกใบเสนอราคาฉบับใหม่` };
    }
    if (check.code === 'free_set') return { tone: 'danger', text: 'ชุดนี้เสนอไว้ที่ 0 บาท จะเพิ่มราคาต้องออกใบเสนอราคาฉบับใหม่' };
    return { tone: 'danger', text: 'ยอดติดลบไม่ได้' };
  }
  if (check.kind === 'same') return { tone: 'info', text: 'เท่ากับราคาชุดเดิม' };
  if (check.kind === 'zero') return { tone: 'warning', text: `แถมฟรี (${bahtDelta(check.delta)} จากราคาชุดเดิม)` };
  return { tone: check.kind === 'higher' ? 'warning' : 'info', text: `${bahtDelta(check.delta)} จากราคาชุดเดิม` };
}
