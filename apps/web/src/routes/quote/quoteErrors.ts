import { QuotationBody, type QuotationBody as QuotationBodyT } from '@gsms/contracts/index.js';
import { ApiError } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { baht } from '../../lib/money';

/**
 * What a refused quotation / catalog request tells the counter.
 *
 * `err.body` is read ONLY through the contract's QuotationBody.safeParse —
 * never cast (same rule as routes/checkin/refusal.ts). A body that does not
 * parse is an unknown error: no part of it is shown. The words are written for
 * this screen and say what to DO; the server's own `message` is not echoed.
 */
export interface QuoteFailure {
  /** One sentence for the banner / dialog. Empty when the failure is only per-field. */
  text: string;
  /** Contract field name -> Thai text, shown next to that field. */
  fields: Record<string, string>;
  /** Line ids the refusal names (amount_over_2x, set_amount_required, ...). */
  lineIds: string[];
  /** The parsed body, for flows that need its data (price_already_set, similar_item_found). */
  body: QuotationBodyT | null;
  /** The screen is out of date: reload the quotation. */
  stale: boolean;
  /** Logged out / switched user mid-request: show nothing. */
  cancelled: boolean;
}

export const GENERIC_QUOTE_FAILURE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่ — ข้อมูลที่กรอกไว้ยังอยู่ครบ';

/** Field codes (apps/api lib/fieldErrors.ts + the domain's line issues) in words. Never includes the value. */
export function fieldCodeText(code: string | undefined): string {
  switch (code) {
    case 'required':
    case 'too_small':
      return 'จำเป็นต้องกรอก';
    case 'invalid_money':
      return 'จำนวนเงินไม่ถูกต้อง — ใส่ตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง';
    case 'invalid_qty':
    case 'qty_invalid':
    case 'qty_not_positive':
      return 'จำนวนต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง';
    case 'unit_price_invalid':
    case 'unit_price_negative':
      return 'ราคาต้องเป็นตัวเลข 0 ขึ้นไป';
    case 'out_of_range':
      return 'ยอดเงินเกินที่ระบบรองรับ';
    case 'labor_not_vatable':
      return 'ค่าแรงไม่เข้า VAT';
    case 'too_big':
      return 'ยาวเกินไป (ไม่เกิน 500 ตัวอักษร)';
    case 'not_allowed':
      return 'ช่องนี้ไม่ต้องกรอก';
    default:
      return 'ข้อมูลไม่ถูกต้อง';
  }
}

/** Refusals meaning the page no longer matches the server: reload after showing the words. */
const STALE_CODES = new Set([
  'quotation_not_found', 'quotation_line_not_found', 'quotation_exists', 'quotation_not_draft',
  'quotation_not_issued', 'quotation_frozen', 'quotation_confirmed', 'decisions_incomplete',
  'approved_amount_not_allowed', 'job_not_open', 'document_frozen', 'document_line_frozen',
]);

function textOf(body: QuotationBodyT): string {
  switch (body.error) {
    case 'quotation_not_found': return 'ไม่พบใบเสนอราคานี้ — อาจถูกปิดหรือมีฉบับใหม่แล้ว โหลดข้อมูลใหม่ให้แล้ว';
    case 'quotation_line_not_found': return 'ไม่พบรายการนี้ — อาจถูกลบไปแล้ว โหลดข้อมูลใหม่ให้แล้ว';
    case 'job_not_found': return 'ไม่พบงานนี้';
    case 'catalog_item_not_found': return 'ไม่พบรายการนี้ในแคตตาล็อก — อาจถูกรวมหรือปิดไปแล้ว ลองค้นหาใหม่';
    case 'vehicle_model_not_found': return 'ไม่พบรุ่นรถนี้ — ลองค้นหาใหม่';
    case 'offered_item_not_found': return 'ไม่พบรายการที่เคยเสนอไว้ — ลองค้นหาใหม่';
    case 'forbidden': return 'คุณไม่มีสิทธิ์ทำรายการนี้';
    case 'quotation_exists': return 'งานนี้มีใบเสนอราคาอยู่แล้ว — เปิดใบเดิมให้แล้ว';
    case 'quotation_not_draft': return 'ใบเสนอราคานี้ออกเลขแล้ว แก้รายการไม่ได้ — ถ้าต้องแก้ให้กด “ออกฉบับแก้ไข”';
    case 'quotation_not_issued': return 'ใบเสนอราคานี้ไม่ได้อยู่ในขั้นรอลูกค้าตัดสินใจแล้ว — โหลดข้อมูลใหม่ให้แล้ว';
    case 'quotation_frozen': return 'ใบเสนอราคานี้ปิดแล้ว แก้ไม่ได้ — ถ้าต้องแก้ให้ออกฉบับแก้ไข';
    case 'quotation_empty': return 'ยังไม่มีรายการในใบเสนอราคา — เพิ่มรายการก่อนออกใบ';
    case 'decisions_incomplete': return `ยังมี ${body.lineIds.length} รายการที่ลูกค้ายังไม่ตัดสินใจ — ตัดสินให้ครบก่อนยืนยัน`;
    case 'set_amount_required': return 'ชุดที่ตัดบางรายการออกต้องกรอกยอดใหม่ก่อนยืนยัน';
    case 'amount_over_2x':
      return `ยอดนี้เกิน 2 เท่าของราคาที่เสนอ (เสนอ ${baht(body.offered)} · สูงสุด ${baht(body.max)}) น่าจะพิมพ์ผิด ถ้าตั้งใจจริงให้ออกใบเสนอราคาฉบับใหม่`;
    case 'amount_above_offer_free_set': return 'ชุดนี้เสนอไว้ที่ 0 บาท จะเพิ่มราคาต้องออกใบเสนอราคาฉบับใหม่';
    case 'approved_amount_not_allowed': return 'ชุดนี้ไม่ต้องกรอกยอดใหม่แล้ว — โหลดข้อมูลใหม่ให้แล้ว';
    case 'undo_confirm_different_day': return 'ถอยการยืนยันได้เฉพาะวันเดียวกับที่ยืนยัน — ถ้าต้องแก้ให้ออกฉบับแก้ไข';
    case 'undo_confirm_job_moved_on': return 'งานนี้ไปขั้นตอนต่อไปแล้ว ถอยการยืนยันไม่ได้ — ถ้าต้องแก้ให้ออกฉบับแก้ไข';
    case 'quotation_confirmed': return 'ใบเสนอราคานี้ยืนยันผลแล้ว — ถอยการยืนยันหรือออกฉบับแก้ไขก่อน';
    case 'price_already_set': return `ราคานี้ถูกตั้งไปแล้วเป็น ${baht(body.existingPrice)}`;
    case 'similar_item_found': return `คล้ายกับ “${body.similar[0]!.name}” ที่มีอยู่แล้ว ใช่อันเดียวกันไหม`;
    case 'catalog_item_exists': return 'มีรายการชื่อนี้ในหมวดนี้อยู่แล้ว';
    case 'merge_not_allowed': return 'รวมรายการนี้ไม่ได้';
    case 'merge_price_conflict': return 'ราคาของสองรายการชนกันในบางรุ่นรถ ต้องเลือกก่อน';
    case 'vehicle_model_exists': return 'รุ่นรถนี้มีอยู่ในรายการแล้ว';
    case 'invalid_request': return 'ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจช่องที่มีข้อความสีแดง';
    case 'document_series_missing': return 'สาขานี้ยังไม่ได้ตั้งเลขที่ใบเสนอราคา จึงออกใบไม่ได้ — ไม่ใช่ความผิดของคุณ กรุณาแจ้งเจ้าของร้านให้ตั้งค่า';
    case 'warranty_term_not_found': return 'ไม่พบเงื่อนไขการรับประกันนี้ — เลือกใหม่';
    case 'vehicle_not_found': return 'ไม่พบรถคันนี้';
    case 'job_not_open': return 'งานนี้จบไปแล้ว ทำใบเสนอราคาเพิ่มไม่ได้';
    case 'quotation_missing': return 'งานนี้ยังไม่มีใบเสนอราคา';
    case 'quotation_not_confirmed': return 'ใบเสนอราคายังไม่ได้ยืนยันผลลูกค้า — โหลดข้อมูลใหม่ให้แล้ว';
  }
}

function lineIdsOf(body: QuotationBodyT): string[] {
  if ('lineIds' in body) return body.lineIds;
  if ('lineId' in body) return [body.lineId];
  return [];
}

export function describeQuoteError(err: unknown): QuoteFailure {
  const empty: Pick<QuoteFailure, 'fields' | 'lineIds' | 'body'> = { fields: {}, lineIds: [], body: null };
  if (isSessionCancelled(err)) return { ...empty, text: '', stale: false, cancelled: true };
  if (!(err instanceof ApiError)) return { ...empty, text: GENERIC_QUOTE_FAILURE, stale: false, cancelled: false };

  const parsed = QuotationBody.safeParse(err.body);
  if (parsed.success) {
    const body = parsed.data;
    const fields: Record<string, string> = {};
    if (body.error === 'invalid_request' && body.fields) {
      for (const [k, codes] of Object.entries(body.fields)) fields[k] = fieldCodeText(codes[0]);
    }
    return {
      text: textOf(body),
      fields,
      lineIds: lineIdsOf(body),
      body,
      stale: STALE_CODES.has(body.error),
      cancelled: false,
    };
  }
  // GS002 from the freeze trigger (lib/pgError.ts) is not in QuotationBody; the code alone is enough.
  if (err.message === 'document_frozen' || err.message === 'document_line_frozen') {
    return { ...empty, text: 'ใบเสนอราคานี้ถูกล็อกแล้ว แก้ไม่ได้ — โหลดข้อมูลใหม่ให้แล้ว', stale: true, cancelled: false };
  }
  if (err.status === 403) return { ...empty, text: 'คุณไม่มีสิทธิ์ทำรายการนี้', stale: false, cancelled: false };
  if (err.status === 429) return { ...empty, text: 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่', stale: false, cancelled: false };
  return { ...empty, text: GENERIC_QUOTE_FAILURE, stale: false, cancelled: false };
}
