import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';
import {
  dayScopedJobs,
  filterByStatus,
  jobSearchBlob,
  matchesSearch,
  STATUS_FLOW,
  todayKey,
  type Customer,
  type Job,
  type ShopConfig,
  type StatusKey,
  type Vehicle,
} from '@champpower/domain';
import { db } from '../../lib/firebase/client';
import { syncBoardEntry } from '../../lib/firebase/board';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { JobCard } from '../../components/job/JobCard';
import { DayNavigator } from '../../components/job/DayNavigator';
import { Icon } from '../../components/ui/Icon';

// The list only ever shows statuses a job can actually be sitting in day-to-day —
// delivered/rejected-carout jobs move to their own pages (see the original app's
// v2.9.0 changelog), so they're deliberately left out of this pill row.
const FILTERABLE_STATUSES = STATUS_FLOW.filter((s) => s.key !== 'delivered' && s.key !== 'carout');

function colsMax(): number {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  if (w <= 700) return 1;
  if (w <= 1100) return 3;
  return 4;
}

export function JobListPage({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const navigate = useNavigate();
  const [dayFilter, setDayFilter] = useState<string>(todayKey());
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [cols, setCols] = useState(2);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const jobs = useCollection<Job>('jobs');
  const vehicles = useCollection<Vehicle>('vehicles');
  const customers = useCollection<Customer>('customers');
  const config = useDocument<ShopConfig>('config', 'main');
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

  const loading = jobs.loading || vehicles.loading || customers.loading;
  const maxCols = colsMax();
  const gridCols = Math.min(cols, maxCols);

  function nowIso() {
    return new Date().toISOString();
  }

  async function setStatus(jobId: string, status: StatusKey) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job) return;
    const statusHistory = [...job.statusHistory, { status, changedAt: nowIso() }];
    await updateDoc(doc(db, 'jobs', jobId), { status, statusHistory });
    await syncBoardEntry({ ...job, status, statusHistory }, vehicleById.get(job.vehicleId));
  }

  async function assignBay(jobId: string, bay: string) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job) return;
    const occupant = bay ? activeJobs.find((j) => j.bay === bay && j.id !== jobId && j.status !== 'delivered') : null;
    if (occupant) {
      await updateDoc(doc(db, 'jobs', occupant.id), { bay: '' });
    }
    await updateDoc(doc(db, 'jobs', jobId), { bay });
    await syncBoardEntry({ ...job, bay }, vehicleById.get(job.vehicleId));
  }

  async function assignTechnician(jobId: string, name: string) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job) return;
    const trimmed = name.trim();
    if (trimmed && !technicianNames.includes(trimmed)) {
      await setDoc(
        doc(db, 'config', 'main'),
        { technicians: [...(config.data?.technicians || []), { id: crypto.randomUUID(), name: trimmed }] },
        { merge: true },
      );
    }
    await updateDoc(doc(db, 'jobs', jobId), {
      technician: trimmed,
      technicianHistory: [...(job.technicianHistory || []), { name: trimmed, changedAt: nowIso() }],
    });
  }

  async function deleteJob(jobId: string) {
    if (!window.confirm('ลบรายการนี้ใช่หรือไม่?')) return;
    await deleteDoc(doc(db, 'jobs', jobId));
  }

  function toggleSelected(jobId: string) {
    setSelectedIds((ids) => (ids.includes(jobId) ? ids.filter((id) => id !== jobId) : [...ids, jobId]));
  }

  async function bulkDelete() {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`ลบ ${selectedIds.length} รายการที่เลือกใช่หรือไม่?`)) return;
    await Promise.all(selectedIds.map((id) => deleteDoc(doc(db, 'jobs', id))));
    setSelectedIds([]);
  }

  return (
    <div className="page">
      <h1>รายการงาน</h1>

      <DayNavigator dayFilter={dayFilter} onChange={setDayFilter} />

      <div className="search-wrap">
        <Icon name="search" size={18} />
        <input
          className="search-input"
          placeholder="ค้นหา ทะเบียน / ยี่ห้อ / รุ่น / สี / ลูกค้า / เบอร์โทร / คิว"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
                technicians={technicianNames}
                selMode={selectMode}
                selected={selectedIds.includes(job.id)}
                canDelete
                onOpen={onOpenJob}
                onToggleSelect={toggleSelected}
                onSetStatus={setStatus}
                onAssignBay={assignBay}
                onAssignTechnician={assignTechnician}
                onDelete={deleteJob}
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
