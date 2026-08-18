import { useMemo, useState } from 'react';
import {
  dayScopedJobs,
  filterByStatus,
  jobSearchBlob,
  matchesSearch,
  STATUS_FLOW,
  todayKey,
  type Customer,
  type Job,
  type Vehicle,
} from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';
import { JobCard } from '../../components/job/JobCard';
import { DayNavigator } from '../../components/job/DayNavigator';

// The list only ever shows statuses a job can actually be sitting in day-to-day —
// delivered/rejected-carout jobs move to their own pages (see the original app's
// v2.9.0 changelog), so they're deliberately left out of this pill row.
const FILTERABLE_STATUSES = STATUS_FLOW.filter((s) => s.key !== 'delivered' && s.key !== 'carout');

export function JobListPage({ onOpenJob }: { onOpenJob: (jobId: string) => void }) {
  const [dayFilter, setDayFilter] = useState<string>(todayKey());
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const jobs = useCollection<Job>('jobs');
  const vehicles = useCollection<Vehicle>('vehicles');
  const customers = useCollection<Customer>('customers');

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);
  const customerById = useMemo(() => new Map(customers.rows.map((c) => [c.id, c])), [customers.rows]);

  const scoped = useMemo(() => dayScopedJobs(jobs.rows, { dayFilter }), [jobs.rows, dayFilter]);
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

  return (
    <div className="page">
      <h1>รายการงาน</h1>

      <DayNavigator dayFilter={dayFilter} onChange={setDayFilter} />

      <input
        className="search-input"
        placeholder="ค้นหาทะเบียน / รุ่นรถ / ลูกค้า..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="status-pills">
        <button className={`day-chip ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => setStatusFilter('all')}>
          ทั้งหมด ({scoped.length})
        </button>
        {FILTERABLE_STATUSES.map((s) => {
          const count = statusCounts[s.key] ?? 0;
          if (!count) return null;
          return (
            <button
              key={s.key}
              className={`day-chip ${statusFilter === s.key ? 'active' : ''}`}
              onClick={() => setStatusFilter(s.key)}
            >
              {s.label} ({count})
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">ไม่พบงานที่ตรงกับตัวกรอง</div>
      ) : (
        <div className="job-grid">
          {filtered.map((job) => (
            <JobCard key={job.id} job={job} vehicle={vehicleById.get(job.vehicleId)} onClick={onOpenJob} />
          ))}
        </div>
      )}
    </div>
  );
}
