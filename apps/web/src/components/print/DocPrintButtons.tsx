import type { JobDetail, Quotation, Receipt, WorkOrder } from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { PrintButton } from './PrintButton';
import { QuotationSheet } from './QuotationSheet';
import { ReceiptSheet } from './ReceiptSheet';
import { WorkOrderSheet } from './WorkOrderSheet';

const jobPath = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}`;

interface Common {
  jobId: string;
  disabled?: boolean;
  className?: string;
  label?: string;
}

/** ใบเสร็จรับเงิน — 2 copies. The content is re-read from the server first. */
export function ReceiptPrintButton({ jobId, disabled, className, label = 'พิมพ์ใบเสร็จ (2 ชุด)' }: Common) {
  return (
    <PrintButton<Receipt>
      jobId={jobId}
      docType="receipt"
      label={label}
      title="ใบเสร็จรับเงิน"
      disabled={disabled}
      className={className}
      loadData={() => api.get<Receipt>(`${jobPath(jobId)}/receipt`)}
      documentNumber={(r) => r.number}
      render={(r) => <ReceiptSheet receipt={r} />}
    />
  );
}

/** ใบเสนอราคา — draft / issued / confirmed; the server marks a draft. */
export function QuotationPrintButton({ jobId, disabled, className, label = 'พิมพ์ใบเสนอราคา (2 ชุด)' }: Common) {
  return (
    <PrintButton<{ quotation: Quotation; job: JobDetail | null }>
      jobId={jobId}
      docType="quotation"
      label={label}
      title="ใบเสนอราคา"
      disabled={disabled}
      className={className}
      loadData={async () => {
        const [quotation, job] = await Promise.all([
          api.get<Quotation>(`${jobPath(jobId)}/quotation`),
          // The header only: a failed job read prints "-" rather than no paper at all.
          api.get<JobDetail>(jobPath(jobId)).catch(() => null),
        ]);
        return { quotation, job };
      }}
      documentNumber={(d) => d.quotation.number}
      render={(d) => <QuotationSheet quotation={d.quotation} job={d.job} />}
    />
  );
}

/** ใบสั่งงาน — approved lines, no prices; technicians may print it too. */
export function WorkOrderPrintButton({ jobId, disabled, className, label = 'พิมพ์ใบสั่งงาน (2 ชุด)' }: Common) {
  return (
    <PrintButton<WorkOrder>
      jobId={jobId}
      docType="work_order"
      label={label}
      title="ใบสั่งงาน"
      disabled={disabled}
      className={className}
      loadData={() => api.get<WorkOrder>(`${jobPath(jobId)}/work-order`)}
      documentNumber={() => null}
      render={(w) => <WorkOrderSheet workOrder={w} />}
    />
  );
}
