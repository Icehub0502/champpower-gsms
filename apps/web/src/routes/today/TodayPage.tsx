import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  KANBAN_COLUMNS,
  matchesSearch,
  type KanbanColumn,
  type StatusKey,
  type SubState,
} from '@champpower/domain';
import type {
  JobDetail,
  TodayJob,
  UpdateJobStatusInput,
  UpdateJobStatusResult,
  UpdateSubStateResult,
} from '@gsms/contracts/index.js';
import { Icon } from '../../components/ui/Icon';
import { api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { useTodayBoard } from './useTodayBoard';
import { useCardDrag } from './useCardDrag';
import { KanbanColumnView } from './KanbanColumnView';
import { KanbanCard } from './KanbanCard';
import { CardActionSheet } from './CardActionSheet';
import { DeliverConfirmDialog } from './DeliverConfirmDialog';
import { DeliveredPanel } from './DeliveredPanel';
import { useMinute } from './clock';
import { KpiRow } from './KpiRow';
import { PulsePanel } from './PulsePanel';
import { moveErrorText, subStateErrorText, isStaleBoard, isReceiptRequired } from './messages';
import { billHref, billLinkFits } from '../bill/billLabels';

const COLUMN_NUMBERS = KANBAN_COLUMNS.map((c) => c.column);

function jobBlob(job: TodayJob): string {
  const plate = job.plate ?? '';
  return [job.jobNumber, plate, plate.replace(/[\s-]/g, ''), job.brand, job.model, job.customerName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

interface FilterState {
  overSlaOnly: boolean;
  warrantyOnly: boolean;
  bookedOnly: boolean;
}

const NO_FILTERS: FilterState = { overSlaOnly: false, warrantyOnly: false, bookedOnly: false };

function activeFilterCount(f: FilterState): number {
  return Number(f.overSlaOnly) + Number(f.warrantyOnly) + Number(f.bookedOnly);
}

interface Toast {
  text: string;
  tone: 'error' | 'info';
}

/**
 * ศูนย์ควบคุมงานวันนี้ — Figma 80 (REDESIGN V3), DECISION-job-status.md.
 *
 * Every decision about a card (column, label, tone, the 4 KPIs, the pulse
 * panel) is made server-side by packages/domain and sent resolved; this
 * screen renders what it is given and makes none of those calls itself.
 *
 * One tree at every width (docs/UI-SPEC-FIGMA.md §4 rule 2): the columns,
 * the KPI row and the pulse panel are always mounted, and only CSS (the
 * kb-board / kb-kpi-grid rules in globals.css) changes between the 1-column
 * phone layout, the 2-visible tablet strip and the 4-column desktop grid —
 * so rotating a tablet mid-drag or mid-search never remounts this page.
 */
export function TodayPage({ canOpenQuote = false, canOpenBill = false }: { canOpenQuote?: boolean; canOpenBill?: boolean }) {
  const { data, error, reload, applyMove, applySubState } = useTodayBoard();

  // The card check-in just created (App.tsx CheckInRoute navigates here with
  // this in router state, since /jobs/:jobId is closed — see App.tsx). Read
  // once into local state, not on every render off `location`, because the
  // history entry's state is cleared right after (below) but the visible
  // highlight should still hold for a few seconds.
  const location = useLocation();
  const navigate = useNavigate();
  const [highlightJobId, setHighlightJobId] = useState<string | null>(
    () => (location.state as { highlightJobId?: string } | null)?.highlightJobId ?? null,
  );
  const scrolledToRef = useRef<string | null>(null);

  useEffect(() => {
    // Clear the router state immediately (once) so refreshing this page, or
    // navigating back to it later, does not replay the highlight.
    if (location.state) navigate(location.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!highlightJobId || !data || scrolledToRef.current === highlightJobId) return;
    if (!data.jobs.some((j) => j.jobId === highlightJobId)) return; // not in this load yet — wait for the next poll
    scrolledToRef.current = highlightJobId;
    const selector = `[data-job-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(highlightJobId) : highlightJobId}"]`;
    document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = window.setTimeout(() => setHighlightJobId(null), 4000);
    return () => window.clearTimeout(t);
  }, [highlightJobId, data]);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterState>(NO_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  // Looked up from the live board by id, not snapshotted at tap time — so the
  // sheet shows the current status and sub-state after an edit, and closes by
  // itself if the job leaves the board (another user closed it, or a poll).
  const openJob = (openJobId && data?.jobs.find((j) => j.jobId === openJobId)) || null;
  // ส่งแล้ว always asks first (DECISION-carout.md §2). Held by id and looked up
  // on the live board, like openJob, so the dialog closes by itself if the job
  // leaves the board underneath it.
  const [pendingDeliverId, setPendingDeliverId] = useState<string | null>(null);
  const pendingDeliver = (pendingDeliverId && data?.jobs.find((j) => j.jobId === pendingDeliverId)) || null;
  const [deliveredOpen, setDeliveredOpen] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  // Delivery gate (B1): the API refused ส่งแล้ว because the bill is not closed — the dialog links to the bill screen.
  const [deliverNeedsBill, setDeliverNeedsBill] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  function showToast(text: string, tone: Toast['tone']) {
    setToast({ text, tone });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  }

  // The board's shared clock (clock.ts), snapped to the minute — read here
  // instead of Date.now() so this filter is a pure function of state, and at
  // minute resolution so the page (every column and card under it) does not
  // re-render once a second. The card countdowns tick per second on their own.
  const now = useMinute();

  const visibleJobs = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.jobs.filter((job) => {
      if (q && !matchesSearch(jobBlob(job), q)) return false;
      if (filters.warrantyOnly && job.jobType !== 'warranty_claim') return false;
      if (filters.bookedOnly && job.source !== 'booked') return false;
      if (filters.overSlaOnly) {
        // Cheap client check mirroring slaOf's 'late' phase (estimate ran out
        // while repair is running, unfinished): good enough for a filter
        // toggle — the authoritative overSla count is the pulse panel's,
        // computed server-side by pulseOf().
        if (!job.sla || !job.sla.repairStartedAt || job.sla.repairEndedAt) return false;
        const end = Date.parse(job.sla.repairStartedAt) + job.sla.estMinutes * 60000;
        if (!(now > end)) return false;
      }
      return true;
    });
  }, [data, search, filters, now]);

  const byColumn = useMemo(() => {
    const map = new Map<KanbanColumn, TodayJob[]>();
    for (const n of COLUMN_NUMBERS) map.set(n, []);
    for (const job of visibleJobs) map.get(job.column)?.push(job);
    return map;
  }, [visibleJobs]);

  async function moveJob(job: TodayJob, to: StatusKey) {
    setBusyJobId(job.jobId);
    setSheetError(null);
    try {
      const body: UpdateJobStatusInput = { to, fromStatus: job.status };
      const result = await api.patch<UpdateJobStatusResult>(`/api/jobs/${job.jobId}/status`, body);
      applyMove(result);
      setOpenJobId(null);
      setPendingDeliverId(null);
      void reload();
    } catch (err) {
      if (isSessionCancelled(err)) return; // logged out / switched user: no toast
      const text = moveErrorText(err, job.status, to);
      setDeliverNeedsBill(to === 'delivered' && isReceiptRequired(err));
      const stale = isStaleBoard(err);
      if (openJobId === job.jobId || pendingDeliverId === job.jobId) setSheetError(text);
      // A stale refusal reloads the board, and the job the dialog was about may
      // be gone by then — so the words also go where they cannot vanish.
      if (!(openJobId === job.jobId || pendingDeliverId === job.jobId) || stale) showToast(text, 'error');
      // The server is the rule — never keep a move the request was refused
      // for. Reloading also recovers from `status_changed` by showing
      // whatever another user actually did.
      if (stale) void reload();
    } finally {
      setBusyJobId(null);
    }
  }

  // The single door for every status move a person starts (tap menu or drop).
  // ส่งแล้ว goes through the confirm dialog; nothing else is asked.
  function requestMove(job: TodayJob, to: StatusKey) {
    if (to === 'delivered') {
      setSheetError(null);
      setOpenJobId(null);
      setPendingDeliverId(job.jobId);
      return;
    }
    void moveJob(job, to);
  }

  function handleUndone(detail: JobDetail) {
    setDeliveredOpen(false);
    // Back on the board after the reload below; outline it once it lands.
    scrolledToRef.current = null;
    setHighlightJobId(detail.jobId);
    showToast(`ย้อนกลับแล้ว — ${detail.plate ?? detail.jobNumber} กลับมาที่ “พร้อมส่ง”`, 'info');
    void reload();
  }

  async function setSubState(job: TodayJob, subState: SubState | null) {
    setBusyJobId(job.jobId);
    setSheetError(null);
    try {
      const result = await api.patch<UpdateSubStateResult>(`/api/jobs/${job.jobId}/sub-state`, { subState });
      applySubState(result);
    } catch (err) {
      if (isSessionCancelled(err)) return;
      const text = subStateErrorText(err, subState, job.status);
      if (openJobId === job.jobId) setSheetError(text);
      else showToast(text, 'error');
    } finally {
      setBusyJobId(null);
    }
  }

  const drag = useCardDrag(COLUMN_NUMBERS, (job, column) => {
    // The drop lands on the first of the column's statuses (MAIN_PATH order)
    // that is in this card's server-sent `allowedMoves` — the same list the tap
    // menu shows, so a drag can never send a move the menu would not offer.
    // A drop on the card's own column is not a move.
    const def = KANBAN_COLUMNS.find((c) => c.column === column);
    const to =
      def && column !== job.column ? (def.statuses.find((s) => job.allowedMoves.includes(s)) ?? null) : null;
    if (to === null) {
      showToast('วางการ์ดในคอลัมน์เดิม หรือย้ายไปคอลัมน์ที่ทำต่อไม่ได้', 'info');
      return;
    }
    requestMove(job, to);
  });

  return (
    <div className="kb-page">
      <header className="kb-header">
        <div>
          <h1>ศูนย์ควบคุมงานวันนี้</h1>
          <p className="page-sub">
            เห็นคอขวด SLA ช่องซ่อม และงานที่ต้องตัดสินใจ
            {data && ` • อัปเดต ${new Date(data.generatedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.`}
          </p>
        </div>
        <div className="kb-header-actions">
          <div className="kb-header-search">
            <Icon name="search" size={16} />
            <input
              placeholder="ค้นหาเลขงาน / ทะเบียน / ลูกค้า"
              aria-label="ค้นหา"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="kb-filter-wrap">
            <button type="button" className="btn secondary" onClick={() => setFilterOpen((o) => !o)}>
              ตัวกรอง {activeFilterCount(filters) > 0 ? activeFilterCount(filters) : ''}
            </button>
            {filterOpen && (
              <div className="kb-filter-pop">
                <label className="kb-filter-item">
                  <input
                    type="checkbox"
                    checked={filters.overSlaOnly}
                    onChange={(e) => setFilters((f) => ({ ...f, overSlaOnly: e.target.checked }))}
                  />
                  เฉพาะงานเกิน SLA
                </label>
                <label className="kb-filter-item">
                  <input
                    type="checkbox"
                    checked={filters.warrantyOnly}
                    onChange={(e) => setFilters((f) => ({ ...f, warrantyOnly: e.target.checked }))}
                  />
                  เฉพาะงานประกัน
                </label>
                <label className="kb-filter-item">
                  <input
                    type="checkbox"
                    checked={filters.bookedOnly}
                    onChange={(e) => setFilters((f) => ({ ...f, bookedOnly: e.target.checked }))}
                  />
                  เฉพาะงานที่มาจากการนัดหมาย
                </label>
              </div>
            )}
          </div>
          <button type="button" className="btn secondary" onClick={() => setDeliveredOpen(true)}>
            <Icon name="checkCircle" size={15} /> ส่งแล้ววันนี้
          </button>
          <Link className="btn kb-header-cta" to="/checkin">
            <Icon name="plus" size={15} /> รับรถ
          </Link>
        </div>
      </header>

      {error && !data && (
        <div className="empty-state" role="alert">
          โหลดกระดานไม่สำเร็จ
          <div style={{ marginTop: 10 }}>
            <button type="button" className="btn secondary" onClick={() => void reload()}>
              ลองใหม่
            </button>
          </div>
        </div>
      )}

      {!data && !error && <div className="page-loading">กำลังโหลดกระดาน...</div>}

      {data && (
        <>
          {error && <p className="kb-stale-banner" role="status">อัปเดตล่าสุดไม่สำเร็จ — ข้อมูลนี้อาจไม่ใหม่ที่สุด</p>}

          <KpiRow kpis={data.kpis} />

          <div className="kb-board">
            {KANBAN_COLUMNS.map((def) => (
              <KanbanColumnView
                key={def.column}
                def={def}
                jobs={byColumn.get(def.column) ?? []}
                busyJobId={busyJobId}
                draggingJobId={drag.dragging?.job.jobId ?? null}
                isDropTarget={drag.hoverColumn === def.column}
                onOpen={(job) => {
                  setSheetError(null);
                  setOpenJobId(job.jobId);
                }}
                onCardPointerDown={drag.onCardPointerDown}
                swallowClick={drag.consumeDragClick}
                bodyRef={drag.registerColumnRef(def.column)}
                highlightedJobId={highlightJobId}
              />
            ))}
          </div>

          <PulsePanel pulse={data.pulse} />
        </>
      )}

      {drag.dragging && (
        <div
          className="kb-drag-ghost"
          style={{ left: drag.dragging.x, top: drag.dragging.y }}
          aria-hidden="true"
        >
          <KanbanCard
            job={drag.dragging.job}
            busy={false}
            dragging={false}
            onOpen={() => {}}
            onPointerDown={() => {}}
            swallowClick={() => false}
          />
        </div>
      )}

      {openJob && (
        <CardActionSheet
          job={openJob}
          busy={busyJobId === openJob.jobId}
          errorText={sheetError}
          quoteHref={canOpenQuote ? `/jobs/${encodeURIComponent(openJob.jobId)}/quote` : null}
          billHref={canOpenBill && billLinkFits(openJob.status, openJob.jobType) ? billHref(openJob.jobId) : null}
          onClose={() => setOpenJobId(null)}
          onMoveStatus={(to) => requestMove(openJob, to)}
          onSetSubState={(s) => void setSubState(openJob, s)}
        />
      )}

      {pendingDeliver && (
        <DeliverConfirmDialog
          job={pendingDeliver}
          busy={busyJobId === pendingDeliver.jobId}
          errorText={sheetError}
          billHref={deliverNeedsBill && canOpenBill ? billHref(pendingDeliver.jobId) : null}
          onConfirm={() => void moveJob(pendingDeliver, 'delivered')}
          onCancel={() => {
            setSheetError(null);
            setDeliverNeedsBill(false);
            setPendingDeliverId(null);
          }}
        />
      )}

      {deliveredOpen && <DeliveredPanel onClose={() => setDeliveredOpen(false)} onUndone={handleUndone} />}

      {toast && (
        // A refusal is announced (role="alert") and says so in words — the red
        // background is never the only thing telling staff the move failed.
        <div className={`kb-toast tone-${toast.tone}`} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone === 'error' && <strong>ไม่สำเร็จ: </strong>}
          {toast.text}
        </div>
      )}
    </div>
  );
}
