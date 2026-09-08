import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtMoney, jobGrandTotal, type Job, type Vehicle } from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';
import { PlateBadge } from '../../components/ui/PlateBadge';

/** Real data reuse: this list is exactly the "delivered" jobs the finance page
 * already aggregates — just shown row-by-row instead of summed. No mock data
 * needed here since the underlying job/vehicle collections already exist.
 * Status filtering moves client-side since REST has no Firestore-style `where()`. */
export function DeliveredPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const jobs = useCollection<Job>('/api/jobs?includeDeleted=1');
  const vehicles = useCollection<Vehicle>('/api/vehicles');

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.rows
      .filter((j) => !j.deletedAt && j.status === 'delivered')
      .filter((j) => {
        if (!q) return true;
        const v = vehicleById.get(j.vehicleId);
        return [j.jobNumber, v?.plate, v?.brand, v?.model].some((s) => (s || '').toLowerCase().includes(q));
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [jobs.rows, vehicleById, search]);

  const loading = jobs.loading || vehicles.loading;

  return (
    <div className="page">
      <h1>รถส่งมอบแล้ว</h1>
      <p className="page-sub">ค้นหาประวัติงานที่ปิดและส่งมอบให้ลูกค้าแล้ว</p>

      <div className="row-flex" style={{ marginBottom: 14 }}>
        <input
          className="search-input"
          style={{ flex: '1 1 240px' }}
          placeholder="ทะเบียน / ลูกค้า / เลขใบงาน"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="pill pill-muted">ทั้งหมด {rows.length} คัน</span>
      </div>

      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">ยังไม่มีรถที่ส่งมอบแล้ว</div>
      ) : (
        <div className="list-card">
          {rows.map((j) => {
            const v = vehicleById.get(j.vehicleId);
            return (
              <button
                type="button"
                key={j.id}
                className="list-row"
                style={{ width: '100%', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer' }}
                onClick={() => navigate(`/jobs/${j.id}`)}
              >
                <PlateBadge plate={v?.plate} province={v?.province} />
                <div className="list-row-main">
                  <div className="list-row-title">{v ? `${v.brand} ${v.model}` : 'ไม่ทราบรุ่นรถ'}</div>
                  <div className="list-row-sub">{j.jobNumber}</div>
                </div>
                <span className="list-row-sub">฿{fmtMoney(jobGrandTotal(j))}</span>
                <span className="pill pill-success">ส่งมอบแล้ว</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
