import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DEFAULT_MASTER_PARTS,
  PART_CATEGORIES,
  dayKey,
  shiftDay,
  todayKey,
  type MasterPart,
  type VehicleModel,
} from '@champpower/domain';
import { api } from '../../lib/api/client';
import { useCollection } from '../../hooks/useCollection';
import { isAdmin, useAuth } from '../../hooks/useAuth';
import { Icon } from '../../components/ui/Icon';

export function MasterPartsPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const canManageCatalog = isAdmin(auth);
  const parts = useCollection<MasterPart>('/api/master-parts');
  const models = useCollection<VehicleModel>('/api/models');

  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>(PART_CATEGORIES[0]);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<string>(PART_CATEGORIES[0]);
  const [busy, setBusy] = useState(false);

  // How many vehicle models currently reference each master part by name — the
  // cheapest real "linked" signal available without a dedicated join table.
  const linkedModelCountByName = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of models.rows) {
      const namesInModel = new Set(m.parts.map((p) => p.partName));
      for (const n of namesInModel) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return counts;
  }, [models.rows]);

  const weekAgoKey = shiftDay(todayKey(), -7);
  const addedThisWeekCount = useMemo(
    () => parts.rows.filter((p) => p.createdAt && dayKey(p.createdAt) >= weekAgoKey).length,
    [parts.rows, weekAgoKey],
  );

  const categoryCount = useMemo(() => new Set(parts.rows.map((p) => p.category)).size, [parts.rows]);

  const filtered = useMemo(() => {
    let rows = parts.rows;
    if (categoryFilter !== 'all') rows = rows.filter((p) => p.category === categoryFilter);
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
    return rows;
  }, [parts.rows, categoryFilter, search]);

  async function addPart() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.post('/api/master-parts', { name: trimmed, category });
      setName('');
    } finally {
      setBusy(false);
    }
  }

  async function seedDefaults() {
    setBusy(true);
    try {
      const existingNames = new Set(parts.rows.map((p) => p.name));
      const missing = DEFAULT_MASTER_PARTS.filter((p) => !existingNames.has(p.name));
      await Promise.all(missing.map((p) => api.post('/api/master-parts', { name: p.name, category: p.category })));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(p: MasterPart) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditCategory(p.category);
  }

  async function saveEdit() {
    if (!editingId) return;
    const trimmed = editName.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.patch(`/api/master-parts/${editingId}`, { name: trimmed, category: editCategory });
      setEditingId(null);
    } finally {
      setBusy(false);
    }
  }

  async function removePart(id: string, partName: string) {
    if (!window.confirm(`ลบอะไหล่ "${partName}" ใช่หรือไม่?`)) return;
    await api.del(`/api/master-parts/${id}`);
  }

  const loading = parts.loading;

  return (
    <div className="page">
      <h1>สินค้าและรายการอะไหล่มาตรฐาน</h1>
      <p className="page-sub">
        รายการอะไหล่กลางที่ใช้ผูกกับรุ่นรถ ({parts.rows.length} รายการ)
        {!canManageCatalog && ' — สิทธิ์ / สินค้า • Admin only — ดูได้อย่างเดียว การแก้ไขต้องใช้บัญชีผู้ดูแลระบบ'}
      </p>

      <div className="status-pills">
        {canManageCatalog && (
          <button className={`status-pill ${showAddForm ? 'active' : ''}`} onClick={() => setShowAddForm((v) => !v)}>
            <Icon name="plus" size={13} /> เพิ่มสินค้า
          </button>
        )}
        <button className="status-pill" onClick={() => navigate('/models')}>
          <Icon name="box" size={13} /> เชื่อมกับรายการ (รุ่นรถ)
        </button>
      </div>

      {canManageCatalog && showAddForm && (
        <div className="card">
          <h3>เพิ่มสินค้าใหม่</h3>
          <div className="row-flex">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่ออะไหล่" />
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {PART_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button className="btn" onClick={addPart} disabled={busy}>
              เพิ่ม
            </button>
          </div>
          {parts.rows.length === 0 && (
            <button className="btn secondary" style={{ marginTop: 10 }} onClick={seedDefaults} disabled={busy}>
              โหลดรายการอะไหล่เริ่มต้น ({DEFAULT_MASTER_PARTS.length} รายการ)
            </button>
          )}
        </div>
      )}

      <div className="kpi-grid">
        <div className="kpi-card kpi-blue">
          <div className="kpi-card-value">{parts.rows.length} รายการ</div>
          <div className="kpi-card-label">สรุปยอด</div>
          <div className="kpi-card-sub">อะไหล่มาตรฐานทั้งหมด</div>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-card-value">{addedThisWeekCount} รายการ</div>
          <div className="kpi-card-label">เข้าใหม่</div>
          <div className="kpi-card-sub">เพิ่มในช่วง 7 วันที่ผ่านมา</div>
        </div>
        <div className="kpi-card kpi-gold">
          <div className="kpi-card-value">{categoryCount} หมวด</div>
          <div className="kpi-card-label">หมวดหมู่</div>
          <div className="kpi-card-sub">ประเภทอะไหล่ที่ใช้อยู่</div>
        </div>
      </div>

      <div className="row-flex" style={{ marginBottom: 12 }}>
        <input
          className="search-input"
          style={{ flex: '1 1 220px' }}
          placeholder="ค้นหาชื่ออะไหล่..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="all">ทุกหมวดหมู่</option>
          {PART_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        <h3>รายการสินค้า ({filtered.length})</h3>
        {loading ? (
          <div className="page-loading">กำลังโหลด...</div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">ไม่พบรายการที่ตรงกับตัวกรอง</div>
        ) : (
          <div className="table-wrap">
            <table className="parts-table">
              <thead>
                <tr>
                  <th>ชื่ออะไหล่</th>
                  <th>หมวดหมู่</th>
                  <th className="center">เชื่อมกับรุ่นรถ</th>
                  {canManageCatalog && <th />}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    {editingId === p.id ? (
                      <>
                        <td>
                          <input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: 160 }} />
                        </td>
                        <td>
                          <select value={editCategory} onChange={(e) => setEditCategory(e.target.value)}>
                            {PART_CATEGORIES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="center">{linkedModelCountByName.get(p.name) ?? 0} รุ่น</td>
                        <td>
                          <div className="row-flex" style={{ gap: 4 }}>
                            <button className="btn small" onClick={saveEdit} disabled={busy}>
                              บันทึก
                            </button>
                            <button className="btn secondary small" onClick={() => setEditingId(null)}>
                              ยกเลิก
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{p.name}</td>
                        <td>{p.category}</td>
                        <td className="center">{linkedModelCountByName.get(p.name) ?? 0} รุ่น</td>
                        {canManageCatalog && (
                          <td>
                            <div className="row-flex" style={{ gap: 4 }}>
                              <button className="btn secondary small" onClick={() => startEdit(p)}>
                                แก้ไข
                              </button>
                              <button className="btn danger small" onClick={() => removePart(p.id, p.name)}>
                                ลบ
                              </button>
                            </div>
                          </td>
                        )}
                      </>
                    )}
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
