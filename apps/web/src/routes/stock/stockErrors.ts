import { StockBody, type StockBody as StockBodyT } from '@gsms/contracts/index.js';
import { ApiError } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { fieldCodeText } from '../quote/quoteErrors';
import { qty } from './stockLabels';

/**
 * What a refused stock request tells the person. Same rule as billErrors / depositErrors:
 * the body is read ONLY through the contract's StockBody.safeParse; a body that does not
 * parse is an unknown error. The server's own `message` is never echoed.
 */
export interface StockFailure {
  text: string;
  /** Field -> Thai text, for the boxes that show their own error. */
  fields: Record<string, string>;
  body: StockBodyT | null;
  /** A request cancelled by logout / a change of user: say nothing. */
  cancelled: boolean;
  /** The request may not have reached the server (network / 5xx): a retry must resend the SAME requestId. */
  retryable: boolean;
}

export const GENERIC_STOCK_FAILURE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่ — ตัวเลขที่กรอกไว้ยังอยู่ครบ และกดซ้ำได้โดยไม่บันทึกซ้ำ';

const LINE_REASON_TEXT: Record<string, string> = {
  not_part: 'บรรทัดนี้ไม่ใช่อะไหล่',
  not_approved: 'ลูกค้ายังไม่อนุมัติบรรทัดนี้',
  parent_not_approved: 'ลูกค้าไม่อนุมัติชุดที่บรรทัดนี้อยู่',
  is_set_parent: 'บรรทัดแม่ของชุดไม่ใช่ของจริง ให้เบิกที่บรรทัดย่อย',
  no_sku: 'บรรทัดนี้ยังไม่ผูกสต๊อก',
  not_in_quotation: 'บรรทัดนี้ไม่อยู่ในใบเสนอราคาที่ยืนยันแล้ว — โหลดรายการใหม่',
};

function textOf(body: StockBodyT): string {
  switch (body.error) {
    case 'invalid_request': return 'ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจช่องที่มีข้อความสีแดง';
    case 'sku_not_found': return 'ไม่พบอะไหล่นี้ในสาขานี้';
    case 'sku_inactive': return 'อะไหล่นี้ถูกปิดใช้งานแล้ว';
    case 'sku_not_counted': return 'อะไหล่นี้ยังไม่ตั้งยอด — ตั้งยอดก่อน แล้วค่อยปรับหรือเบิก';
    case 'no_change': return 'ยอดใหม่เท่ากับยอดเดิม ไม่มีอะไรต้องปรับ';
    case 'adjustment_negative': return 'ปรับให้ยอดติดลบไม่ได้ — ยอดต่ำสุดคือ 0';
    case 'adjustment_needs_approval': return 'รายการนี้เกินวงเงินที่ปรับเองได้ ส่งให้ผู้จัดการอนุมัติ';
    case 'sku_code_exists': return 'มีรหัสอะไหล่นี้อยู่แล้ว — ใช้รหัสอื่น หรือเปิดตัวที่มีอยู่';
    case 'sku_has_reservations': return 'อะไหล่นี้ยังมีของที่จองไว้ให้งานอยู่ ปิดใช้งานไม่ได้ — เบิกหรือคืนของจองให้หมดก่อน';
    case 'insufficient_on_hand': return `ของในสต๊อกไม่พอ — คงเหลือ ${qty(body.onHand)} แต่ขอเบิก ${qty(body.requested)} (ถ้าของมีจริง ให้ตั้งยอดใหม่ก่อน)`;
    case 'over_reserved_needs_confirm': return `เบิกเกินที่จองไว้ (จองไว้ ${qty(body.reserved)} ขอเบิก ${qty(body.requested)}) — ต้องกดยืนยันก่อน`;
    case 'line_not_issuable': return `บรรทัดนี้เบิกไม่ได้: ${LINE_REASON_TEXT[body.reason] ?? body.reason}`;
    case 'quotation_missing': return 'งานนี้ยังไม่มีใบเสนอราคา จึงยังไม่มีของให้เบิก';
    case 'quotation_not_confirmed': return 'ใบเสนอราคายังไม่ได้ยืนยันผลลูกค้า จึงเบิกของไม่ได้';
    case 'job_not_found': return 'ไม่พบงานนี้';
    case 'catalog_item_not_found': return 'ไม่พบรายการนี้ในแคตตาล็อก';
    case 'catalog_item_not_part': return 'ผูกสต๊อกได้เฉพาะรายการที่เป็นอะไหล่';
    case 'catalog_item_merged': return 'รายการนี้ถูกรวมเข้ากับรายการอื่นแล้ว — โหลดรายการใหม่';
    case 'catalog_item_bound': return 'รายการนี้ผูกกับอะไหล่อยู่แล้ว — ถอดของเดิมออกก่อน';
    case 'duplicate_lines': return 'มีบรรทัดซ้ำในคำขอ — โหลดรายการใหม่แล้วลองอีกครั้ง';
    case 'forbidden': return 'คุณไม่มีสิทธิ์ทำรายการนี้';
  }
}

export function stockFieldText(code: string | undefined): string {
  switch (code) {
    case 'too_short': return 'สั้นเกินไป — เขียนเหตุผลให้คนอื่นอ่านรู้เรื่อง';
    case 'too_long': return 'ยาวเกินไป (ไม่เกิน 500 ตัวอักษร)';
    case 'too_big': return 'ยาวเกินไป';
    case 'invalid_qty': return 'ใส่จำนวนเป็นตัวเลข 0 ขึ้นไป ทศนิยมไม่เกิน 2 ตำแหน่ง';
    case 'empty_patch': return 'ยังไม่ได้แก้อะไร';
    case 'invalid_date': return 'วันที่ไม่ถูกต้อง';
    default: return fieldCodeText(code);
  }
}

export function describeStockError(err: unknown): StockFailure {
  const empty = { fields: {}, body: null } as Pick<StockFailure, 'fields' | 'body'>;
  if (isSessionCancelled(err)) return { ...empty, text: '', cancelled: true, retryable: false };
  if (!(err instanceof ApiError)) return { ...empty, text: GENERIC_STOCK_FAILURE, cancelled: false, retryable: true };
  const parsed = StockBody.safeParse(err.body);
  if (parsed.success) {
    const body = parsed.data;
    const fields: Record<string, string> = {};
    if (body.error === 'invalid_request' && body.fields) {
      for (const [k, codes] of Object.entries(body.fields)) fields[k] = stockFieldText(codes[0]);
    }
    return { text: textOf(body), fields, body, cancelled: false, retryable: false };
  }
  if (err.status === 403) return { ...empty, text: 'คุณไม่มีสิทธิ์ทำรายการนี้', cancelled: false, retryable: false };
  if (err.status === 404) return { ...empty, text: 'ไม่พบข้อมูลนี้', cancelled: false, retryable: false };
  if (err.status === 429) return { ...empty, text: 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่', cancelled: false, retryable: true };
  return { ...empty, text: GENERIC_STOCK_FAILURE, cancelled: false, retryable: true };
}

/**
 * A contract schema's own verdict on a form, BEFORE it is sent: the same schema the API
 * parses with, so the screen and the server can never disagree on what is valid. The
 * issue's custom message is the code when the schema names one ('invalid_qty'), otherwise
 * zod's issue code ('too_small', 'too_big').
 */
export function contractFieldErrors(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; code: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = String(i.path[0] ?? '_');
    if (out[key]) continue;
    const named = /^[a-z_]+$/.test(i.message) ? i.message : i.code;
    out[key] = stockFieldText(named);
  }
  return out;
}

/** Words for a GET that failed, shown above a list. */
export function loadFailureText(what: string): string {
  return `โหลด${what}ไม่สำเร็จ`;
}
