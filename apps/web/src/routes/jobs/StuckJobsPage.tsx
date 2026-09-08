import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { dayKey, statusOf, type Job, type Vehicle } from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';
import { DayNavigator } from '../../components/job/DayNavigator';

const STUCK_HOURS = 48; // included in the list at all once idle past this
const CRITICAL_DAYS = 7;
const WARNING_DAYS = 3;

interface StuckRow {
  job: Job;
  vehicle: Vehicle | undefined;
  lastChangedAt: string;
  daysStuck: number;
}

// Exported so other pages (e.g. JobListPage's "ต้องจัดการต่อ" panel) can compute the
// same "how long since last status change" figure without duplicating this logic.
export function lastChangeAt(job: Job): string {
  const history = job.statusHistory || [];
  return history.length ? history[history.length - 1]!.changedAt : job.createdAt;
}

export function StuckJobsPage() {
  const navigate = useNavigate();
  const jobs = useCollection<Job>('/api/jobs');
  const vehicles = useCollection<Vehicle>('/api/vehicles');
  const [dayFilter, setDayFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);

  const stuckRows = useMemo(() => {
    const now = Date.now();
    const rows: StuckRow[] = [];
    for (const job of jobs.rows) {
      if (job.deletedAt || job.status === 'delivered') continue;
      const lastChangedAt = lastChangeAt(job);
      const hoursIdle = (now - new Date(lastChangedAt).getTime()) / 36e5;
      if (hoursIdle < STUCK_HOURS) continue;
      rows.push({ job, vehicle: vehicleById.get(job.vehicleId), lastChangedAt, daysStuck: Math.floor(hoursIdle / 24) });
    }
    return rows.sort((a, b) => b.daysStuck - a.daysStuck);
  }, [jobs.rows, vehicleById]);

  const dayFiltered = useMemo(() => {
    if (dayFilter === 'all') return stuckRows;
    return stuckRows.filter((r) => dayKey(r.job.createdAt) === dayFilter);
  }, [stuckRows, dayFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dayFiltered;
    return dayFiltered.filter((r) => {
      const blob = `${r.job.jobNumber} ${r.job.queueNo || ''} ${r.vehicle?.brand || ''} ${r.vehicle?.model || ''} ${r.vehicle?.plate || ''}`.toLowerCase();
      return blob.includes(q);
    });
  }, [dayFiltered, search]);

  const criticalCount = stuckRows.filter((r) => r.daysStuck >= CRITICAL_DAYS).length;

  return (
    <div className="page">
      <h1>รถค้างและงานที่ต้องติดตาม</h1>
      <p className="page-sub">งานที่ยังไม่ส่งมอบและไม่มีการเปลี่ยนสถานะเกิน {STUCK_HOURS} ชั่วโมง</p>

      <DayNavigator dayFilter={dayFilter} onChange={setDayFilter} />

      <div className="search-wrap" style={{ margin: '12px 0' }}>
        <input
          className="search-input"
          placeholder="ค้นหา ทะเบียน / รุ่นรถ / เลขงาน / คิว"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="kpi-grid">
        <div className="kpi-card kpi-red">
          <div className="kpi-card-value">{criticalCount} คัน</div>
          <div className="kpi-card-label">วิกฤต</div>
          <div className="kpi-card-sub">แจ้ง ≥ 7 วัน • เฝ้าระวัง 3-6 วัน • เตือน 1-2 วัน</div>
        </div>
        <div className="kpi-card kpi-blue">
          <div className="kpi-card-value">บันทึกเวลา</div>
          <div className="kpi-card-label">การติดตาม</div>
          <div className="kpi-card-sub">โน้ตทุกรายการมีเวลาบันทึกกำกับอัตโนมัติ</div>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-card-value">เปลี่ยนสถานะได้</div>
          <div className="kpi-card-label">ทางออก</div>
          <div className="kpi-card-sub">ปิดงาน / เปลี่ยนสถานะ / ลบงานได้จากหน้ารายละเอียด</div>
        </div>
      </div>

      <div className="card">
        <h3>งานค้าง {filtered.length} รายการ</h3>
        {jobs.loading ? (
          <div className="page-loading">กำลังโหลด...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">ไม่มีงานค้างในตัวกรองนี้</div>
        ) : (
          <div className="table-wrap">
            <table className="parts-table">
              <thead>
                <tr>
                  <th className="center">ค้างมาแล้ว</th>
                  <th>คิว / รุ่นรถ</th>
                  <th>สถานะปัจจุบัน</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.job.id}>
                    <td className="center">
                      <span className={`pill ${r.daysStuck >= CRITICAL_DAYS ? 'pill-danger' : r.daysStuck >= WARNING_DAYS ? 'pill-warning' : 'pill-gold'}`}>
                        {r.daysStuck} วัน
                      </span>
                    </td>
                    <td>
                      {r.job.queueNo ? `คิว ${r.job.queueNo} · ` : ''}
                      {r.vehicle ? `${r.vehicle.brand} ${r.vehicle.model}` : r.job.jobNumber}
                    </td>
                    <td>{statusOf(r.job.status).label}</td>
                    <td>
                      <button className="btn secondary small" onClick={() => navigate(`/jobs/${r.job.id}`)}>
                        เพิ่มโน้ต / ติดตาม
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
