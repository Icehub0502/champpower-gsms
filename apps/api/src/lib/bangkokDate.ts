/**
 * The shop's calendar day.
 *
 * Every date in this module is the Thai one. `jobs.job_date` is a `date`, the
 * queue-number uniqueness key is (shop, job_date, queue_no), and the board's
 * default window is "today .. +7" — all three mean the day it is in Samut
 * Prakan, not the day it is in UTC. A car received at 08:00 Bangkok on the 16th
 * is `2026-09-16`, even though UTC still says the 15th.
 *
 * Thailand has observed a fixed +07:00 with no daylight saving since 1920, so
 * the offset is written literally rather than computed. That is a deliberate
 * simplification and it is the reason `startOfDay` can be a one-liner instead
 * of a timezone-library call; if Thailand ever adopts DST this file is the one
 * place that has to change.
 */

const OFFSET = '+07:00'

const BANGKOK_YMD = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Today in Bangkok, as `YYYY-MM-DD`. */
export function bangkokToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape `date` wants.
  return BANGKOK_YMD.format(now)
}

/** `YYYY-MM-DD` + n days, staying on the Thai calendar. */
export function addDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00${OFFSET}`)
  if (Number.isNaN(t)) throw new Error(`not a date: ${ymd}`)
  return BANGKOK_YMD.format(new Date(t + days * 86_400_000))
}

/** The instant a Thai calendar day begins, for comparing against timestamptz. */
export function startOfDay(ymd: string): Date {
  const t = Date.parse(`${ymd}T00:00:00${OFFSET}`)
  if (Number.isNaN(t)) throw new Error(`not a date: ${ymd}`)
  return new Date(t)
}

/**
 * The instant AFTER a Thai calendar day ends — the exclusive upper bound.
 *
 * Exclusive on purpose: `at < endOfDayExclusive(to)` includes a booking at
 * 23:59:59.999 on `to` without the half-open/closed confusion that a `<=`
 * against 23:59:59 quietly introduces.
 */
export function endOfDayExclusive(ymd: string): Date {
  return startOfDay(addDays(ymd, 1))
}
