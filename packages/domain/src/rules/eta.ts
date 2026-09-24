import type { Job } from '../types/job.js';
import { fmtMins, fmtSecs } from '../utils/format.js';

export const EST_MINUTES = [5, 10, 15, 20, 30, 40, 45, 50] as const;
export const EST_HOURS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export const EST_DAYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export interface EstUnitDef {
  key: 'minute' | 'hour' | 'day';
  label: string;
  word: string;
  mult: number;
  nums: readonly number[];
}

export const EST_UNITS: EstUnitDef[] = [
  { key: 'minute', label: 'นาที', word: 'นาที', mult: 1, nums: EST_MINUTES },
  { key: 'hour', label: 'ชั่วโมง', word: 'ชั่วโมง', mult: 60, nums: EST_HOURS },
  { key: 'day', label: 'วัน', word: 'วัน', mult: 1440, nums: EST_DAYS },
];

export function estUnitDef(key: string | undefined): EstUnitDef {
  return EST_UNITS.find((u) => u.key === key) ?? EST_UNITS[1]!;
}

/** The estimate as plain minutes — the single source of truth everything else derives from. */
export function estMinutes(job: Pick<Job, 'estValue' | 'estUnit'> | null | undefined): number {
  if (!job || !job.estValue) return 0;
  return Math.round((Number(job.estValue) || 0) * estUnitDef(job.estUnit).mult);
}

/** "1 ชม. 30 น." rather than "90 น." or "1.5 ชม.", whatever unit it was entered in. */
export function estLabel(job: Pick<Job, 'estValue' | 'estUnit'> | null | undefined): string {
  const m = estMinutes(job);
  return m ? fmtMins(m) : '';
}

/**
 * The countdown starts when the car goes on the lift, not at check-in — a car can sit
 * for hours waiting for the customer to approve the quote, and counting that time would
 * make every job look late. It stops the moment the car is พร้อมส่ง.
 *
 * Only the CURRENT pass counts. A car can go round more than once (delivered, brought
 * back, put on a lift again — or the ส่งแล้ว flag undone), and statusHistory keeps every
 * old entry. Reading the first 'repairing' meant a car back in the bay still showed the
 * previous visit's finish time and a clock that never moved. So: find the LAST
 * 'repairing', and only look for a finish after it.
 */
export const WORK_DONE_STATUSES = ['ready', 'delivered', 'carout'];
export const PRE_REPAIR_STATUSES = ['received', 'inspecting', 'quoted', 'approved', 'scheduled', 'rejected'];

export interface RepairCycle {
  start: string;
  end: string;
}

export function repairCycle(job: Pick<Job, 'status' | 'statusHistory'> | null | undefined): RepairCycle {
  const h = (job && job.statusHistory) || [];
  // Sent back to a stage before the work starts — no clock at all.
  if (job && PRE_REPAIR_STATUSES.indexOf(job.status) !== -1) return { start: '', end: '' };
  let startIdx = -1;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i]?.status === 'repairing') {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return { start: '', end: '' };
  let end = '';
  for (let i = startIdx + 1; i < h.length; i++) {
    const status = h[i]?.status;
    if (status && WORK_DONE_STATUSES.indexOf(status) !== -1) {
      end = h[i]?.changedAt || '';
      break;
    }
  }
  return { start: h[startIdx]?.changedAt || '', end };
}

export function repairStartedAt(job: Pick<Job, 'status' | 'statusHistory'> | null | undefined): string {
  return repairCycle(job).start;
}

export function repairEndedAt(job: Pick<Job, 'status' | 'statusHistory'> | null | undefined): string {
  return repairCycle(job).end;
}

export type EtaPhase = 'pending' | 'done' | 'late' | 'running';

export interface EtaState {
  phase: EtaPhase;
  text: string;
  sub?: string;
  pct: number;
}

/**
 * Everything the countdown needs, recomputed from the current clock. Returned as data
 * rather than markup so a 1-second tick can rewrite text in place instead of rebuilding
 * the whole card.
 *
 * `now` defaults to the real clock, so every existing caller is unchanged. It is a
 * parameter because the kanban's "how many cars are over SLA" count (rules/kanban.ts)
 * must give the same answer for the same rows in a test, and a function that reads
 * Date.now() behind the caller's back cannot.
 */
export function etaState(
  estMins: number,
  workStart: string,
  workEnd: string,
  now: number = Date.now(),
): EtaState | null {
  const mins = Number(estMins) || 0;
  if (!mins) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  const hhmm = (t: number) => {
    const d = new Date(t);
    return `${p(d.getHours())}:${p(d.getMinutes())} น.`;
  };

  if (!workStart) return { phase: 'pending', text: 'ประมาณ ' + fmtMins(mins), pct: 0 };
  const start = new Date(workStart).getTime();
  if (!isFinite(start)) return { phase: 'pending', text: 'ประมาณ ' + fmtMins(mins), pct: 0 };
  const end = start + mins * 60000;

  // Work already finished — the clock is frozen at what it actually took.
  if (workEnd) {
    const fin = new Date(workEnd).getTime();
    if (isFinite(fin)) {
      const used = Math.round((fin - start) / 1000);
      return {
        phase: 'done',
        text: 'ซ่อมเสร็จแล้ว',
        sub: 'ใช้เวลา ' + fmtSecs(used) + ' · เสร็จ ' + hhmm(fin),
        pct: 100,
      };
    }
  }

  const left = Math.round((end - now) / 1000); // seconds, so the display can tick
  if (left <= 0) {
    return { phase: 'late', text: 'เลยเวลา ' + fmtSecs(-left), sub: 'กำหนดเดิม ' + hhmm(end), pct: 100 };
  }
  const pct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  return {
    phase: 'running',
    text: 'เหลืออีก ' + fmtSecs(left),
    sub: 'เสร็จประมาณ ' + hhmm(end),
    pct: Math.round(pct * 10) / 10,
  };
}
