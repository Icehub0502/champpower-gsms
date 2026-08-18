/**
 * Dates are keyed in LOCAL time — using the ISO string's leading 10 characters would
 * bucket by UTC and put anything checked in after 07:00 Thai time on the wrong day.
 * Ported verbatim from the original app (v2.6.0 fixed this exact bug).
 */
export function dayKey(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function todayKey(): string {
  return dayKey(new Date());
}

export function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return dayKey(dt);
}

/** "วันนี้" / "เมื่อวาน" / "พรุ่งนี้" / "จ. 4 ส.ค. 69" */
export function dayLabel(key: string): string {
  if (key === todayKey()) return 'วันนี้';
  if (key === shiftDay(todayKey(), -1)) return 'เมื่อวาน';
  if (key === shiftDay(todayKey(), 1)) return 'พรุ่งนี้';
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  const days = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  const months = [
    'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
  ];
  return `${days[dt.getDay()]} ${d} ${months[m - 1]} ${String(y + 543).slice(-2)}`;
}
