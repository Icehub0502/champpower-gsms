/** Ported from the original app's friendlyApiError() — translates raw HTTP/JSON errors
 *  from Claude/Gemini into short Thai messages a counter-staff user can read. */
export function friendlyApiError(provider: 'claude' | 'gemini', status: number, body: string): string {
  if (status === 401 || status === 403) return 'คีย์ API ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้งาน';
  if (status === 429) return 'ใช้งานเกินโควตาชั่วคราว กรุณาลองใหม่อีกครั้งในอีกสักครู่';
  if (status >= 500) return `เซิร์ฟเวอร์ของ ${provider === 'claude' ? 'Claude' : 'Gemini'} ขัดข้องชั่วคราว`;
  return `เรียก AI ไม่สำเร็จ (${status}): ${body.slice(0, 200)}`;
}

export const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
export const MAX_AI_RETRIES = 2;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
