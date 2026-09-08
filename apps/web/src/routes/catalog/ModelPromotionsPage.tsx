import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { todayKey, type Promotion, type VehicleModel } from '@champpower/domain';
import { api } from '../../lib/api/client';
import { useCollection } from '../../hooks/useCollection';
import { isAdmin, useAuth } from '../../hooks/useAuth';

function newId() {
  return crypto.randomUUID();
}

type StatusFilter = 'all' | 'active' | 'expired';

function promoStatus(p: Promotion): StatusFilter {
  if (!p.dateStart && !p.dateEnd) return 'active';
  const today = todayKey();
  if (p.dateEnd && p.dateEnd < today) return 'expired';
  if (p.dateStart && p.dateStart > today) return 'expired'; // not started yet — not currently usable
  return 'active';
}

const emptyDraft = { name: '', itemIds: [] as string[], price: '', dateStart: '', dateEnd: '', mileageStart: '', mileageEnd: '' };

export function ModelPromotionsPage() {
  const { modelId } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const canManageCatalog = isAdmin(auth);
  const models = useCollection<VehicleModel>('/api/models');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);

  const model = models.rows.find((m) => m.id === modelId);

  if (models.loading) return <div className="page-loading">กำลังโหลด...</div>;
  if (!model) return <div className="empty-state">ไม่พบรุ่นรถนี้</div>;

  const currentModelId = model.id;
  const promotions = model.promotions || [];
  const partNameById = new Map(model.parts.map((p) => [p.id, p.partName]));

  const filtered = promotions.filter((p) => statusFilter === 'all' || promoStatus(p) === statusFilter);

  async function savePromotions(next: Promotion[]) {
    setBusy(true);
    try {
      await api.patch(`/api/models/${currentModelId}`, { promotions: next });
    } finally {
      setBusy(false);
    }
  }

  function startCreate() {
    setEditingId('new');
    setDraft(emptyDraft);
  }

  function startEdit(p: Promotion) {
    setEditingId(p.id);
    setDraft({
      name: p.name,
      itemIds: p.itemIds || [],
      price: p.price || '',
      dateStart: p.dateStart || '',
      dateEnd: p.dateEnd || '',
      mileageStart: p.mileageStart || '',
      mileageEnd: p.mileageEnd || '',
    });
  }

  function toggleItem(itemId: string) {
    setDraft((d) => ({
      ...d,
      itemIds: d.itemIds.includes(itemId) ? d.itemIds.filter((id) => id !== itemId) : [...d.itemIds, itemId],
    }));
  }

  async function saveDraft() {
    const trimmed = draft.name.trim();
    if (!trimmed) return;
    const record: Promotion = {
      id: editingId === 'new' ? newId() : editingId!,
      name: trimmed,
      itemIds: draft.itemIds,
      price: draft.price.trim() || undefined,
      dateStart: draft.dateStart || undefined,
      dateEnd: draft.dateEnd || undefined,
      mileageStart: draft.mileageStart.trim() || undefined,
      mileageEnd: draft.mileageEnd.trim() || undefined,
    };
    const next = editingId === 'new' ? [...promotions, record] : promotions.map((p) => (p.id === editingId ? record : p));
    await savePromotions(next);
    setEditingId(null);
    setDraft(emptyDraft);
  }

  async function removePromotion(id: string, name: string) {
    if (!window.confirm(`ลบโปรโมชั่น "${name}" ใช่หรือไม่?`)) return;
    await savePromotions(promotions.filter((p) => p.id !== id));
  }

  return (
    <div className="page">
      <button className="back-link" onClick={() => navigate(`/models/${currentModelId}`)}>
        ‹ กลับไปรุ่นรถ
      </button>

      <h1>โปรโมชั่นตามรุ่นรถ</h1>
      <p className="page-sub">
        {model.brand} {model.name} — {promotions.length} โปรโมชั่น
        {!canManageCatalog && ' — ดูได้อย่างเดียว การแก้ไขต้องใช้บัญชีผู้ดูแลระบบ'}
      </p>

      <div className="row-flex" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="status-pills" style={{ marginBottom: 0 }}>
          <button className={`status-pill ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => setStatusFilter('all')}>
            ทั้งหมด <span className="n">{promotions.length}</span>
          </button>
          <button className={`status-pill ${statusFilter === 'active' ? 'active' : ''}`} onClick={() => setStatusFilter('active')}>
            ใช้งาน <span className="n">{promotions.filter((p) => promoStatus(p) === 'active').length}</span>
          </button>
          <button className={`status-pill ${statusFilter === 'expired' ? 'active' : ''}`} onClick={() => setStatusFilter('expired')}>
            หมดอายุ <span className="n">{promotions.filter((p) => promoStatus(p) === 'expired').length}</span>
          </button>
        </div>
        {canManageCatalog && (
          <button className="btn small" onClick={startCreate}>
            + สร้างโปรโมชั่น
          </button>
        )}
      </div>

      <div className="kpi-grid">
        <div className="kpi-card kpi-blue">
          <div className="kpi-card-label">เงื่อนไข</div>
          <div className="kpi-card-sub">โปรโมชั่นประกอบด้วยชื่อ, รายการอะไหล่ที่ร่วมรายการ, ราคา และช่วงเวลา</div>
        </div>
        <div className="kpi-card kpi-gold">
          <div className="kpi-card-label">ช่วงเวลา</div>
          <div className="kpi-card-sub">กำหนดวันเริ่ม-สิ้นสุด หรือเว้นว่างไว้ให้ไม่มีกำหนด</div>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-card-label">ช่วงเลขไมล์</div>
          <div className="kpi-card-sub">ใช้กับรถที่มีเลขไมล์อยู่ในช่วงที่กำหนด (ถ้ามี)</div>
        </div>
      </div>

      {canManageCatalog && editingId && (
        <div className="card">
          <h3>{editingId === 'new' ? 'สร้างโปรโมชั่นใหม่' : 'แก้ไขโปรโมชั่น'}</h3>
          <div className="field">
            <span>ชื่อโปรโมชั่น</span>
            <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
          </div>
          <div className="field">
            <span>รายการอะไหล่ที่ร่วมรายการ</span>
            <div className="complaint-chips">
              {model.parts.length === 0 && <span className="page-sub">รุ่นนี้ยังไม่มีอะไหล่ให้เลือก</span>}
              {model.parts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`chip ${draft.itemIds.includes(p.id) ? 'active' : ''}`}
                  onClick={() => toggleItem(p.id)}
                >
                  {p.partName}
                </button>
              ))}
            </div>
          </div>
          <div className="row-flex">
            <label className="field" style={{ flex: '1 1 120px' }}>
              <span>ราคา (บาท)</span>
              <input type="number" value={draft.price} onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))} />
            </label>
            <label className="field" style={{ flex: '1 1 140px' }}>
              <span>เริ่ม</span>
              <input type="date" value={draft.dateStart} onChange={(e) => setDraft((d) => ({ ...d, dateStart: e.target.value }))} />
            </label>
            <label className="field" style={{ flex: '1 1 140px' }}>
              <span>ถึง</span>
              <input type="date" value={draft.dateEnd} onChange={(e) => setDraft((d) => ({ ...d, dateEnd: e.target.value }))} />
            </label>
          </div>
          <div className="row-flex">
            <label className="field" style={{ flex: '1 1 140px' }}>
              <span>เลขไมล์เริ่ม</span>
              <input value={draft.mileageStart} onChange={(e) => setDraft((d) => ({ ...d, mileageStart: e.target.value }))} />
            </label>
            <label className="field" style={{ flex: '1 1 140px' }}>
              <span>เลขไมล์สิ้นสุด</span>
              <input value={draft.mileageEnd} onChange={(e) => setDraft((d) => ({ ...d, mileageEnd: e.target.value }))} />
            </label>
          </div>
          <div className="row-flex">
            <button className="btn" onClick={saveDraft} disabled={busy || !draft.name.trim()}>
              บันทึก
            </button>
            <button className="btn secondary" onClick={() => setEditingId(null)}>
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3>โปรโมชั่น {model.brand} {model.name}</h3>
        {filtered.length === 0 ? (
          <div className="empty-state">ยังไม่มีโปรโมชั่นในตัวกรองนี้</div>
        ) : (
          <div className="table-wrap">
            <table className="parts-table">
              <thead>
                <tr>
                  <th>ชื่อโปรโมชั่น</th>
                  <th>รายการที่ร่วมรายการ</th>
                  <th>ราคา / ระยะเวลา</th>
                  {canManageCatalog && <th />}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{(p.itemIds || []).map((id) => partNameById.get(id) || id).join(', ') || '-'}</td>
                    <td>
                      {p.price ? `฿${p.price} ` : ''}
                      {p.dateEnd ? `• ถึง ${p.dateEnd}` : p.dateStart ? `• เริ่ม ${p.dateStart}` : '• ไม่มีกำหนด'}
                    </td>
                    {canManageCatalog && (
                      <td>
                        <div className="row-flex" style={{ gap: 4 }}>
                          <button className="btn secondary small" onClick={() => startEdit(p)}>
                            แก้ไข
                          </button>
                          <button className="btn danger small" onClick={() => removePromotion(p.id, p.name)}>
                            ลบ
                          </button>
                        </div>
                      </td>
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
