// Dates as the counter reads them: Buddhist Era, Bangkok time, built from
// Intl parts so the text is the same on every browser/OS (the prototype's
// toLocaleDateString drifted between machines). Display only.

const BKK = 'Asia/Bangkok';

function parts(iso: string | Date): Record<string, string> | null {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const out: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: BKK, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "20/10/2569" — or "-" for a missing / broken value. */
export function thaiDate(iso: string | Date | null | undefined): string {
  if (!iso) return '-';
  const p = parts(iso);
  if (!p) return '-';
  return `${p.day}/${p.month}/${Number(p.year) + 543}`;
}

/** "20/10/2569 14:05" (Bangkok). */
export function thaiDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '-';
  const p = parts(iso);
  if (!p) return '-';
  return `${p.day}/${p.month}/${Number(p.year) + 543} ${p.hour}:${p.minute}`;
}

/** "14:05" (Bangkok). */
export function thaiTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const p = parts(iso);
  return p ? `${p.hour}:${p.minute}` : '-';
}

/** Today's business date in Bangkok, "2026-10-20" — not the browser's zone. */
export function bangkokTodayKey(now: Date = new Date()): string {
  const p = parts(now);
  if (!p) return '';
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-10-20" -> "20/10/2569". */
export function dateKeyThai(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${m[3]}/${m[2]}/${Number(m[1]) + 543}`;
}

/** "3" / "1.5" — a quantity string without trailing ".00". Display only. */
export function qtyText(qty: string | null | undefined): string {
  if (qty == null) return '-';
  return qty.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
