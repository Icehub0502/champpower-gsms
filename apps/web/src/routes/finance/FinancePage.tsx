import { useMemo } from 'react';
import { where } from 'firebase/firestore';
import { financeLast14Days, financeStats, fmtMoney, type Job, type Vehicle } from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';

const DELIVERED_CONSTRAINT = [where('status', '==', 'delivered')];

export function FinancePage() {
  const jobs = useCollection<Job>('jobs', DELIVERED_CONSTRAINT);
  const vehicles = useCollection<Vehicle>('vehicles');

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);
  const stats = useMemo(() => financeStats(jobs.rows, vehicleById), [jobs.rows, vehicleById]);
  const series = useMemo(() => financeLast14Days(stats.byDay), [stats.byDay]);
  const maxRev = Math.max(1, ...series.map((d) => d.revenue));

  if (jobs.loading || vehicles.loading) {
    return <div className="page">กำลังโหลด...</div>;
  }

  if (stats.totalCount === 0) {
    return (
      <div className="page">
        <h1>สถิติรายได้</h1>
        <div className="empty-state">ยังไม่มีงานที่ส่งมอบแล้วเลย — สถิติจะเริ่มมีข้อมูลเมื่อมีการส่งมอบรถคันแรก</div>
      </div>
    );
  }

  const techRows = Object.entries(stats.byTech).sort((a, b) => b[1].revenue - a[1].revenue);
  const brandRows = Object.entries(stats.byBrand)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10);

  return (
    <div className="page">
      <h1>สถิติรายได้</h1>
      <p className="page-sub">สรุปจากงานที่ส่งมอบแล้วเท่านั้น</p>

      <div className="fin-cards">
        <StatCard label="วันนี้" value={stats.todayRev} count={stats.todayCount} />
        <StatCard label="7 วันล่าสุด" value={stats.weekRev} count={stats.weekCount} />
        <StatCard label="เดือนนี้" value={stats.monthRev} count={stats.monthCount} />
        <StatCard label="ปีนี้" value={stats.yearRev} count={stats.yearCount} />
      </div>

      <div className="card">
        <h3>รายได้ 14 วันล่าสุด</h3>
        <div className="fin-chart">
          {series.map((d) => (
            <div className="fin-bar-col" key={d.key} title={`${d.label}: ${fmtMoney(d.revenue)} บาท (${d.count} คัน)`}>
              <div className="fin-bar-track">
                <div className="fin-bar" style={{ height: `${Math.round((d.revenue / maxRev) * 100)}%` }} />
              </div>
              <span className="fin-bar-label">{d.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>รายได้แยกตามช่าง</h3>
        <table className="parts-table">
          <thead>
            <tr>
              <th>ช่าง</th>
              <th className="center">จำนวนงาน</th>
              <th className="center">รายได้รวม</th>
              <th className="center">เฉลี่ย/งาน</th>
            </tr>
          </thead>
          <tbody>
            {techRows.map(([name, d]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="center">{d.count}</td>
                <td className="center">{fmtMoney(d.revenue)}</td>
                <td className="center">{fmtMoney(d.revenue / d.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>รายได้แยกตามยี่ห้อรถ (10 อันดับแรก)</h3>
        <table className="parts-table">
          <thead>
            <tr>
              <th>ยี่ห้อ</th>
              <th className="center">จำนวนงาน</th>
              <th className="center">รายได้รวม</th>
            </tr>
          </thead>
          <tbody>
            {brandRows.map(([name, d]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="center">{d.count}</td>
                <td className="center">{fmtMoney(d.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>ภาพรวมสะสมทั้งหมด</h3>
        <p>
          งานที่ส่งมอบแล้วทั้งหมด <b>{stats.totalCount}</b> คัน &nbsp;·&nbsp; รายได้รวมสะสม{' '}
          <b>{fmtMoney(stats.allRev)}</b> บาท &nbsp;·&nbsp; เฉลี่ย <b>{fmtMoney(stats.avgJobValue)}</b> บาท/คัน
        </p>
      </div>
    </div>
  );
}

function StatCard({ label, value, count }: { label: string; value: number; count: number }) {
  return (
    <div className="fin-card">
      <div className="fin-card-label">{label}</div>
      <div className="fin-card-val">{fmtMoney(value)}</div>
      <div className="fin-card-sub">{count} คัน</div>
    </div>
  );
}
