import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fmtDT, type Job, type Vehicle } from '@champpower/domain';
import { api } from '../../lib/api/client';
import { useCollection } from '../../hooks/useCollection';
import { isAdmin, useAuth } from '../../hooks/useAuth';

/** Real soft-delete only exists on `jobs` in this schema (`deletedAt`/`deletedBy`
 * columns, see apps/api/src/db/migrations/0001_init.sql) — vehicles, customers,
 * master_parts, vehicle_models etc have no `deleted_at` column, so this page is
 * scoped to jobs only rather than showing fake "deleted customer/part" rows the old
 * mock UI implied. Adding soft-delete to other tables is a bigger schema change and
 * out of scope for this wiring pass. */
export function TrashPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const canPermanentlyDelete = isAdmin(auth);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const jobs = useCollection<Job>('/api/jobs?includeDeleted=1');
  const vehicles = useCollection<Vehicle>('/api/vehicles');

  const vehicleById = useMemo(() => new Map(vehicles.rows.map((v) => [v.id, v])), [vehicles.rows]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.rows
      .filter((j) => !!j.deletedAt)
      .filter((j) => {
        if (!q) return true;
        const v = vehicleById.get(j.vehicleId);
        return [j.jobNumber, j.deletedBy, v?.plate, v?.brand, v?.model].some((s) => (s || '').toLowerCase().includes(q));
      })
      .sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
  }, [jobs.rows, vehicleById, search]);

  const loading = jobs.loading || vehicles.loading;

  async function restore(jobId: string) {
    setBusyId(jobId);
    try {
      await api.post(`/api/jobs/${jobId}/restore`);
    } finally {
      setBusyId(null);
    }
  }

  async function permanentDelete(jobId: string, label: string) {
    if (!window.confirm(`ลบ "${label}" ถาวรใช่หรือไม่? การกระทำนี้ไม่สามารถย้อนกลับได้`)) return;
    setBusyId(jobId);
    try {
      await api.del(`/api/jobs/${jobId}/permanent`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ marginBottom: 0 }}>ถังขยะใบงาน</h1>
      </div>
      <p className="page-sub">ใบงานที่ถูกลบ — กู้คืนได้ทุกเมื่อ หรือลบถาวรหากเป็นผู้ดูแลระบบ</p>

      <input
        className="search-input"
        placeholder="ค้นหา เลขใบงาน / ทะเบียน / ผู้ลบ"
        style={{ marginBottom: 14 }}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">ไม่มีใบงานในถังขยะ</div>
      ) : (
        <div className="list-card">
          {rows.map((j) => {
            const v = vehicleById.get(j.vehicleId);
            const label = `${j.jobNumber}${v ? ` – ${v.brand} ${v.model}` : ''}`;
            return (
              <div className="list-row" key={j.id}>
                <span className="pill pill-muted">ใบงาน</span>
                <div className="list-row-main">
                  <button
                    type="button"
                    className="list-row-title"
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => navigate(`/jobs/${j.id}`)}
                  >
                    {label}
                  </button>
                  <div className="list-row-sub">
                    ลบโดย {j.deletedBy || 'ไม่ทราบ'} • {fmtDT(j.deletedAt)}
                  </div>
                </div>
                <div className="list-row-actions">
                  <button type="button" className="btn secondary small" disabled={busyId === j.id} onClick={() => restore(j.id)}>
                    กู้คืน
                  </button>
                  {canPermanentlyDelete && (
                    <button
                      type="button"
                      className="btn danger small"
                      disabled={busyId === j.id}
                      onClick={() => permanentDelete(j.id, label)}
                    >
                      ลบถาวร
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
