import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, deleteDoc, doc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import {
  dayScopedJobs,
  filterByStatus,
  jobSearchBlob,
  matchesSearch,
  nextAlignBay,
  normalizePlateKey,
  STATUS_FLOW,
  todayKey,
  type Customer,
  type Job,
  type ShopConfig,
  type StatusKey,
  type Vehicle,
} from '@champpower/domain';
import { db } from '../../lib/firebase/client';
import { syncPublicRecords } from '../../lib/firebase/board';
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
  const [backfilling, setBackfilling] = useState(false);
  const [exporting, setExporting] = useState(false);

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
    // Entering "รอตั้งศูนย์" auto-claims the alignment rack if it's free; if another
    // job already holds it, the car just waits in its current bay for its turn.
    const alignBay = status === 'aligning' ? nextAlignBay(activeJobs, jobId) : null;
    const bayExtra = alignBay ? { bay: alignBay } : {};
    await updateDoc(doc(db, 'jobs', jobId), { status, statusHistory, ...bayExtra });
    await syncPublicRecords(
      { ...job, status, statusHistory, ...bayExtra },
      vehicleById.get(job.vehicleId),
      customerById.get(job.customerId),
    );
  }

  // "นัดวันมาทำ" always carries the appointment date — setting the status without one
  // loses any record of when the customer is coming back.
  async function scheduleJob(jobId: string, appointmentDate: string) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job || !appointmentDate) return;
    const status: StatusKey = 'scheduled';
    const statusHistory = [...job.statusHistory, { status, changedAt: nowIso() }];
    await updateDoc(doc(db, 'jobs', jobId), { status, statusHistory, appointmentDate });
    await syncPublicRecords(
      { ...job, status, statusHistory, appointmentDate },
      vehicleById.get(job.vehicleId),
      customerById.get(job.customerId),
    );
  }

  async function assignBay(jobId: string, bay: string) {
    const job = jobs.rows.find((j) => j.id === jobId);
    if (!job) return;
    const occupant = bay ? activeJobs.find((j) => j.bay === bay && j.id !== jobId && j.status !== 'delivered') : null;
    if (occupant) {
      await updateDoc(doc(db, 'jobs', occupant.id), { bay: '' });
    }
    await updateDoc(doc(db, 'jobs', jobId), { bay });
    await syncPublicRecords({ ...job, bay }, vehicleById.get(job.vehicleId), customerById.get(job.customerId));
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

  async function editInfo(
    vehicleId: string,
    customerId: string,
    vehiclePatch: Partial<Vehicle>,
    customerPatch: Partial<Customer>,
  ) {
    await Promise.all([
      updateDoc(doc(db, 'vehicles', vehicleId), vehiclePatch),
      updateDoc(doc(db, 'customers', customerId), customerPatch),
    ]);
    // Board and lookup both read plate/brand/model/customer straight off these docs,
    // so every job currently checked in under this vehicle needs a fresh sync — and
    // if the plate itself changed, the old plate's /lookup doc is now stale and must
    // go, or a customer searching the old plate would find someone else's car.
    const oldVehicle = vehicleById.get(vehicleId);
    const updatedVehicle = { ...oldVehicle, id: vehicleId, ...vehiclePatch } as Vehicle;
    const updatedCustomer = { ...customerById.get(customerId), id: customerId, ...customerPatch } as Customer;
    const affectedJobs = activeJobs.filter((j) => j.vehicleId === vehicleId);
    const oldPlateKey = normalizePlateKey(oldVehicle?.plate || '');
    const newPlateKey = normalizePlateKey(updatedVehicle.plate || '');
    await Promise.all([
      ...affectedJobs.map((j) => syncPublicRecords(j, updatedVehicle, updatedCustomer)),
      oldPlateKey && oldPlateKey !== newPlateKey ? deleteDoc(doc(db, 'lookup', oldPlateKey)) : Promise.resolve(),
    ]);
  }

  // One-time catch-up for jobs that existed before the board/lookup sync path covered
  // this write — without this, a car checked in before that ship date never gets a
  // /lookup doc until something happens to touch it again (a status change, a parts
  // edit...), so it just silently 404s on the customer's "find my car" page forever.
  async function backfillPublicRecords() {
    if (!window.confirm(`ซิงก์ข้อมูลสำหรับค้นหา (บอร์ด + ค้นหารถ) ของงานทั้งหมด ${activeJobs.length} รายการ?`)) return;
    setBackfilling(true);
    try {
      await Promise.all(
        activeJobs.map((j) => syncPublicRecords(j, vehicleById.get(j.vehicleId), customerById.get(j.customerId))),
      );
      window.alert('ซิงก์ข้อมูลสำเร็จ');
    } finally {
      setBackfilling(false);
    }
  }

  // Every collection the schema doc defines (firebase/firestore.rules lists all 12,
  // plus /lookup added since). Runs entirely client-side under the signed-in staff
  // session that's already reading these collections elsewhere in the app — no admin
  // credentials involved, the file lands directly in the browser's own Downloads.
  const BACKUP_COLLECTIONS = [
    'jobs', 'vehicles', 'customers', 'models', 'masterParts', 'partBrandOptions',
    'complaintTypes', 'editLog', 'jobPhotos', 'config', 'users', 'board', 'lookup', 'technicians',
  ];

  async function exportDatabase() {
    setExporting(true);
    try {
      const data: Record<string, unknown[]> = {};
      for (const name of BACKUP_COLLECTIONS) {
        const snap = await getDocs(collection(db, name));
        data[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
      <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ marginBottom: 0 }}>รายการงาน</h1>
        <div className="row-flex" style={{ gap: 8 }}>
          <button className="btn secondary small" disabled={exporting} onClick={exportDatabase}>
            {exporting ? 'กำลังดาวน์โหลด...' : 'ดาวน์โหลดข้อมูลทั้งหมด (JSON)'}
          </button>
          <button className="btn secondary small" disabled={backfilling} onClick={backfillPublicRecords}>
            {backfilling ? 'กำลังซิงก์...' : 'ซิงก์ข้อมูลค้นหา/บอร์ด'}
          </button>
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
