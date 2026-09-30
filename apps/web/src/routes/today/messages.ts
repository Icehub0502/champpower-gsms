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
