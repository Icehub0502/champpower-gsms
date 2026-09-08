import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { dayLabel, todayKey, warrantyEndDate, type Customer, type Job, type Vehicle } from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';
import { PlateBadge } from '../../components/ui/PlateBadge';

/** Days between two dayKey strings (end - today), local-time safe like the rest of
 * the date utils (parses y/m/d instead of diffing raw Date objects across DST). */
function daysBetween(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = toKey.split('-').map(Number) as [number, number, number];
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function pillClass(daysLeft: number): string {
  if (daysLeft < 0) return 'pill-muted';
  if (daysLeft < 7) return 'pill-danger';
  if (daysLeft < 30) return 'pill-warning';
  return 'pill-info';
}

/** Delivered jobs with an active warranty window, joined with vehicle info and sorted
 * by soonest-to-expire — real data end-to-end via `warrantyEndDate`/`warrantyStatus`
 * (packages/domain/src/rules/warranty.ts), the same helpers JobDetailPage's warranty
 * card already uses. No backend work needed: this is purely a client-side filter over
 * /api/jobs, there is no separate "expiring warranties" endpoint. */
export function WarrantyPage() {
  const navigate = useNavigate();
  const jobs = useCollection<Job>('/api/jobs?includeDeleted=1');
  const vehicles = useCollection<Vehicle>('/api/vehicles');
  const customers = useCollection<Customer>('/api/customers');

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);
  const customerById = useMemo(() => new Map(customers.rows.map((c) => [c.id, c])), [customers.rows]);

  const rows = useMemo(() => {
    const today = todayKey();
    return jobs.rows
      .filter((j) => !j.deletedAt && j.status === 'delivered' && (j.warrantyDays || 0) > 0)
      .map((j) => {
        const end = warrantyEndDate(j);
        return { job: j, end, daysLeft: end ? daysBetween(today, end) : null };
      })
      .filter((r): r is { job: Job; end: string; daysLeft: number } => r.end !== null && r.daysLeft !== null && r.daysLeft >= 0)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [jobs.rows]);

  const within7 = rows.filter((r) => r.daysLeft <= 7).length;
  const within30 = rows.filter((r) => r.daysLeft <= 30).length;
  const within60 = rows.filter((r) => r.daysLeft <= 60).length;

  const loading = jobs.loading || vehicles.loading || customers.loading;

  return (
    <div className="page">
      <h1>ประกันใกล้หมดอายุ</h1>
      <p className="page-sub">งานที่อยู่ในช่วงประกัน ใกล้ถึงวันหมดอายุ — ใช้ติดตามลูกค้าให้กลับมาเช็ก</p>

      <div className="kpi-grid">
        <div className="kpi-card kpi-red">
          <div className="kpi-card-value">{within7} งาน</div>
          <div className="kpi-card-label">ภายใน 7 วัน</div>
        </div>
        <div className="kpi-card kpi-orange">
          <div className="kpi-card-value">{within30} งาน</div>
          <div className="kpi-card-label">ภายใน 30 วัน</div>
        </div>
        <div className="kpi-card kpi-blue">
          <div className="kpi-card-value">{within60} งาน</div>
          <div className="kpi-card-label">ภายใน 60 วัน</div>
        </div>
      </div>

      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">ไม่มีงานที่อยู่ในช่วงประกัน</div>
      ) : (
        <div className="list-card">
          {rows.map(({ job, end, daysLeft }) => {
            const v = vehicleById.get(job.vehicleId);
            const c = customerById.get(job.customerId);
            return (
              <button
                type="button"
                key={job.id}
                className="list-row"
                style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer' }}
                onClick={() => navigate(`/jobs/${job.id}`)}
              >
                <PlateBadge plate={v?.plate} province={v?.province} />
                <div className="list-row-main">
                  <div className="list-row-title">
                    {job.jobNumber} · {v ? `${v.brand} ${v.model}` : 'ไม่ทราบรุ่นรถ'}
                  </div>
                  <div className="list-row-sub">
                    {c?.name || 'ไม่ทราบชื่อลูกค้า'}{c?.phone ? ` · ${c.phone}` : ''} · หมดประกัน {dayLabel(end)}
                  </div>
                </div>
                <span className={`pill ${pillClass(daysLeft)}`}>
                  {daysLeft === 0 ? 'หมดวันนี้' : `เหลือ ${daysLeft} วัน`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
