import type { Customer, Vehicle } from '../types/vehicle.js';
import type { Job } from '../types/job.js';
import { fmtMoney } from '../utils/format.js';
import { jobDiscountAmount, jobGrandTotal, jobPartsTotal } from './pricing.js';

const CLOSING_BY_STATUS: Record<string, string> = {
  received: 'รอเช็ค',
  inspecting: 'รอเช็ค',
  quoted: 'รอลูกค้าตัดสินใจ',
  approved: 'อนุมัติ',
  rejected: 'ไม่อนุมัติ',
  repairing: 'กำลังซ่อม',
  aligning: 'รอตั้งศูนย์',
  ready: 'พร้อมส่ง',
  delivered: 'ส่งแล้ว',
  carout: 'เอารถลง',
};

/** "19/8/69" — short d/m/yy in the Thai Buddhist Era, used in the LINE group post. */
export function fmtDateBE(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const beYear = d.getFullYear() + 543;
  return `${d.getDate()}/${d.getMonth() + 1}/${String(beYear).slice(-2)}`;
}

/**
 * The message counter staff paste into the shop's LINE group — one call per job so the
 * check-in post and the later quote-update post always agree on formatting.
 */
export function buildLineSummaryText(job: Job, vehicle: Vehicle | undefined, customer: Customer | undefined): string {
  const lines: string[] = [];
  const q = (job.queueNo || '').trim();
  lines.push(`คิวที่${q ? ` (${q})` : ''} ${fmtDateBE(job.createdAt)}`);
  lines.push(`คุณ${customer?.name || '-'}`);
  lines.push(customer?.phone || '-');
  lines.push(`${vehicle?.plate || '-'}${vehicle?.province || ''}`);
  lines.push(`${vehicle?.brand || ''} ${vehicle?.model || ''}`.trim() || '-');
  lines.push(vehicle?.color || '-');

  lines.push('อาการ');
  if (!job.complaints || job.complaints.length === 0) {
    lines.push('- ไม่มีข้อมูล');
  } else {
    job.complaints.forEach((c) => lines.push(`- ${c.text}`));
  }

  const parts = job.partsNeeded || [];
  if (parts.length > 0) {
    lines.push('');
    lines.push('รายการเสนอราคา');
    parts.forEach((p) => {
      const qty = parseFloat(String(p.qty)) || 1;
      const price = parseFloat(String(p.price)) || 0;
      const qtyTxt = p.qty ? ` ${p.qty} ${p.unit || ''}`.trimEnd() : '';
      const brandTxt = p.brand ? ` (${p.brand})` : '';
      const priceTxt = price ? ` = ${fmtMoney(price * qty)}` : '';
      lines.push(`- ${p.name}${qtyTxt}${brandTxt}${priceTxt}`);
    });
    const total = jobPartsTotal(job);
    if (total > 0) {
      const discountAmt = jobDiscountAmount(job);
      if (discountAmt > 0) {
        lines.push(`รวม ${fmtMoney(total)} บาท`);
        lines.push(
          `ส่วนลด ${job.discountType === 'percent' ? `${job.discountValue}%` : `${fmtMoney(discountAmt)} บาท`}`,
        );
        lines.push(`ยอดสุทธิ ${fmtMoney(jobGrandTotal(job))} บาท`);
      } else {
        lines.push(`รวม ${fmtMoney(total)} บาท`);
      }
    }
  } else if (Number(job.priceEstimate) > 0) {
    lines.push('');
    lines.push(`ราคาประมาณ ${fmtMoney(Number(job.priceEstimate))} บาท`);
  }

  lines.push(CLOSING_BY_STATUS[job.status] || 'รอเช็ค');
  return lines.join('\n');
}
