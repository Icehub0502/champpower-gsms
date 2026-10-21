import { BillingBody, type BillingBody as BillingBodyT } from '@gsms/contracts/index.js';
import { ApiError } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { baht } from '../../lib/money';
import { thaiDateTime } from '../../lib/printFormat';
import { fieldCodeText } from '../quote/quoteErrors';

/**
 * What a refused billing / print / daily-summary request tells the counter.
 * Same rule as quoteErrors.ts: the body is read ONLY through the contract's
 * BillingBody.safeParse; a body that does not parse is an unknown error and no
 * part of it is shown. The server's own `message` is never echoed.
 */
export interface BillFailure {
  text: string;
  fields: Record<string, string>;
  body: BillingBodyT | null;
  /** The page no longer matches the server: reload the receipt. */
  stale: boolean;
  cancelled: boolean;
  code?: string;
}

export const GENERIC_BILL_FAILURE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่ — ข้อมูลที่กรอกไว้ยังอยู่ครบ';

const STALE_CODES = new Set([
  'receipt_not_found', 'receipt_exists', 'receipt_not_draft', 'receipt_not_issued', 'quotation_changed',
  'receipt_line_not_found', 'fulfillment_incomplete', 'discount_entry_required', 'already_billed',
  'revision_pending', 'quotation_not_confirmed', 'bill_not_presented', 'presentation_stale',
  'channel_not_found', 'channel_inactive', 'deposit_not_found', 'deposit_not_held', 'deposit_not_attached',
]);

function textOf(body: BillingBodyT): string {
  switch (body.error) {
    case 'receipt_not_found': return 'งานนี้ยังไม่มีร่างใบเสร็จ';
    case 'receipt_exists': return 'งานนี้ออกใบเสร็จไปแล้ว — โหลดใบเดิมให้แล้ว';
    case 'receipt_not_draft': return 'ใบเสร็จนี้ปิดบิลแล้ว แก้ไม่ได้ — โหลดข้อมูลใหม่ให้แล้ว';
    case 'receipt_not_issued': return 'ใบเสร็จนี้ยังไม่ได้ออก หรือถูกยกเลิกไปแล้ว — โหลดข้อมูลใหม่ให้แล้ว';
    case 'claim_no_receipt': return 'งานเคลมประกันไม่ออกใบเสร็จ (ไม่มีการขาย)';
    case 'job_not_billable': return 'งานนี้ยังไม่ถึงขั้นเก็บเงิน — ลูกค้าต้องยืนยันใบเสนอราคาก่อน';
    case 'quotation_not_confirmed': return 'ใบเสนอราคายังไม่ได้ยืนยันผลลูกค้า — ยืนยันที่หน้าใบเสนอราคาก่อน';
    case 'quotation_missing': return 'งานนี้ยังไม่มีใบเสนอราคา — ทำใบเสนอราคาและยืนยันผลลูกค้าก่อน';
    case 'revision_pending': return 'มีใบเสนอราคาฉบับแก้ไขที่ลูกค้ายังไม่ยืนยัน — ยืนยันฉบับนั้นก่อน ไม่งั้นงานเพิ่มจะหลุดจากบิล';
    case 'quotation_inconsistent': return 'ยอดในใบเสนอราคาไม่ตรงกับรายการ จึงออกใบเสร็จไม่ได้ — แจ้งผู้จัดการให้ตรวจใบเสนอราคา';
    case 'quotation_changed': return 'ใบเสนอราคาเปลี่ยนหลังจากเริ่มทำบิลนี้ — กด “โหลดรายการใหม่จากใบเสนอราคา” แล้วติ๊กใหม่';
    case 'receipt_line_not_found': return 'ไม่พบรายการนี้ในบิล — โหลดข้อมูลใหม่ให้แล้ว';
    case 'fulfillment_incomplete': return `ยังมี ${body.lineIds.length} รายการที่ยังไม่ได้ระบุว่าทำจริงไหม — ติ๊กให้ครบก่อนปิดบิล`;
    case 'discount_entry_required': return 'มีรายการที่ไม่ได้ทำ ส่วนลดที่ตกลงไว้จึงใช้ไม่ได้ — กรอกส่วนลดใหม่ (ใส่ 0 ได้) ก่อนปิดบิล';
    case 'discount_exceeds_subtotal': return `ส่วนลดมากกว่ายอดที่คิดเงิน (${baht(body.max)}) — ใส่ส่วนลดไม่เกินยอดนี้`;
    case 'discount_requires_manager':
      return `ส่วนลด ${body.percent}% เกินเพดาน ${body.ceilingPercent}% — ต้องให้ผู้จัดการ รองผู้จัดการ หรือเจ้าของเป็นคนปิดบิลนี้เอง`;
    case 'discount_reason_required': return 'ส่วนลดนี้ต้องกรอกเหตุผล';
    case 'nothing_to_bill': return 'ยอดบิลเป็น 0 — ไม่ออกใบเสร็จ (ไม่มีรายการที่ทำจริงหรือส่วนลดเท่ายอด)';
    case 'payment_short': return `เงินที่รับยังไม่พอ — ขาดอีก ${baht(body.short)} (ยอดที่ต้องชำระ ${baht(body.due)})`;
    case 'payment_over_noncash': return `โอน/บัตร เกินยอดไป ${baht(body.over)} — ทอนได้เฉพาะเงินสด แก้ยอดให้พอดี`;
    case 'payment_cash_unneeded': return 'มีเงินทอนแต่เงินสดที่รับไม่พอจะทอน — ตรวจยอดแต่ละช่องทางอีกครั้ง';
    case 'already_billed': return `งานนี้ออกใบเสร็จแล้ว เลขที่ ${body.number}`;
    case 'deposit_held': return 'ลูกค้ารายนี้มีมัดจำค้างอยู่ ระบบยังหักมัดจำไม่ได้ในรอบนี้ — ปิดบิลงานนี้ตามวิธีเดิมไปก่อน แล้วแจ้งผู้จัดการ';
    case 'receipt_required': return 'งานนี้ยังไม่ได้ปิดบิล — ต้องออกใบเสร็จก่อนจึงกด “ส่งแล้ว” ได้';
    case 'receipt_issued': return 'งานนี้ออกใบเสร็จแล้ว ย้อนกลับไม่ได้ — ต้องให้เจ้าของยกเลิกใบเสร็จก่อน';
    case 'print_content_changed':
      return `ใบนี้เคยพิมพ์ไปแล้ว ${body.printCount} ครั้ง (ล่าสุด ${thaiDateTime(body.lastPrintedAt)}) เนื้อหาเปลี่ยนหลังจากนั้น — เก็บใบเก่าคืนจากลูกค้า`;
    case 'print_not_allowed': return 'เอกสารนี้ยังพิมพ์ไม่ได้ในสถานะตอนนี้';
    case 'bill_not_presented': return 'ยังไม่ได้แจ้งยอดให้ลูกค้าดู — กด “แจ้งยอดลูกค้า” ก่อนรับเงิน';
    case 'presentation_stale': return 'รายการหรือส่วนลดเปลี่ยนหลังแจ้งยอดลูกค้าไปแล้ว — แจ้งยอดใหม่ให้ลูกค้าดูก่อนรับเงิน';
    case 'channel_not_found': return 'ไม่พบช่องทางชำระนี้ — โหลดรายการช่องทางใหม่ให้แล้ว เลือกใหม่อีกครั้ง';
    case 'channel_inactive': return 'ช่องทางชำระนี้ถูกปิดใช้งานแล้ว — เลือกช่องทางอื่น';
    case 'channel_name_taken': return 'มีช่องทางชำระชื่อนี้อยู่แล้ว — ตั้งชื่ออื่น';
    case 'last_active_channel': return 'ปิดช่องทางนี้ไม่ได้ เพราะเป็นช่องทางสุดท้ายที่ยังเปิดใช้อยู่ — เพิ่มหรือเปิดช่องทางอื่นก่อน';
    case 'record_append_only': return 'รายการนี้แก้หรือลบไม่ได้ (บันทึกเพิ่มได้อย่างเดียว)';
    case 'deposit_not_found': return 'ไม่พบมัดจำที่เลือก — โหลดบิลใหม่ให้แล้ว เลือกใหม่อีกครั้ง';
    case 'deposit_not_held': return 'มัดจำที่เลือกไม่ได้ถืออยู่แล้ว (ถูกคืน ริบ หรือหักไปแล้ว) — โหลดบิลใหม่ให้แล้ว';
    case 'deposit_customer_mismatch': return 'มัดจำที่เลือกเป็นของลูกค้าคนอื่น หักเข้าบิลนี้ไม่ได้';
    case 'deposit_not_attached': return 'มัดจำที่เลือกยังไม่ได้ผูกเข้างานนี้ — กด “ผูกเข้างานนี้” ก่อน';
    case 'deposit_exceeds_bill': return `มัดจำที่เลือกมากกว่ายอดบิล ${baht(body.over)} (หักได้ไม่เกิน ${baht(body.max)}) — เลือกน้อยลง`;
    case 'payment_not_needed': return 'มัดจำครอบคลุมยอดบิลทั้งหมดแล้ว — ไม่ต้องรับเงินช่องทางอื่น';
    case 'job_not_found': return 'ไม่พบงานนี้';
    case 'invalid_request': return 'ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจช่องที่มีข้อความสีแดง';
    case 'document_series_missing': return 'สาขานี้ยังไม่ได้ตั้งเลขที่ใบเสร็จ จึงออกใบไม่ได้ — ไม่ใช่ความผิดของคุณ กรุณาแจ้งเจ้าของร้านให้ตั้งค่า';
  }
}

export function describeBillError(err: unknown): BillFailure {
  const empty = { fields: {}, body: null } as Pick<BillFailure, 'fields' | 'body'>;
  if (isSessionCancelled(err)) return { ...empty, text: '', stale: false, cancelled: true };
  if (!(err instanceof ApiError)) return { ...empty, text: GENERIC_BILL_FAILURE, stale: false, cancelled: false };
  const code = err.message;
  const parsed = BillingBody.safeParse(err.body);
  if (parsed.success) {
    const body = parsed.data;
    const fields: Record<string, string> = {};
    if ('fields' in body && body.fields) {
      for (const [k, codes] of Object.entries(body.fields)) fields[k] = fieldCodeText(codes[0]);
    }
    if (body.error === 'discount_exceeds_subtotal' || body.error === 'discount_reason_required') {
      for (const k of Object.keys(body.fields)) fields[k] = textOf(body);
    }
    return { text: textOf(body), fields, body, stale: STALE_CODES.has(body.error), cancelled: false, code };
  }
  if (err.status === 403) return { ...empty, text: 'คุณไม่มีสิทธิ์ทำรายการนี้', stale: false, cancelled: false, code };
  if (err.status === 404) return { ...empty, text: 'ไม่พบข้อมูลนี้ — ระบบหลังบ้านอาจยังไม่เปิดใช้ส่วนนี้', stale: false, cancelled: false, code };
  if (err.status === 429) return { ...empty, text: 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่', stale: false, cancelled: false, code };
  return { ...empty, text: GENERIC_BILL_FAILURE, stale: false, cancelled: false, code };
}
