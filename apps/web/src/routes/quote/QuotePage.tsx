import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { statusOf } from '@champpower/domain';
import type { CreateQuotationInput, JobDetail, Quotation, Role } from '@gsms/contracts/index.js';
import { QuotationPrintButton, WorkOrderPrintButton } from '../../components/print/DocPrintButtons';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { billHref, billLinkFits } from '../bill/billLabels';
import { Icon } from '../../components/ui/Icon';
import { PlateBadge } from '../../components/ui/PlateBadge';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { JobDepositsCard } from '../deposits/JobDepositsCard';
import { CatalogPanel } from './CatalogPanel';
import { QuoteActions } from './QuoteActions';
import { QuoteLines } from './QuoteLines';
import { QuoteTotalsBar, QuoteTotalsPanel } from './QuoteTotalsPanel';
import { RejectJobAction } from './RejectJobAction';
import { VehicleModelPicker } from './VehicleModelPicker';
import { canReadQuote, canWriteQuote, QUOTATION_STATUS_LABEL } from './quoteLabels';
import type { QuoteFailure } from './quoteErrors';
import { quotationPath, useQuotation } from './useQuotation';

/** The route element: /jobs/:jobId/quote. */
export function QuoteRoute({ role }: { role: Role | null }) {
  const { jobId } = useParams<{ jobId: string }>();
  if (!canReadQuote(role)) {
    // A technician sees no money at all (CLAUDE.md §12.1) — not even a page
    // that fetches it. He has the work order instead. The API refuses him too.
    return (
      <div className="empty-state" role="alert">
        หน้านี้มีราคา จึงเปิดได้เฉพาะหน้าร้านและผู้จัดการ
        <div><Link className="btn secondary" to="/today">กลับหน้างานวันนี้</Link></div>
      </div>
    );
  }
  if (!jobId) return null;
  // Keyed on the job: moving to another job's quote starts clean. The boundary
  // turns a render error into a Thai panel instead of a white app (review M1).
  return (
    <ErrorBoundary key={jobId}>
      <QuotePage jobId={jobId} canWrite={canWriteQuote(role)} />
    </ErrorBoundary>
  );
}

function JobHeader({ job, quotation, statusLabel }: { job: JobDetail | null; quotation: Quotation | null; statusLabel: string | null }) {
  const car = job ? [job.brand, job.model, job.color].filter(Boolean).join(' ') : '';
  return (
    <header className="qt-header">
      <div className="qt-header-main">
        <Link className="back-link" to="/today"><Icon name="back" size={15} /> งานวันนี้</Link>
        <h1>ใบเสนอราคา {quotation?.number ? <span className="mono">{quotation.number}</span> : null}</h1>
        {job && (
          <p className="page-sub">
            {job.jobNumber}{job.queueNo !== null && ` · คิว ${job.queueNo}`} · {car || 'ไม่ระบุรุ่น'}
            {job.customerName && ` · ${job.customerName}`} · สถานะงาน {statusLabel ?? job.statusLabel}
          </p>
        )}
      </div>
      <div className="qt-header-side">
        {job?.plate && <PlateBadge plate={job.plate} province={job.province ?? undefined} size="md" />}
        {quotation && (
          <span className="pill pill-muted">
            ฉบับที่ {quotation.revision} · {quotation.closedByJob ? 'ปิดเพราะงานจบแล้ว' : QUOTATION_STATUS_LABEL[quotation.status]}
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * ใบเสนอราคา — panel A of the prototype (D14): car/customer on top, the
 * decision row, the chosen lines with their totals, then the picker. One tree
 * at every width — only CSS changes between 390 / 820 / 1180 / 1440 — so
 * rotating a tablet mid-entry never remounts a half-typed field.
 */
export function QuotePage({ jobId, canWrite }: { jobId: string; canWrite: boolean }) {
  const job = useDocument<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`, 'job:changed');
  const { load, busy, reload, run, guard } = useQuotation(jobId);
  const [createFailure, setCreateFailure] = useState<QuoteFailure | null>(null);
  const [discountFailure, setDiscountFailure] = useState<QuoteFailure | null>(null);
  const quotation = load.phase === 'ready' ? load.quotation : null;
  // Set once this page closed the job as ไม่อนุมัติ: the job read is not live, so the header says so from the server's answer.
  const [closedLabel, setClosedLabel] = useState<string | null>(null);
  // Lives here, not in the reject dialog: the reload after a 409 status_changed can take
  // "rejected" out of allowedMoves and unmount the dialog that would have said it.
  const [jobMovedElsewhere, setJobMovedElsewhere] = useState(false);
  const mayReject = canWrite && closedLabel === null && (job.data?.allowedMoves.includes('rejected') ?? false);

  // Set by a successful "สร้างใบเสนอราคา": the add panel then mounts with the cursor in its
  // search box, so the first line is one tap away (ux P3.1 #7). Not on an ordinary open of an
  // existing draft — focusing there would pop the phone keyboard over the lines being read.
  const [justCreated, setJustCreated] = useState(false);

  async function create() {
    setCreateFailure(null);
    const body: CreateQuotationInput = {};
    const result = await run('create', () => api.post<Quotation>(quotationPath(jobId), body));
    if (result.ok) setJustCreated(true);
    else if (!result.failure.cancelled) setCreateFailure(result.failure);
  }

  async function saveDiscount(amount: string): Promise<boolean> {
    setDiscountFailure(null);
    const result = await run('discount', () => api.patch<Quotation>(quotationPath(jobId), { discount: amount }));
    if (!result.ok && !result.failure.cancelled) setDiscountFailure(result.failure);
    // The panel clears its typed draft only on true — so the box then shows the server's value.
    return result.ok;
  }

  // The right column holds the add panel while lines can be added; once they cannot (issued,
  // decided, confirmed) it would stand empty, so the totals move there and stick (≥1024).
  // Decided by the quotation's state, never by width: one tree at every width.
  const withCatalog = quotation !== null && canWrite && quotation.next.canEditContent;
  const totalsPanel = quotation && (
    <QuoteTotalsPanel
      totals={quotation.totals}
      confirmed={quotation.confirmedAt !== null}
      discountEditable={withCatalog}
      busy={busy !== null}
      saving={busy === 'discount'}
      discountError={discountFailure ? discountFailure.fields.discount ?? discountFailure.text : null}
      onSaveDiscount={saveDiscount}
    />
  );

  return (
    <div className="qt-page">
      <JobHeader job={job.data} quotation={quotation} statusLabel={closedLabel} />

      {closedLabel && <p className="ci-match" role="status">ปิดงานเป็น “ไม่อนุมัติ” แล้ว — งานออกจากกระดานงานวันนี้</p>}
      {job.error && job.data && (
        <p className="ci-nomatch" role="status">โหลดข้อมูลงานล่าสุดไม่สำเร็จ แสดงข้อมูลเดิม</p>
      )}
      {jobMovedElsewhere && (
        <p className="ci-form-error" role="alert">มีคนเปลี่ยนสถานะงานนี้ไปแล้ว — โหลดข้อมูลงานใหม่ให้แล้ว กรุณาตรวจอีกครั้งก่อนทำต่อ</p>
      )}
      {mayReject && job.data && (
        <div className="qt-reject">
          <RejectJobAction
            job={job.data}
            quotation={quotation}
            busyKey={busy}
            guard={guard}
            onRejected={(r) => { setClosedLabel(statusOf(r.status).label); void reload(); job.reload?.(); }}
            onStale={() => { void reload(); job.reload?.(); }}
            onStatusChanged={() => setJobMovedElsewhere(true)}
          />
        </div>
      )}

      {load.phase === 'loading' && <div className="page-loading">กำลังโหลดใบเสนอราคา...</div>}

      {load.phase === 'error' && (
        <div className="empty-state" role="alert">
          โหลดใบเสนอราคาไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => void reload()}>ลองใหม่</button></div>
        </div>
      )}

      {load.phase === 'missing' && (
        <div className="empty-state">
          งานนี้ยังไม่มีใบเสนอราคา
          {createFailure && <p className="ci-form-error" role="alert">{createFailure.text}</p>}
          {canWrite && (
            <div>
              <button type="button" className="btn hazard" disabled={busy !== null} onClick={() => void create()}>
                {busy === 'create' ? 'กำลังสร้าง...' : 'สร้างใบเสนอราคา'}
              </button>
            </div>
          )}
        </div>
      )}

      {quotation && (
        <div className="row-flex qt-doc-row no-print">
          {/* P3.2: the A4 paper is the control the customer signs (DECISION-2026-10-07 §2.3). */}
          <QuotationPrintButton jobId={jobId} disabled={busy !== null} />
          {quotation.status === 'signed' && <WorkOrderPrintButton jobId={jobId} disabled={busy !== null} />}
          {quotation.status === 'signed' && job.data && billLinkFits(job.data.status, job.data.jobType) && (
            <Link className="btn hazard" to={billHref(jobId)}>เก็บเงิน / ใบเสร็จ</Link>
          )}
        </div>
      )}

      {/* P3.3: the deposits of this job — the held-deposit warning, "รับมัดจำแล้ว ฿X (DEP-…)" and the balance,
          and the "รับมัดจำ" button (CLAUDE.md §5.4). Shown even before a quotation exists: a deposit can come first. */}
      {load.phase !== 'loading' && (
        <div className="no-print">
          <JobDepositsCard
            jobId={jobId}
            againstTotal={quotation ? quotation.totals.approvedTotal : null}
            who={job.data?.customerName ?? null}
            canWrite={canWrite}
            disabled={busy !== null}
          />
        </div>
      )}

      {quotation && (
        <>
          <div className="qt-layout">
            <div className="qt-main">
              {quotation.closedByJob && (
                <p className="ci-nomatch">ใบนี้ถูกระบบปิดเพราะงานจบแล้ว (ไม่ใช่การยกเลิกเอกสาร) — เก็บไว้เป็นบันทึกว่าเสนออะไรไปบ้าง</p>
              )}
              <QuoteActions jobId={jobId} quotation={quotation} canWrite={canWrite} busy={busy} run={run} onJobMoved={() => job.reload?.()} />
              <section className="card qt-lines-card" aria-label="รายการในใบเสนอราคา">
                <h3>รายการ ({quotation.lines.filter((l) => l.parentLineId === null).length})</h3>
                <QuoteLines jobId={jobId} quotation={quotation} canWrite={canWrite} busy={busy} run={run} />
                {withCatalog && totalsPanel}
              </section>
            </div>
            <aside className="qt-side">
              {withCatalog ? (
                <CatalogPanel
                  jobId={jobId}
                  busyKey={busy}
                  run={run}
                  guard={guard}
                  autoFocusSearch={justCreated}
                  // Spent once used: a later draft (after revise) must not pull focus again.
                  onAutoFocused={() => setJustCreated(false)}
                  vehicleModelLinked={quotation.vehicleModelLinked}
                  modelPicker={quotation.vehicleId && !quotation.vehicleModelLinked ? (
                    <VehicleModelPicker vehicleId={quotation.vehicleId} busyKey={busy} guard={guard} onAssigned={() => void reload()} />
                  ) : null}
                />
              ) : (
                <div className="card qt-totals-card">{totalsPanel}</div>
              )}
            </aside>
          </div>
          {/* Both totals in view at all times (CLAUDE.md §5.1 #3): sticky above the phone dock. */}
          <QuoteTotalsBar totals={quotation.totals} withCatalog={withCatalog} />
        </>
      )}
    </div>
  );
}
