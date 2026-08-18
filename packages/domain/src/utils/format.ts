export function fmtMoney(n: number | string | null | undefined): string {
  const num = Number(n) || 0;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "18/08/2026 14:05" — plain local date/time, used for timeline entries and logs. */
export function fmtDT(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2 วัน 3 ชม." / "3 ชม. 12 น." / "8 น." — the plain estimate, no false-precision seconds. */
export function fmtMins(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) {
    let s = `${d} วัน`;
    if (h > 0) s += ` ${h} ชม.`;
    if (mm > 0) s += ` ${mm} น.`;
    return s;
  }
  if (h > 0) return mm > 0 ? `${h} ชม. ${mm} น.` : `${h} ชม.`;
  return `${mm} น.`;
}

/** The live countdown, down to the second: "1 ชม. 12 น. 07 ว." Seconds drop past a day. */
export function fmtSecs(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return h > 0 ? `${d} วัน ${h} ชม. ${p(m)} น.` : `${d} วัน ${p(m)} น.`;
  if (h > 0) return `${h} ชม. ${p(m)} น. ${p(ss)} ว.`;
  if (m > 0) return `${m} น. ${p(ss)} ว.`;
  return `${ss} ว.`;
}
