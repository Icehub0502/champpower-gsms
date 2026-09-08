import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { shiftDay, statusOf, todayKey, type Customer, type Job, type Vehicle } from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';

const DAY_NAMES = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function mondayOf(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dow = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  const deltaToMonday = dow === 0 ? -6 : 1 - dow;
  return shiftDay(key, deltaToMonday);
}

function shortLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}`;
}

function dayOfWeek(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getDay(); // 0 = Sunday
}

/** `Job.appointmentDate` (a plain YYYY-MM-DD dayKey, set when a job is moved to
 * "นัดวันมาทำ" — see JobListPage's scheduleJob/JobCard) is the only real appointment
 * data in this schema; there is no time-of-day field. The old mock UI showed an
 * hour-by-hour grid, which isn't derivable from real data — this scopes down to a
 * day-by-day list instead of inventing appointment times. */
export function CalendarPage() {
  const navigate = useNavigate();
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayKey()));
  const jobs = useCollection<Job>('/api/jobs?includeDeleted=1');
  const vehicles = useCollection<Vehicle>('/api/vehicles');
  const customers = useCollection<Customer>('/api/customers');

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);
  const customerById = useMemo(() => new Map(customers.rows.map((c) => [c.id, c])), [customers.rows]);

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => shiftDay(weekStart, i)), [weekStart]);

  const appointmentsByDay = useMemo(() => {
    const map = new Map<string, Job[]>();
    for (const j of jobs.rows) {
      if (j.deletedAt || !j.appointmentDate) continue;
      const key = j.appointmentDate;
      const list = map.get(key) || [];
      list.push(j);
      map.set(key, list);
    }
    return map;
  }, [jobs.rows]);

  const loading = jobs.loading || vehicles.loading || customers.loading;
  const today = todayKey();
  const rangeLabel = `${shortLabel(weekDays[0]!)} – ${shortLabel(weekDays[6]!)}`;

  return (
    <div className="page">
      <h1>ปฏิทินนัดหมาย</h1>
      <p className="page-sub">นัดหมายลูกค้าที่ตั้งไว้ผ่านสถานะ "นัดวันมาทำ" ของแต่ละใบงาน</p>

      <div className="cal-toolbar">
        <div className="cal-view-toggle">
          <button type="button" onClick={() => setWeekStart(mondayOf(today))}>
            สัปดาห์นี้
          </button>
          <button type="button" onClick={() => setWeekStart((w) => shiftDay(w, -7))}>
            ก่อนหน้า
          </button>
          <button type="button" onClick={() => setWeekStart((w) => shiftDay(w, 7))}>
            ถัดไป
          </button>
        </div>
        <span className="cal-range-label">{rangeLabel}</span>
      </div>

      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : (
        <div className="cal-week-list">
          {weekDays.map((dayKeyStr) => {
            const items = (appointmentsByDay.get(dayKeyStr) || []).sort((a, b) =>
              (a.queueNo || '').localeCompare(b.queueNo || ''),
            );
            const dow = dayOfWeek(dayKeyStr);
            const dayName = DAY_NAMES[dow === 0 ? 6 : dow - 1];
            return (
              <div key={dayKeyStr} className={`cal-day-block${dayKeyStr === today ? ' today' : ''}`}>
                <div className="cal-day-block-head">
                  {dayName} {shortLabel(dayKeyStr)}
                  {dayKeyStr === today ? ' (วันนี้)' : ''}
                </div>
                {items.length === 0 ? (
                  <div className="page-sub" style={{ marginBottom: 0 }}>
                    ไม่มีนัดหมาย
                  </div>
                ) : (
                  <div className="list-card">
                    {items.map((j) => {
                      const v = vehicleById.get(j.vehicleId);
                      const c = customerById.get(j.customerId);
                      return (
                        <button
                          type="button"
                          key={j.id}
                          className="list-row"
                          style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer' }}
                          onClick={() => navigate(`/jobs/${j.id}`)}
                        >
                          <span className={`sw ${statusOf(j.status).cls}`} />
                          <div className="list-row-main">
                            <div className="list-row-title">
                              {j.jobNumber} · {v ? `${v.brand} ${v.model}` : 'ไม่ทราบรุ่นรถ'}
                            </div>
                            <div className="list-row-sub">{c?.name || 'ไม่ทราบชื่อลูกค้า'}{c?.phone ? ` · ${c.phone}` : ''}</div>
                          </div>
                          <span className="pill pill-info">{statusOf(j.status).label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
