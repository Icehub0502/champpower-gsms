import type { Job } from '../types/job.js';

export function jobPartsTotal(job: Pick<Job, 'partsNeeded'>): number {
  return (job.partsNeeded || []).reduce((sum, p) => {
    const price = parseFloat(String(p.price));
    if (!price) return sum;
    const qty = parseFloat(String(p.qty)) || 1;
    return sum + price * qty;
  }, 0);
}

/**
 * Discount in baht, whichever mode it was entered as — clamped so it can never exceed
 * the subtotal (a 20% or ฿5,000 discount on a ฿1,000 job shouldn't produce a negative
 * total).
 */
export function jobDiscountAmount(job: Pick<Job, 'partsNeeded' | 'discountValue' | 'discountType'>): number {
  const subtotal = jobPartsTotal(job);
  const val = Number(job.discountValue) || 0;
  if (val <= 0 || subtotal <= 0) return 0;
  const raw = job.discountType === 'percent' ? subtotal * (val / 100) : val;
  return Math.min(subtotal, Math.max(0, raw));
}

/** What the customer actually pays: subtotal minus the discount. */
export function jobGrandTotal(job: Pick<Job, 'partsNeeded' | 'discountValue' | 'discountType'>): number {
  return jobPartsTotal(job) - jobDiscountAmount(job);
}

/** Falls back to the hand-typed estimate when no priced parts were ever added. */
export function jobBestPrice(
  job: Pick<Job, 'partsNeeded' | 'discountValue' | 'discountType' | 'priceEstimate'>,
): number {
  const total = jobGrandTotal(job);
  if (jobPartsTotal(job) > 0) return total;
  return Number(job.priceEstimate) || 0;
}
