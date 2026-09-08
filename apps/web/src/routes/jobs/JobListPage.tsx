import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  dayScopedJobs,
  filterByStatus,
  financeStats,
  fmtMoney,
  jobSearchBlob,
  matchesSearch,
  nextAlignBay,
  statusOf,
  STATUS_FLOW,
  todayKey,
  type Customer,
  type Job,
  type ShopConfig,
  type StatusKey,
  type Vehicle,
} from '@champpower/domain';
import { api } from '../../lib/api/client';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { isAdmin, useAuth } from '../../hooks/useAuth';
import { JobCard } from '../../components/job/JobCard';
import { DayNavigator } from '../../components/job/DayNavigator';
import { Icon } from '../../components/ui/Icon';
import { lastChangeAt } from './StuckJobsPage';

// The list only ever shows statuses a job can actually be sitting in day-to-day —
// delivered/rejected-carout jobs move to their own pages (see the original app's
// v2.9.0 changelog), so they're deliberately left out of this pill row.
const FILTERABLE_STATUSES = STATUS_FLOW.filter((s) => s.key !== 'delivered' && s.key !== 'carout');

function timeSinceLabel(iso: string): string {
  const hours = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (hours < 1) return 'ไม่ถึง 1 ชม.';
  if (hours < 24) return `${Math.floor(hours)} ชม.`;
  return `${Math.floor(hours / 24)} วัน`;
}

function colsMax(): number {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  if (w <= 700) return 1;
  if (w <= 1100) return 3;
  return 4;
}

export function JobListPage({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const navigate = useNavigate();
  const auth = useAuth();
  const canManageTechnicians = isAdmin(auth);
  const [dayFilter, setDayFilter] = useState<string>(todayKey());
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [cols, setCols] = useState(2);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);

  const jobs = useCollection<Job>('/api/jobs?includeDeleted=1');
  const vehicles = useCollection<Vehicle>('/api/vehicles');
  const customers = useCollection<Customer>('/api/customers');
  const config = useDocument<ShopConfig>('/api/config');
  const technicianNames = (config.data?.technicians || []).map((t) => t.name);

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);
  const customerById = useMemo(() => new Map(customers.rows.map((c) => [c.id, c])), [customers.rows]);
  const activeJobs = useMemo(() => jobs.rows.filter((j) => !j.deletedAt), [jobs.rows]);

  const scoped = useMemo(() => dayScopedJobs(activeJobs, { dayFilter }), [activeJobs, dayFilter]);
  const byStatus = useMemo(() => filterByStatus(scoped, statusFilter), [scoped, statusFilter]);
  const filtered = useMemo(() => {
    if (!search.trim()) return byStatus;
    return byStatus.filter((j) =>
      matchesSearch(jobSearchBlob(j, vehicleById.get(j.vehicleId), customerById.get(j.customerId)), search),
    );
  }, [byStatus, search, vehicleById, customerById]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const j of scoped) counts[j.status] = (counts[j.status] ?? 0) + 1;
    return counts;
  }, [scoped]);

  // "ต้องจัดการต่อ": jobs sitting at "เสนอราคา" (awaiting the customer's decision) are
  // the ones staff most need to chase up on — sorted oldest-waiting-first, using the
  // same "time since last status change" the Stuck Jobs page already computes.
  const attentionRows = useMemo(() => {
    return activeJobs
      .filter((j) => j.status === 'quoted')
      .map((j) => ({ job: j, since: lastChangeAt(j) }))
      .sort((a, b) => new Date(a.since).getTime() - new Date(b.since).getTime())
      .slice(0, 5);
  }, [activeJobs]);

  // Revenue-today reuses the same financeStats() FinancePage already computes from
  // delivered jobs — sourced from jobs.rows already loaded on this page, no extra fetch.
  const deliveredJobs = useMemo(() => jobs.rows.filter((j) => j.status === 'delivered'), [jobs.rows]);
  const revenueToday = useMemo(() => financeStats(deliveredJobs, vehicleById), [deliveredJobs, vehicleById]);

  const loading = jobs.loading || vehicles.loading || customers.loading;
  const maxCols = colsMax();
  const gridCols = Math.min(cols, maxCols);

  async function setStatus(jobId: string, status: StatusKey) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job) return;
    // Entering "รอตั้งศูนย์" auto-claims the alignment rack if it's free; if another
    // job already holds it, the car just waits in its current bay for its turn.
    const alignBay = status === 'aligning' ? nextAlignBay(activeJobs, jobId) : null;
    const bayExtra = alignBay ? { bay: alignBay } : {};
    // statusHistory is appended server-side on PATCH when `status` changes — no need
    // to compute/send it from here anymore (see the locked API contract).
    await api.patch<Job>(`/api/jobs/${jobId}`, { status, ...bayExtra });
  }

  // "นัดวันมาทำ" always carries the appointment date — setting the status without one
  // loses any record of when the customer is coming back.
  async function scheduleJob(jobId: string, appointmentDate: string) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job || !appointmentDate) return;
    await api.patch<Job>(`/api/jobs/${jobId}`, { status: 'scheduled' as StatusKey, appointmentDate });
  }

  async function assignBay(jobId: string, bay: string) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job) return;
    const occupant = bay ? activeJobs.find((j) => j.bay === bay && j.id !== jobId && j.status !== 'delivered') : null;
    if (occupant) {
      await api.patch<Job>(`/api/jobs/${occupant.id}`, { bay: '' });
    }
    await api.patch<Job>(`/api/jobs/${jobId}`, { bay });
  }

  async function assignTechnician(jobId: string, name: string) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job) return;
    const trimmed = name.trim();
    if (trimmed && !technicianNames.includes(trimmed)) {
      await api.patch<ShopConfig>('/api/config', {
        technicians: [...(config.data?.technicians || []), { id: crypto.randomUUID(), name: trimmed }],
      });
    }
    // technicianHistory is appended server-side on PATCH when `technician` changes.
    await api.patch<Job>(`/api/jobs/${jobId}`, { technician: trimmed });
  }

  async function editInfo(
    vehicleId: string,
    customerId: string,
    vehiclePatch: Partial<Vehicle>,
    customerPatch: Partial<Customer>,
  ) {
    // Board/lookup projections are recomputed server-side off vehicles/customers/jobs
    // directly now (no separate denormalized doc to resync or clean up a stale plate
    // key from) — the backend emits board:changed/lookup:changed itself after these
    // writes land.
    await Promise.all([
      api.patch<Vehicle>(`/api/vehicles/${vehicleId}`, vehiclePatch),
      api.patch<Customer>(`/api/customers/${customerId}`, customerPatch),
    ]);
  }

  // Pulls everything reachable through the locked REST contract into one JSON file.
  // A few Firestore-era collections (partBrandOptions, complaintTypes, editLog,
  // jobPhotos, the denormalized board/lookup docs) have no REST equivalent anymore —
  // board/lookup are now computed on read, and the others were dropped from the
  // backend's schema, so this backup is scoped to what /api actually exposes.
  async function exportDatabase() {
    setExporting(true);
    try {
      const data: Record<string, unknown> = {
        jobs: await api.get('/api/jobs?includeDeleted=1'),
        vehicles: await api.get('/api/vehicles'),
        customers: await api.get('/api/customers'),
        models: await api.get('/api/models'),
        masterParts: await api.get('/api/master-parts'),
        config: await api.get('/api/config'),
      };
      // /api/users is admin-only — skip it quietly for non-admin staff rather than
      // failing the whole export.
      try {
        data.users = await api.get('/api/users');
      } catch {
        // not an admin — omit
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `champpower-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  async function deleteJob(jobId: string) {
    if (!window.confirm('ลบรายการนี้ใช่หรือไม่?')) return;
    await api.del(`/api/jobs/${jobId}`);
  }

  function toggleSelected(jobId: string) {
    setSelectedIds((ids) => (ids.includes(jobId) ? ids.filter((id) => id !== jobId) : [...ids, jobId]));
  }

  async function bulkDelete() {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`ลบ ${selectedIds.length} รายการที่เลือกใช่หรือไม่?`)) return;
    await Promise.all(selectedIds.map((id) => api.del(`/api/jobs/${id}`)));
    setSelectedIds([]);
  }

  return (
    <div className="page">
      <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ marginBottom: 0 }}>รายการงาน</h1>
        <div className="row-flex" style={{ gap: 8 }}>
          <button className="btn secondary small" disabled={exporting} onClick={exportDatabase}>
            {exporting ? 'กำลังดาวน์โหลด...' : 'ดาวน์โหลดข้อมูลทั้งหมด (JSON)'}
          </button>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card kpi-dark">
          <div className="kpi-card-value">{scoped.length} คัน</div>
          <div className="kpi-card-label">รถในระบบ</div>
          <div className="kpi-card-sub">ทั้งหมดวันนี้</div>
        </div>
        <div className="kpi-card kpi-red">
          <div className="kpi-card-value">{statusCounts.inspecting ?? 0} คัน</div>
          <div className="kpi-card-label">รอตรวจเช็ก</div>
          <div className="kpi-card-sub">ต้องจัดคิว</div>
        </div>
        <div className="kpi-card kpi-gold">
          <div className="kpi-card-value">{statusCounts.quoted ?? 0} คัน</div>
          <div className="kpi-card-label">รออนุมัติ</div>
          <div className="kpi-card-sub">ติดต่อลูกค้า</div>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-card-value">{statusCounts.ready ?? 0} คัน</div>
          <div className="kpi-card-label">พร้อมส่งมอบ</div>
          <div className="kpi-card-sub">ตรวจความเรียบร้อย</div>
        </div>
      </div>

      <div className="dash-widgets">
        <div className="card dash-attention">
          <h3>ต้องจัดการต่อ</h3>
          {attentionRows.length === 0 ? (
            <p className="page-sub">ไม่มีงานที่รออนุมัติค้างอยู่</p>
          ) : (
            <ul className="dash-attention-list">
              {attentionRows.map(({ job, since }) => (
                <li key={job.id}>
                  <button type="button" className="dash-attention-row" onClick={() => onOpenJob(job.id)}>
                    <span className={`sw ${statusOf(job.status).cls}`} />
                    <span className="dash-attention-desc">
                      {job.jobNumber}
                      {vehicleById.get(job.vehicleId)
                        ? ` · ${vehicleById.get(job.vehicleId)!.brand} ${vehicleById.get(job.vehicleId)!.model}`
                        : ''}
                    </span>
                    <span className="dash-attention-since">รอมา {timeSinceLabel(since)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card dash-revenue">
          <h3>รายได้วันนี้</h3>
          <div className="job-summary-main">{fmtMoney(revenueToday.todayRev)} บาท</div>
          <p className="page-sub">{revenueToday.todayCount} คันส่งมอบแล้ววันนี้</p>
        </div>
      </div>

      <DayNavigator dayFilter={dayFilter} onChange={setDayFilter} />

      <div className="search-wrap">
        <Icon name="search" size={18} />
        <input
          className="search-input"
          placeholder="ค้นหา ทะเบียน / ยี่ห้อ / รุ่น / สี / ลูกค้า / เบอร์โทร / คิว"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="search-clear" title="ล้างคำค้นหา" aria-label="ล้างคำค้นหา" onClick={() => setSearch('')}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>

      <div className="status-pills">
        <button className={`status-pill ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => setStatusFilter('all')}>
          ทั้งหมด <span className="n">{scoped.length}</span>
        </button>
        {FILTERABLE_STATUSES.map((s) => {
          const count = statusCounts[s.key] ?? 0;
          if (!count && statusFilter !== s.key) return null;
          return (
            <button
              key={s.key}
              className={`status-pill ${statusFilter === s.key ? 'active' : ''}`}
              onClick={() => setStatusFilter(s.key)}
            >
              <span className={`sw ${s.cls}`} /> {s.label} <span className="n">{count}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">ไม่พบงานที่ตรงกับตัวกรอง</div>
      ) : (
        <>
          <div className="cols-bar">
            <span className="cols-label">คอลัมน์</span>
            {Array.from({ length: maxCols }, (_, i) => i + 1).map((n) => (
              <button key={n} className={`cols-btn ${gridCols === n ? 'active' : ''}`} onClick={() => setCols(n)}>
                {n}
              </button>
            ))}
          </div>

          <div className="select-bar">
            <button
              className={`btn small ${selectMode ? 'danger' : 'secondary'}`}
              onClick={() => {
                setSelectMode((m) => !m);
                setSelectedIds([]);
              }}
            >
              {selectMode ? <Icon name="x" size={14} /> : <Icon name="check" size={14} />}{' '}
              {selectMode ? 'ยกเลิก' : 'เลือกหลายรายการ'}
            </button>
            {selectMode && (
              <>
                <span className="select-count">เลือกแล้ว {selectedIds.length} รายการ</span>
                <button className="btn secondary small" onClick={() => setSelectedIds(filtered.map((j) => j.id))}>
                  เลือกทั้งหมด ({filtered.length})
                </button>
                {selectedIds.length > 0 && (
                  <>
                    <button className="btn secondary small" onClick={() => setSelectedIds([])}>
                      ล้างที่เลือก
                    </button>
                    <button className="btn small danger" onClick={bulkDelete}>
                      <Icon name="trash" size={13} /> ลบที่เลือก
                    </button>
                  </>
                )}
              </>
            )}
          </div>

          <div className="job-grid" style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}>
            {filtered.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                vehicle={vehicleById.get(job.vehicleId)}
                customer={customerById.get(job.customerId)}
                activeJobs={activeJobs}
                vehicleById={vehicleById}
                technicians={technicianNames}
                selMode={selectMode}
                selected={selectedIds.includes(job.id)}
                canDelete
                canManageTechnicians={canManageTechnicians}
                onOpen={onOpenJob}
                onToggleSelect={toggleSelected}
                onSetStatus={setStatus}
                onSchedule={scheduleJob}
                onAssignBay={assignBay}
                onAssignTechnician={assignTechnician}
                onDelete={deleteJob}
                onEditInfo={editInfo}
              />
            ))}
          </div>
        </>
      )}

      <button className="fab" title="รับรถคันใหม่" onClick={() => navigate('/checkin')}>
        <Icon name="plus" size={26} />
      </button>
    </div>
  );
}
