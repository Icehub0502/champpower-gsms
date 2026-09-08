import { useMemo, useState } from 'react';
import type { Job, ShopConfig, TechnicianEntry } from '@champpower/domain';
import { api } from '../../lib/api/client';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';
import { isAdmin, useAuth } from '../../hooks/useAuth';
import { Icon } from '../../components/ui/Icon';

/** `ShopConfig.technicians` only stores `{ id, name }` — no role/specialty/status
 * fields exist anywhere in the schema, so unlike the old mock UI this page shows just
 * the name plus a real, cheaply-derivable "active jobs" count (jobs currently assigned
 * to that name that aren't delivered/carout yet). Anything requiring historical
 * aggregation (completion rate, avg time, etc.) would have to be guessed at and is
 * left out. Mutations write through PATCH /api/config (same endpoint JobCard/
 * JobListPage already use to add a technician inline) and are admin-gated to match
 * the roster-change rule already applied elsewhere in this app. */
export function TechniciansPage() {
  const auth = useAuth();
  const canManage = isAdmin(auth);
  const config = useDocument<ShopConfig>('/api/config');
  const jobs = useCollection<Job>('/api/jobs?includeDeleted=1');
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const technicians = config.data?.technicians || [];

  const activeJobCountByName = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const j of jobs.rows) {
      if (j.deletedAt || !j.technician) continue;
      if (j.status === 'delivered' || j.status === 'carout') continue;
      counts[j.technician] = (counts[j.technician] ?? 0) + 1;
    }
    return counts;
  }, [jobs.rows]);

  async function saveTechnicians(next: TechnicianEntry[]) {
    setBusy(true);
    try {
      await api.patch<ShopConfig>('/api/config', { technicians: next });
    } finally {
      setBusy(false);
    }
  }

  async function addTechnician() {
    const trimmed = newName.trim();
    if (!trimmed || technicians.some((t) => t.name === trimmed)) return;
    await saveTechnicians([...technicians, { id: crypto.randomUUID(), name: trimmed }]);
    setNewName('');
  }

  async function renameTechnician(id: string) {
    const trimmed = renaming[id]?.trim();
    if (!trimmed) return;
    await saveTechnicians(technicians.map((t) => (t.id === id ? { ...t, name: trimmed } : t)));
    setRenaming((r) => {
      const { [id]: _drop, ...rest } = r;
      return rest;
    });
  }

  async function removeTechnician(id: string, name: string) {
    if (!window.confirm(`ลบ "${name}" ออกจากทีมช่างใช่หรือไม่?`)) return;
    await saveTechnicians(technicians.filter((t) => t.id !== id));
  }

  const loading = config.loading || jobs.loading;

  return (
    <div className="page">
      <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ marginBottom: 0 }}>ทีมช่าง</h1>
      </div>
      <p className="page-sub">รายชื่อช่างในทีม และจำนวนงานที่กำลังรับผิดชอบอยู่</p>

      {canManage && (
        <div className="row-flex" style={{ gap: 8, marginBottom: 16 }}>
          <input
            className="search-input"
            style={{ flex: '1 1 240px' }}
            placeholder="ชื่อช่างใหม่"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTechnician();
            }}
          />
          <button type="button" className="btn" disabled={busy || !newName.trim()} onClick={addTechnician}>
            <Icon name="plus" size={14} /> เพิ่มช่าง
          </button>
        </div>
      )}

      {loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : technicians.length === 0 ? (
        <div className="empty-state">ยังไม่มีช่างในทีม</div>
      ) : (
        <div className="tech-grid">
          {technicians.map((t) => {
            const activeJobs = activeJobCountByName[t.name] ?? 0;
            const isRenaming = t.id in renaming;
            return (
              <div className="tech-card" key={t.id}>
                <div className="tech-card-head">
                  <div className="avatar-circle" aria-hidden="true">{t.name.charAt(0)}</div>
                  <div className="tech-card-head-meta">
                    {isRenaming ? (
                      <input
                        className="search-input"
                        value={renaming[t.id]}
                        autoFocus
                        onChange={(e) => setRenaming((r) => ({ ...r, [t.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') renameTechnician(t.id);
                          if (e.key === 'Escape') setRenaming((r) => { const { [t.id]: _d, ...rest } = r; return rest; });
                        }}
                      />
                    ) : (
                      <div className="name">{t.name}</div>
                    )}
                  </div>
                </div>
                <span className={`pill ${activeJobs > 0 ? 'pill-danger' : 'pill-success'}`}>
                  {activeJobs > 0 ? `กำลังทำงาน ${activeJobs} คัน` : 'ว่าง'}
                </span>
                <div className="row-flex" style={{ gap: 6 }}>
                  {canManage && (
                    <>
                      {isRenaming ? (
                        <button type="button" className="btn small" disabled={busy} onClick={() => renameTechnician(t.id)}>
                          บันทึก
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn secondary small"
                          onClick={() => setRenaming((r) => ({ ...r, [t.id]: t.name }))}
                        >
                          แก้ไขชื่อ
                        </button>
                      )}
                      <button type="button" className="btn danger small" disabled={busy} onClick={() => removeTechnician(t.id, t.name)}>
                        ลบ
                      </button>
                    </>
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
