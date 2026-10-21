import { DepositBody, type DepositBody as DepositBodyT } from '@gsms/contracts/index.js';
import { ApiError } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { baht } from '../../lib/money';
import { thaiDateTime } from '../../lib/printFormat';
import { DEPOSIT_STATUS_LABEL } from './depositLabels';
import { fieldCodeText } from '../quote/quoteErrors';

/**
 * What a refused deposit request tells the counter. Same rule as billErrors.ts:
 * the body is read ONLY through the contract's DepositBody.safeParse; a body
 * that does not parse is an unknown error and none of it is shown. The
 * server's own `message` is never echoed (it may name a customer).
 */
export interface DepositFailure {
  text: string;
  fields: Record<string, string>;
  body: DepositBodyT | null;
  /** The deposit on screen no longer matches the server: reload it. */
  stale: boolean;
  cancelled: boolean;
}

export const GENERIC_DEPOSIT_FAILURE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่ — ข้อมูลที่กรอกไว้ยังอยู่ครบ';

const STALE_CODES = new Set([
  'deposit_not_found', 'deposit_not_held', 'deposit_job_mismatch', 'deposit_not_attached', 'deposit_locked', 'job_already_billed',
]);

function textOf(body: DepositBodyT): string {
  switch (body.error) {
    case 'deposit_not_found': return 'ไม่พบมัดจำรายการนี้ — โหลดข้อมูลใหม่ให้แล้ว';
    case 'deposit_not_held': return `มัดจำนี้ไม่ได้ถืออยู่แล้ว (สถานะ: ${DEPOSIT_STATUS_LABEL[body.status]}) — โหลดข้อมูลใหม่ให้แล้ว`;
    case 'deposit_customer_mismatch': return 'มัดจำนี้เป็นของลูกค้าคนอื่น ผูกเข้างานนี้ไม่ได้';
    case 'deposit_job_mismatch': return 'มัดจำนี้ผูกกับงานอื่นอยู่แล้ว';
    case 'deposit_not_attached': return 'มัดจำนี้ยังไม่ได้ผูกเข้างานนี้ — กด “ผูกเข้างานนี้” ก่อน';
    case 'deposit_exceeds_bill': return `มัดจำที่เลือกมากกว่ายอดบิลอยู่ ${baht(body.over)} (หักได้ไม่เกิน ${baht(body.max)}) — เลือกน้อยลง หรือคืนมัดจำส่วนนั้น`;
    case 'forfeit_requires_manager': return 'ริบมัดจำได้เฉพาะผู้จัดการขึ้นไป';
    case 'deposit_slip_unavailable': return 'มัดจำนี้ปิดไปแล้วโดยยังไม่เคยพิมพ์ใบ จึงพิมพ์ใบรับเงินมัดจำไม่ได้';
    case 'job_not_found': return 'ไม่พบงานนี้';
    case 'customer_not_found': return 'ไม่พบลูกค้ารายนี้ในระบบ — ค้นหาเบอร์โทรใหม่ หรือบันทึกเป็นลูกค้าใหม่';
    case 'job_already_billed': return 'งานนี้ปิดบิลไปแล้ว ผูกมัดจำเข้าไม่ได้ — ถ้าต้องคืนเงินให้กด “คืนมัดจำ” ที่หน้ามัดจำค้างอยู่';
    case 'deposit_locked': return 'มัดจำรายการนี้เปลี่ยนไม่ได้ในสถานะตอนนี้ — โหลดข้อมูลใหม่ให้แล้ว';
    case 'invalid_request': return 'ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจช่องที่มีข้อความสีแดง';
    case 'document_series_missing': return 'สาขานี้ยังไม่ได้ตั้งเลขที่ใบรับเงินมัดจำ (DEP) จึงพิมพ์ไม่ได้ — ไม่ใช่ความผิดของคุณ กรุณาแจ้งเจ้าของร้านให้ตั้งค่า';
    case 'print_content_changed':
      return `ใบนี้เคยพิมพ์ไปแล้ว ${body.printCount} ครั้ง (ล่าสุด ${thaiDateTime(body.lastPrintedAt)}) เนื้อหาเปลี่ยนหลังจากนั้น — เก็บใบเก่าคืนจากลูกค้า`;
  }
}

/** Field codes the deposit form names that the quotation's table does not. */
function depositFieldText(code: string | undefined): string {
  switch (code) {
    case 'customer_required': return 'ระบุลูกค้า (ชื่อและเบอร์โทร)';
    case 'invalid_phone': return 'เบอร์โทรไม่ถูกต้อง — ตัวเลข 9–10 หลัก';
    case 'invalid_date': return 'วันที่ไม่ถูกต้อง';
    case 'in_the_past': return 'วันที่นัดต้องไม่ก่อนวันนี้';
    case 'must_be_positive': return 'ยอดมัดจำต้องมากกว่า 0';
    case 'unknown_file': return 'ไม่พบรูปสลิปที่แนบ — เอาออกแล้วแนบรูปใหม่อีกครั้ง';
    default: return fieldCodeText(code);
  }
}

export function describeDepositError(err: unknown): DepositFailure {
  const empty = { fields: {}, body: null } as Pick<DepositFailure, 'fields' | 'body'>;
  if (isSessionCancelled(err)) return { ...empty, text: '', stale: false, cancelled: true };
  if (!(err instanceof ApiError)) return { ...empty, text: GENERIC_DEPOSIT_FAILURE, stale: false, cancelled: false };
  const parsed = DepositBody.safeParse(err.body);
  if (parsed.success) {
    const body = parsed.data;
    const fields: Record<string, string> = {};
    if (body.error === 'invalid_request') {
      for (const [k, codes] of Object.entries(body.fields)) fields[k] = depositFieldText(codes[0]);
      // The slip box on screen is keyed 'slip'.
      if (fields.slipFileId) fields.slip = fields.slipFileId;
    }
    return { text: textOf(body), fields, body, stale: STALE_CODES.has(body.error), cancelled: false };
  }
  if (err.status === 403) return { ...empty, text: 'คุณไม่มีสิทธิ์ทำรายการนี้', stale: false, cancelled: false };
  if (err.status === 404) return { ...empty, text: 'ไม่พบข้อมูลนี้ — ระบบหลังบ้านอาจยังไม่เปิดใช้ส่วนนี้', stale: false, cancelled: false };
  if (err.status === 429) return { ...empty, text: 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่', stale: false, cancelled: false };
  return { ...empty, text: GENERIC_DEPOSIT_FAILURE, stale: false, cancelled: false };
}

export { depositFieldText };
