import type { Job } from '../types/job.js';
import type { Vehicle } from '../types/vehicle.js';
import { deliveredAtOf } from '../rules/warranty.js';
import { jobBestPrice } from '../rules/pricing.js';
import { dayKey, dayLabel, shiftDay, todayKey } from '../utils/date.js';

export interface DayBucket {
  revenue: number;
  count: number;
}

export interface FinanceStats {
  todayRev: number;
  weekRev: number;
  monthRev: number;
  yearRev: number;
  allRev: number;
  todayCount: number;
  weekCount: number;
  monthCount: number;
  yearCount: number;
  totalCount: number;
  avgJobValue: number;
  byDay: Record<string, DayBucket>;
  byTech: Record<string, DayBucket>;
  byBrand: Record<string, DayBucket>;
}

type DeliveredJob = Pick<
  Job,
  'statusHistory' | 'createdAt' | 'partsNeeded' | 'discountValue' | 'discountType' | 'priceEstimate' | 'technician' | 'vehicleId'
>;

/** Only ever fed delivered jobs — stats are "revenue from cars actually handed back". */
export function financeStats(deliveredJobs: DeliveredJob[], vehicleById: Map<string, Vehicle>): FinanceStats {
  const today = todayKey();
  const monthKey = today.slice(0, 7);
  const yearKey = today.slice(0, 4);
  const weekStart = shiftDay(today, -6); // last 7 days, inclusive of today

  const stats: FinanceStats = {
    todayRev: 0, weekRev: 0, monthRev: 0, yearRev: 0, allRev: 0,
    todayCount: 0, weekCount: 0, monthCount: 0, yearCount: 0,
    totalCount: deliveredJobs.length,
    avgJobValue: 0,
    byDay: {}, byTech: {}, byBrand: {},
  };

  for (const job of deliveredJobs) {
    const dk = dayKey(deliveredAtOf(job));
    const price = jobBestPrice(job);
    stats.allRev += price;
    if (dk === today) { stats.todayRev += price; stats.todayCount++; }
    if (dk >= weekStart) { stats.weekRev += price; stats.weekCount++; }
    if (dk.slice(0, 7) === monthKey) { stats.monthRev += price; stats.monthCount++; }
    if (dk.slice(0, 4) === yearKey) { stats.yearRev += price; stats.yearCount++; }

    stats.byDay[dk] ??= { revenue: 0, count: 0 };
    stats.byDay[dk]!.revenue += price;
    stats.byDay[dk]!.count++;

    const techName = job.technician || 'ไม่ระบุช่าง';
    stats.byTech[techName] ??= { revenue: 0, count: 0 };
    stats.byTech[techName]!.revenue += price;
    stats.byTech[techName]!.count++;

    const brand = vehicleById.get(job.vehicleId)?.brand || 'ไม่ระบุยี่ห้อ';
    stats.byBrand[brand] ??= { revenue: 0, count: 0 };
    stats.byBrand[brand]!.revenue += price;
    stats.byBrand[brand]!.count++;
  }

  stats.avgJobValue = deliveredJobs.length ? stats.allRev / deliveredJobs.length : 0;
  return stats;
}

export interface FinanceDayPoint {
  key: string;
  label: string;
  revenue: number;
  count: number;
}

/**
 * A fixed 14-day window ending today, zero-filled — so the chart always has 14 bars
 * even on days with no deliveries, rather than only plotting days that happened to have
 * revenue (which would make the bar spacing lie about how much time passed).
 */
export function financeLast14Days(byDay: Record<string, DayBucket>): FinanceDayPoint[] {
  const arr: FinanceDayPoint[] = [];
  for (let i = 13; i >= 0; i--) {
    const k = shiftDay(todayKey(), -i);
    const d = byDay[k];
    arr.push({ key: k, label: dayLabel(k), revenue: d ? d.revenue : 0, count: d ? d.count : 0 });
  }
  return arr;
}
