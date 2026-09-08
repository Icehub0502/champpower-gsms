import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BRAND_OPTIONS, VEHICLE_MODELS, seedKeyOf, type VehicleModel } from '@champpower/domain';
import { api } from '../../lib/api/client';
import { useCollection } from '../../hooks/useCollection';
import { isAdmin, useAuth } from '../../hooks/useAuth';

export function ModelsPage() {
  const navigate = useNavigate();
  const auth = useAuth();
  const canManageCatalog = isAdmin(auth);
  const models = useCollection<VehicleModel>('/api/models');
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models.rows;
    return models.rows.filter((m) => `${m.brand} ${m.name}`.toLowerCase().includes(q));
  }, [models.rows, search]);

  const missingFromCatalog = useMemo(() => {
    const existingKeys = new Set(models.rows.map((m) => seedKeyOf(m.brand, m.name)));
    return VEHICLE_MODELS.filter((cm) => !existingKeys.has(seedKeyOf(cm.brand, cm.name)));
  }, [models.rows]);

  async function importCatalog() {
    setBusy(true);
    try {
      await Promise.all(
        missingFromCatalog.map((cm) => api.post('/api/models', { brand: cm.brand, name: cm.name, parts: [], promotions: [] })),
      );
    } finally {
      setBusy(false);
    }
  }

  async function addModel() {
    if (!brand.trim() || !name.trim()) return;
    setBusy(true);
    try {
      const created = await api.post<VehicleModel>('/api/models', {
        brand: brand.trim().toUpperCase(),
        name: name.trim().toUpperCase(),
        parts: [],
        promotions: [],
      });
      setName('');
      navigate(`/models/${created.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>รุ่นรถ</h1>
      <p className="page-sub">{models.rows.length} รุ่น</p>

      <input
        className="search-input"
        placeholder="ค้นหายี่ห้อ / รุ่น..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {canManageCatalog && (
        <div className="card">
          <h3>เพิ่มรุ่นใหม่</h3>
          <div className="row-flex">
            <input list="brand-options-models" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="ยี่ห้อ" />
            <datalist id="brand-options-models">
              {BRAND_OPTIONS.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ชื่อรุ่น" />
            <button className="btn" onClick={addModel} disabled={busy}>
              เพิ่ม
            </button>
          </div>
          {missingFromCatalog.length > 0 && (
            <button className="btn secondary" style={{ marginTop: 10 }} onClick={importCatalog} disabled={busy}>
              นำเข้ารุ่นจากแคตตาล็อกร้าน ({missingFromCatalog.length})
            </button>
          )}
        </div>
      )}

      {models.loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">ยังไม่มีรุ่นรถในระบบ</div>
      ) : (
        <div className="model-grid">
          {filtered.map((m) => (
            <button key={m.id} className="model-card" onClick={() => navigate(`/models/${m.id}`)}>
              <div className="model-card-brand">{m.brand}</div>
              <div className="model-card-name">{m.name}</div>
              <div className="model-card-meta">{(m.parts || []).length} อะไหล่</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
