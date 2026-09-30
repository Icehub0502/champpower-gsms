import { SUB_STATE_LABEL, statusOf, type SubState } from '@champpower/domain';
import { ApiError } from '../../lib/api/client';

/**
 * Thai text for a refused board edit.
 *
 * WHY THIS EXISTS: the API already answers with a Thai `message`
 * (apps/api/src/routes/kanban.ts), but lib/api/client.ts `parseError` keeps
 * only the snake_case `error` code and drops `message`. client.ts is auth code
 * and out of bounds for this screen, so the words are rebuilt here from the
 * code plus what the screen already knows (the from/to status). When
 * client.ts starts carrying `message`, prefer it and delete the duplicates.
 */
export function moveErrorText(err: unknown, from: string, to: string): string {
  const code = err instanceof ApiError ? err.message : '';
  switch (code) {
    case 'status_changed':
      return 'มีคนเปลี่ยนสถานะงานนี้ไปแล้ว — โหลดกระดานใหม่ให้แล้ว กรุณาตรวจสอบอีกครั้ง';
    case 'illegal_status_move':
      return `ย้ายงานจาก "${statusOf(from).label}" ไป "${statusOf(to).label}" ไม่ได้`;
    case 'forbidden':
      return 'การรับหรือยกเลิกการตัดสินใจของลูกค้าต้องทำโดยหน้าร้าน';
    default:
      return commonErrorText(err);
  }
}

/**
 * Thai text for a refused undo of "ส่งแล้ว" (delivered -> ready).
 *
 * Not moveErrorText: its 403 wording is about the customer's quote decision,
 * which is the wrong sentence for this action.
 */
export function undoErrorText(err: unknown): string {
  const code = err instanceof ApiError ? err.message : '';
  switch (code) {
    case 'status_changed':
      return 'มีคนเปลี่ยนสถานะงานนี้ไปแล้ว — โหลดข้อมูลใหม่ให้แล้ว กรุณาตรวจสอบอีกครั้ง';
    case 'illegal_status_move':
      return 'ย้อนกลับงานนี้ไม่ได้ — งานไม่ได้อยู่ในสถานะ “ส่งแล้ว” หรือถูกดำเนินการต่อไปแล้ว';
    case 'forbidden':
      return 'คุณไม่มีสิทธิ์ย้อนกลับรายการนี้';
    default:
      return commonErrorText(err);
  }
}

/** Words for one server-side field code on the reason box (400 `fields.reason`). */
export function reasonFieldText(code: string | undefined): string {
  switch (code) {
    case 'required':
    case 'too_small':
      return 'กรุณากรอกเหตุผลที่ย้อนกลับ';
    case 'too_big':
      return 'เหตุผลยาวเกินไป (ไม่เกิน 500 ตัวอักษร)';
    case 'not_allowed':
      return 'การย้อนกลับครั้งนี้ไม่รับเหตุผล — โหลดข้อมูลงานใหม่แล้วลองอีกครั้ง';
    default:
      return 'เหตุผลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';
  }
}

export function subStateErrorText(err: unknown, subState: SubState | null, status: string): string {
  const code = err instanceof ApiError ? err.message : '';
  switch (code) {
    case 'invalid_sub_state':
      return `ป้าย "${subState === null ? '' : SUB_STATE_LABEL[subState]}" ใช้กับงานสถานะ "${statusOf(status).label}" ไม่ได้`;
    case 'forbidden':
      return 'การบันทึกว่าชำระแล้วต้องทำโดยหน้าร้าน';
    default:
      return commonErrorText(err);
  }
}

function commonErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.message === 'job_not_found') return 'ไม่พบใบงานนี้';
    if (err.status === 403) return 'คุณไม่มีสิทธิ์ทำรายการนี้';
    if (err.status === 429) return 'ทำรายการถี่เกินไป กรุณารอสักครู่แล้วลองใหม่';
  }
  return 'บันทึกไม่สำเร็จ กรุณาลองใหม่';
}

/** Did the server refuse because the board the user was looking at is stale? */
export function isStaleBoard(err: unknown): boolean {
  return err instanceof ApiError && (err.message === 'status_changed' || err.message === 'job_not_found');
}

/** Refusals that mean the job is no longer what the panel showed. */
export function isStaleJob(err: unknown): boolean {
  return isStaleBoard(err) || (err instanceof ApiError && err.message === 'illegal_status_move');
}
