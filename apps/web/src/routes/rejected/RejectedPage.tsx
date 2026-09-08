import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtMoney, jobGrandTotal, type Customer, type Job, type Vehicle } from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';
import { PlateBadge } from '../../components/ui/PlateBadge';

/** Jobs at status `rejected` — "customer declined the quote". `Job`/`PartNeeded` have
 * no reject-reason field anywhere in the schema (see packages/domain/src/types/job.ts),
 * so unlike the old mock UI there is no "เหตุผล" column here — adding one would mean a
 * new DB column, which is out of scope for a wiring pass. The last status-change
 * timestamp (from `statusHistory`) stands in for the mock's "เมื่อ" column instead. */
export function RejectedPage() {
  const navigate = useNavigate();
  const jobs = useCollection<Job>('/api/jobs?includeDeleted=1');
  const vehicles = useCollection<Vehicle>('/api/vehicles');
  const customers = useCollection<Customer>('/api/customers');

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);
  const customerById = useMemo(() => new Map(customers.rows.map((c) => [c.id, c])), [customers.rows]);

  const rows = useMemo(() => {
    return jobs.rows
      .filter((j) => !j.deletedAt && j.status === 'rejected')
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [jobs.rows]);

  const loading = jobs.loading || vehicles.loading || customers.loading;

  return (
    <div className="page">
      <h1>รายการไม่อนุมัติ</h1>
      <p className="page-sub">งานที่ลูกค้าไม่อนุมัติใบเสนอราคา — รอติดตามกลับ</p>

      <h2 className="section-title">รอติดตาม</h2>
      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">ไม่มีงานที่ถูกปฏิเสธ</div>
      ) : (
        <div className="list-card">
          {rows.map((j) => {
            const v = vehicleById.get(j.vehicleId);
            const c = customerById.get(j.customerId);
            const rejectedEntry = [...(j.statusHistory || [])].reverse().find((h) => h.status === 'rejected');
            return (
              <button
                type="button"
                key={j.id}
                className="list-row"
                style={{
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  borderLeft: '4px solid var(--gold)',
                  paddingLeft: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
                onClick={() => navigate(`/jobs/${j.id}`)}
              >
                <PlateBadge plate={v?.plate} province={v?.province} />
                <div className="list-row-main">
                  <div className="list-row-title">
                    {j.jobNumber} · {v ? `${v.brand} ${v.model}` : 'ไม่ทราบรุ่นรถ'} — ฿{fmtMoney(jobGrandTotal(j))}
                  </div>
                  <div className="list-row-sub">
                    {c?.name || 'ไม่ทราบชื่อลูกค้า'}{c?.phone ? ` · ${c.phone}` : ''}
                    {rejectedEntry ? ` · ${new Date(rejectedEntry.changedAt).toLocaleString('th-TH')}` : ''}
                  </div>
                </div>
                <span className="pill pill-danger">ไม่อนุมัติ</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
