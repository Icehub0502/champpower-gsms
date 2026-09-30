import { IntakeRefusal, type IntakeRefusal as IntakeRefusalT } from '@gsms/contracts/index.js';
import { ApiError } from '../../lib/api/client';

/**
 * What a refused check-in asks of the counter.
 *
 * `err.body` is read ONLY through IntakeRefusal.safeParse — never cast. The
 * schemas are .strict(), so a body with an unexpected field (a phone on a
 * candidate, say) fails here and is treated as an unknown error: nothing from
 * a body that did not parse is shown, not even part of it (security review of
 * ApiError.body, 25 Sep 2026). Never log the body — the owner-mismatch body
 * carries customer names (CLAUDE.md §12).
 *
 * Refusals arrive as 400, 404, 409 and 500 alike, so the body is parsed
 * whatever the status; the status only picks the fallback when it does not
 * parse.
 */
export type SubmitFailure =
  | { kind: 'refusal'; refusal: IntakeRefusalT }
  | { kind: 'generic'; text: string };

export const GENERIC_FAILURE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่ — ข้อมูลที่กรอกไว้ยังอยู่ครบ';

export function readSubmitFailure(err: unknown): SubmitFailure {
  if (err instanceof ApiError) {
    const parsed = IntakeRefusal.safeParse(err.body);
    if (parsed.success) return { kind: 'refusal', refusal: parsed.data };
    if (err.status === 403) return { kind: 'generic', text: 'คุณไม่มีสิทธิ์รับรถในสาขานี้' };
    if (err.status === 429) return { kind: 'generic', text: 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่' };
  }
  return { kind: 'generic', text: GENERIC_FAILURE };
}

/**
 * The payload-less refusals, in words that tell the counter what to DO.
 * The server's own `message` is not shown: these are written for this screen,
 * and can never carry a value the counter typed back into the page.
 */
export const REFUSAL_TEXT = {
  unknown_bay: 'ช่องซ่อมที่เลือกไม่มีในสาขานี้แล้ว — เลือกช่องอื่น หรือเว้นว่างไว้',
  unknown_file: 'มีรูปที่ส่งไปไม่ถึงระบบ — กด “ลองใหม่” หรือ “ลบ” ที่รูปนั้น แล้วบันทึกอีกครั้ง',
  // Same words whether the car does not exist, does not match the plate, or is
  // not this shop's: the server answers all three alike and so does the screen.
  unknown_vehicle: 'ไม่พบรถคันที่เลือก กรุณาค้นหาทะเบียนใหม่',
  vehicle_plate_mismatch: 'ทะเบียนที่พิมพ์ไม่ตรงกับรถที่เลือก กรุณาตรวจทะเบียนหรือเลือกรถใหม่',
  booking_not_found: 'ไม่พบใบนัดนี้ในสาขา — อาจถูกลบไปแล้ว ให้รับรถแบบ Walk-in แทน',
  booking_already_arrived: 'ใบนัดนี้เปิดงานไปแล้ว — รถคันนี้อยู่บนกระดานงานวันนี้แล้ว ไม่ต้องบันทึกซ้ำ',
  booking_not_open: 'ใบนัดนี้ถูกยกเลิกหรือถูกบันทึกว่าไม่มาแล้ว — ให้รับรถแบบ Walk-in แทน',
  job_number_series_missing:
    'สาขานี้ยังไม่ได้ตั้งค่าเลขที่ใบงาน จึงเปิดงานไม่ได้ — ไม่ใช่ความผิดของคุณ กรุณาแจ้งผู้จัดการให้ตั้งค่า ข้อมูลที่กรอกไว้ยังอยู่ครบ',
} as const satisfies Partial<Record<IntakeRefusalT['error'], string>>;

/**
 * Contract field names (CheckInInput) that have NO input of their own on this
 * screen — named in words when an `invalid_request` points at them, instead of
 * being dropped. Keyed by contract name; the text never includes the value.
 */
export const OFF_SCREEN_FIELD_LABEL: Record<string, string> = {
  photoFileIds: 'รูปรถ',
  jobDate: 'วันที่รับรถ',
  bayId: 'ช่องซ่อม',
  customerId: 'ลูกค้าที่เลือกจากเบอร์โทร',
  confirmOwnerChange: 'การยืนยันเปลี่ยนเจ้าของรถ',
};
