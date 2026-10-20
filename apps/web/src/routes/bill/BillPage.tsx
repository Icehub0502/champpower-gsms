import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  CloseReceiptResult, JobDetail, Receipt, Role, TaxInvoiceRequest, TaxInvoiceRequestInput, VoidReceiptInput,
} from '@gsms/contracts/index.js';
import { ReceiptPrintButton } from '../../components/print/DocPrintButtons';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import { Icon } from '../../components/ui/Icon';
import { PlateBadge } from '../../components/ui/PlateBadge';
import { ReasonDialog } from '../../components/ui/ReasonDialog';
import { useDocument } from '../../hooks/useDocument';
import { api } from '../../lib/api/client';
import { baht } from '../../lib/money';
import { thaiDateTime } from '../../lib/printFormat';
import type { BillFailure } from './billErrors';
import { canReadBill, canWriteBill, PAYMENT_METHOD_LABEL, RECEIPT_STATUS_LABEL } from './billLabels';
import { DiscountPanel } from './DiscountPanel';
import { FulfillmentList } from './FulfillmentList';
import { PaymentPanel } from './PaymentPanel';
import { receiptPath, useReceipt, type ReceiptState } from './useReceipt';

/** The route element: /jobs/:jobId/bill. */
export function BillRoute({ role }: { role: Role | null }) {
  const { jobId } = useParams<{ jobId: string }>();
  if (!canReadBill(role)) {
    // A technician sees no money (CLAUDE.md §12.1); the API refuses him too.
    return (
      <div className="empty-state" role="alert">
        หน้านี้มีราคาและยอดเงิน จึงเปิดได้เฉพาะหน้าร้านและผู้จัดการ
        <div><Link className="btn secondary" to="/today">กลับหน้างานวันนี้</Link></div>
      </div>
    );
  }
  if (!jobId) return null;
  return (
    <ErrorBoundary key={jobId}>
      <BillPage jobId={jobId} canWrite={canWriteBill(role)} />
    </ErrorBoundary>
  );
}

/**
 * เก็บเงิน / ใบเสร็จ of one job (P3.2): tick what was really done → discount →
 * take the money → ปิดบิล (one server transaction: payments + number +
 * freeze) → print two copies. Every total on this page is the server's; the
 * page only previews with the same domain functions the API uses.
 *
 * One tree at every width — only CSS moves the side column under the lines
 * below 1024px — so rotating a tablet never remounts a half-typed amount.
 */
export function BillPage({ jobId, canWrite }: { jobId: string; canWrite: boolean }) {
  const job = useDocument<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`, 'job:changed');
  const state = useReceipt(jobId);
  const { load, busy, run } = state;
  const [createFailure, setCreateFailure] = useState<BillFailure | null>(null);
  const [closed, setClosed] = useState<CloseReceiptResult | null>(null);
  const receipt = load.phase === 'ready' ? load.receipt : null;
  const isClaim = job.data?.jobType === 'warranty_claim';

  async function create() {
    setCreateFailure(null);
    const result = await run('create', () => api.post<Receipt>(receiptPath(jobId), {}));
    if (!result.ok && !result.failure.cancelled) setCreateFailure(result.failure);
  }

  return (
    <div className="qt-page bl-page">
      <header className="qt-header">
        <div className="qt-header-main">
          <Link className="back-link" to="/today"><Icon name="back" size={15} /> งานวันนี้</Link>
          <h1>เก็บเงิน / ใบเสร็จ {receipt?.number && <span className="mono">{receipt.number}</span>}</h1>
          {job.data && (
            <p className="page-sub">
              {job.data.jobNumber} · {[job.data.brand, job.data.model].filter(Boolean).join(' ') || 'ไม่ระบุรุ่น'}
              {job.data.customerName && ` · ${job.data.customerName}`} · สถานะงาน {job.data.statusLabel}
            </p>
          )}
        </div>
        <div className="qt-header-side">
          {job.data?.plate && <PlateBadge plate={job.data.plate} province={job.data.province ?? undefined} size="md" />}
          {receipt && <span className={`pill ${receipt.status === 'void' ? 'pill-danger' : receipt.status === 'issued' ? 'pill-success' : 'pill-muted'}`}>{RECEIPT_STATUS_LABEL[receipt.status]}</span>}
          <Link className="btn secondary small" to={`/jobs/${encodeURIComponent(jobId)}/quote`}>ใบเสนอราคา</Link>
        </div>
      </header>

      {isClaim && <p className="ci-nomatch">งานเคลมประกันไม่ออกใบเสร็จ (ไม่มีการขาย)</p>}

      {load.phase === 'loading' && <div className="page-loading">กำลังโหลดบิล...</div>}
      {load.phase === 'error' && (
        <div className="empty-state" role="alert">
          โหลดบิลไม่สำเร็จ
          <div><button type="button" className="btn secondary" onClick={() => void state.reload()}>ลองใหม่</button></div>
        </div>
      )}
      {load.phase === 'missing' && !isClaim && (
        <div className="empty-state">
          ยังไม่ได้เริ่มทำบิลของงานนี้
          <p className="qt-line-sub">ระบบจะดึงรายการที่ลูกค้าอนุมัติจากใบเสนอราคาที่ยืนยันแล้ว มาให้ติ๊กว่าทำจริงไหม</p>
          {createFailure && <p className="ci-form-error" role="alert">{createFailure.text}</p>}
          {canWrite && (
            <div>
              <button type="button" className="btn hazard" disabled={busy !== null} onClick={() => void create()}>
                {busy === 'create' ? 'กำลังเริ่ม...' : 'เริ่มทำบิล'}
              </button>
            </div>
          )}
        </div>
      )}

      {receipt && (
        <>
          {closed && receipt.status === 'issued' && <ClosedBanner result={closed} jobId={jobId} />}
          {receipt.status === 'draft' && <DraftBody jobId={jobId} receipt={receipt} canWrite={canWrite} state={state} onClosed={setClosed} />}
          {receipt.status !== 'draft' && <IssuedBody jobId={jobId} receipt={receipt} state={state} canWrite={canWrite} />}
          <TaxInvoiceFlag jobId={jobId} receipt={receipt} canWrite={canWrite} state={state} />
        </>
      )}
    </div>
  );
}

function DraftBody({ jobId, receipt, canWrite, state, onClosed }: {
  jobId: string; receipt: Receipt; canWrite: boolean; state: ReceiptState; onClosed: (r: CloseReceiptResult) => void;
}) {
  const { busy, run, guard, show } = state;
  const [rebuildFailure, setRebuildFailure] = useState<BillFailure | null>(null);

  async function rebuild() {
    setRebuildFailure(null);
    const result = await run('rebuild', () => api.post<Receipt>(`${receiptPath(jobId)}/rebuild`, {}));
    if (!result.ok && !result.failure.cancelled) setRebuildFailure(result.failure);
  }

  return (
    <div className="qt-layout bl-layout">
      <div className="qt-main">
        {receipt.quotationChanged && (
          <div className="ci-form-error bl-banner" role="alert">
            <span>ใบเสนอราคาเปลี่ยนหลังจากเริ่มทำบิลนี้ (เช่น ลูกค้าอนุมัติงานเพิ่ม) — ต้องโหลดรายการใหม่และติ๊กใหม่ ก่อนปิดบิล</span>
            {canWrite && (
              <button type="button" className="btn secondary small" disabled={busy !== null} onClick={() => void rebuild()}>
                {busy === 'rebuild' ? 'กำลังโหลด...' : 'โหลดรายการใหม่จากใบเสนอราคา'}
              </button>
            )}
          </div>
        )}
        {rebuildFailure && <p className="ci-form-error" role="alert">{rebuildFailure.text}</p>}
        <FulfillmentList jobId={jobId} receipt={receipt} busy={busy} run={run} />
        <DiscountPanel jobId={jobId} receipt={receipt} busy={busy} run={run} />
      </div>
      <aside className="qt-side bl-side">
        <TotalsCard receipt={receipt} />
        {canWrite && <PaymentPanel jobId={jobId} receipt={receipt} busy={busy} guard={guard} show={show} onClosed={onClosed} />}
      </aside>
    </div>
  );
}

function TotalsCard({ receipt }: { receipt: Receipt }) {
  const t = receipt.totals;
  return (
    <section className="card bl-totals" aria-label="ยอดบิล">
      <h3>ยอด</h3>
      <dl className="bl-kv">
        <dt>รวมรายการที่ทำ</dt><dd className="mono">{baht(t.subtotal)}</dd>
        <dt>ส่วนลด</dt><dd className="mono">{baht(t.discount)}</dd>
      </dl>
      <p className="qt-totals-sum">ยอดบิล <span className="mono">{baht(t.billTotal)}</span></p>
      <p className="qt-line-sub">ยอดที่ตกลงในใบเสนอราคา {baht(t.agreedTotal)}{receipt.quotationNumber && ` (${receipt.quotationNumber})`}</p>
    </section>
  );
}

function ClosedBanner({ result, jobId }: { result: CloseReceiptResult; jobId: string }) {
  return (
    <section className="card bl-closed" role="status">
      <p className="bl-closed-no">ปิดบิลแล้ว · ใบเสร็จเลขที่ <span className="mono">{result.receipt.number}</span></p>
      {result.change !== '0.00' && <p className="bl-closed-change">ทอนเงินลูกค้า <strong className="mono">{baht(result.change)}</strong></p>}
      {result.replayed && <p className="qt-line-sub">บิลนี้ปิดไปแล้วก่อนหน้า (กดซ้ำ) — แสดงใบเดิม ไม่มีการรับเงินซ้ำ</p>}
      <div className="row-flex">
        <ReceiptPrintButton jobId={jobId} className="btn hazard" />
        <Link className="btn secondary" to="/today">กลับงานวันนี้</Link>
      </div>
    </section>
  );
}

function IssuedBody({ jobId, receipt, state, canWrite }: { jobId: string; receipt: Receipt; state: ReceiptState; canWrite: boolean }) {
  const top = receipt.lines.filter((l) => l.parentLineId === null).sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <div className="qt-layout bl-layout">
      <div className="qt-main">
        {receipt.status === 'void' && (
          <p className="ci-form-error" role="alert">
            ใบเสร็จนี้ถูกยกเลิกเมื่อ {thaiDateTime(receipt.voidedAt)} โดย {receipt.voidedByName ?? '-'} — เหตุผล: {receipt.voidReason ?? '-'}
          </p>
        )}
        <section className="card" aria-label="รายการในใบเสร็จ">
          <h3>รายการ</h3>
          <ul className="bl-list">
            {top.map((l) => (
              <li key={l.id} className={`bl-line${l.state === 'not_done' ? ' is-off' : ''}`}>
                <div className="bl-line-main">
                  <span className="bl-line-name">{l.name}</span>
                  {l.state === 'not_done' && <span className="qt-line-sub">อนุมัติแต่ไม่ได้ทำ — ไม่คิดเงิน</span>}
                </div>
                <div className="bl-line-money"><strong className="mono">{l.charged !== null ? baht(l.charged) : '—'}</strong></div>
              </li>
            ))}
          </ul>
        </section>
        <section className="card" aria-label="การรับเงิน">
          <h3>รับเงิน</h3>
          <dl className="bl-kv">
            {receipt.payments.map((p) => (
              <PaymentRow key={p.id} label={`${PAYMENT_METHOD_LABEL[p.method]}${p.reversed ? ' (คืนแล้ว)' : ''}`} amount={p.amount} change={p.method === 'cash' ? p.changeGiven : null} />
            ))}
            <dt>รับสุทธิ</dt><dd className="mono">{baht(receipt.paidNet)}</dd>
          </dl>
          <p className="qt-line-sub">ปิดบิล {thaiDateTime(receipt.issuedAt)} โดย {receipt.issuedByName ?? '-'}</p>
        </section>
      </div>
      <aside className="qt-side bl-side">
        <TotalsCard receipt={receipt} />
        <section className="card">
          <h3>พิมพ์</h3>
          <ReceiptPrintButton jobId={jobId} />
          {receipt.status === 'issued' && receipt.next.canVoid && canWrite && <VoidReceiptAction jobId={jobId} state={state} />}
        </section>
        {receipt.status === 'void' && canWrite && <RestartBill jobId={jobId} state={state} />}
      </aside>
    </div>
  );
}

function PaymentRow({ label, amount, change }: { label: string; amount: string; change: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="mono">{baht(amount)}{change !== null && change !== '0.00' ? ` · ทอน ${baht(change)}` : ''}</dd>
    </>
  );
}

/** After a void (A-1): a new draft for the same job; the void one keeps its number in the sequence. */
function RestartBill({ jobId, state }: { jobId: string; state: ReceiptState }) {
  const [failure, setFailure] = useState<BillFailure | null>(null);
  return (
    <section className="card">
      <h3>ออกใบเสร็จใหม่</h3>
      <button
        type="button"
        className="btn hazard"
        disabled={state.busy !== null}
        onClick={() => {
          setFailure(null);
          void state.run('create', () => api.post<Receipt>(receiptPath(jobId), {})).then((r) => {
            if (!r.ok && !r.failure.cancelled) setFailure(r.failure);
          });
        }}
      >
        {state.busy === 'create' ? 'กำลังเริ่ม...' : 'เริ่มทำบิลใหม่'}
      </button>
      {failure && <p className="ci-form-error" role="alert">{failure.text}</p>}
    </section>
  );
}

/** Owner only (§12.1) — the server's `next.canVoid` decides whether it is offered. */
function VoidReceiptAction({ jobId, state }: { jobId: string; state: ReceiptState }) {
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<BillFailure | null>(null);
  return (
    <>
      <button type="button" className="btn danger" disabled={state.busy !== null} onClick={() => { setFailure(null); setOpen(true); }}>
        ยกเลิกใบเสร็จ…
      </button>
      {open && (
        <ReasonDialog
          title="ยกเลิกใบเสร็จ"
          confirmLabel="ยืนยันยกเลิกใบเสร็จ"
          required
          danger
          busy={state.busy === 'void'}
          errorText={failure?.text}
          fieldError={failure?.fields.reason}
          onCancel={() => setOpen(false)}
          onConfirm={(reason) => {
            const body: VoidReceiptInput = { reason: reason ?? '' };
            void state.run('void', () => api.post<Receipt>(`${receiptPath(jobId)}/void`, body)).then((r) => {
              if (r.ok) setOpen(false);
              else if (!r.failure.cancelled) setFailure(r.failure);
            });
          }}
        >
          <p>เลขที่ใบเสร็จยังอยู่ในลำดับ (สถานะ “ยกเลิก”) และเงินที่รับไว้จะถูกบันทึกว่าคืนลูกค้าในวันนี้ — ถ้าต้องออกใหม่ ให้เริ่มทำบิลใหม่หลังยกเลิก</p>
          <p>ใบที่พิมพ์ไปแล้วให้เก็บคืนจากลูกค้า</p>
        </ReasonDialog>
      )}
    </>
  );
}

/**
 * B8: the customer asked for a tax invoice. A flag on the job only — this
 * system issues none yet (VAT room is a later release); the shop handles it
 * outside and the flag lets them find these jobs later.
 */
function TaxInvoiceFlag({ jobId, receipt, canWrite, state }: { jobId: string; receipt: Receipt; canWrite: boolean; state: ReceiptState }) {
  const [failure, setFailure] = useState<BillFailure | null>(null);
  const checked = receipt.taxInvoiceRequested;
  async function toggle() {
    setFailure(null);
    const body: TaxInvoiceRequestInput = { requested: !checked };
    const result = await state.guard('tax', () => api.put<TaxInvoiceRequest>(`/api/jobs/${encodeURIComponent(jobId)}/tax-invoice-request`, body));
    if (result.ok) void state.reload();
    else if (!result.failure.cancelled) setFailure(result.failure);
  }
  return (
    <section className="card bl-tax">
      <label className="bl-check">
        <input type="checkbox" checked={checked} disabled={!canWrite || state.busy !== null} onChange={() => void toggle()} />
        <span>ลูกค้าขอใบกำกับภาษี</span>
        {state.busy === 'tax' && <span className="qt-line-sub"> กำลังบันทึก...</span>}
      </label>
      <p className="qt-line-sub">ระบบนี้ยังไม่ออกใบกำกับภาษี — ติ๊กไว้เพื่อให้บัญชีตามออกให้ภายหลัง ใบเสร็จที่พิมพ์ไม่ใช่ใบกำกับภาษี</p>
      {failure && <p className="ci-form-error" role="alert">{failure.text}</p>}
    </section>
  );
}
