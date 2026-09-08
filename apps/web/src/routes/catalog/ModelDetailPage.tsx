import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  UNIT_OPTIONS,
  type MasterPart,
  type ModelPart,
  type VehicleModel,
} from '@champpower/domain';
import { api } from '../../lib/api/client';
import { useCollection } from '../../hooks/useCollection';
import { isAdmin, useAuth } from '../../hooks/useAuth';

function newId() {
  return crypto.randomUUID();
}

export function ModelDetailPage() {
  const { modelId } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const canManageCatalog = isAdmin(auth);
  const models = useCollection<VehicleModel>('/api/models');
  const masterParts = useCollection<MasterPart>('/api/master-parts');
  // No dedicated brand-options endpoint in the new backend — derive the datalist from
  // brands already attached to any model's parts instead of a separate collection.
  const brandNameOptions = useMemo(() => {
    const names = new Set<string>();
    for (const m of models.rows) {
      for (const p of m.parts) {
        for (const b of p.brands || []) names.add(b.name);
      }
    }
    return Array.from(names).sort();
  }, [models.rows]);
  const [customName, setCustomName] = useState('');
  const [brandInputs, setBrandInputs] = useState<Record<string, { name: string; price: string }>>({});
  const [busy, setBusy] = useState(false);

  const model = models.rows.find((m) => m.id === modelId);

  if (models.loading) return <div className="page-loading">กำลังโหลด...</div>;
  if (!model) return <div className="empty-state">ไม่พบรุ่นรถนี้</div>;

  const currentModelId = model.id;
  const parts = model.parts || [];
  const usedNames = new Set(parts.map((p) => p.partName));

  async function saveParts(next: ModelPart[]) {
    setBusy(true);
    try {
      await api.patch(`/api/models/${currentModelId}`, { parts: next });
    } finally {
      setBusy(false);
    }
  }

  function addExistingPart(mp: MasterPart) {
    if (usedNames.has(mp.name)) return;
    saveParts([...parts, { id: newId(), partName: mp.name, category: mp.category, qty: '', unit: 'ชิ้น', brands: [] }]);
  }

  function addCustomPart() {
    const trimmed = customName.trim();
    if (!trimmed || usedNames.has(trimmed)) return;
    saveParts([...parts, { id: newId(), partName: trimmed, qty: '', unit: 'ชิ้น', brands: [] }]);
    setCustomName('');
  }

  function updatePart(id: string, patch: Partial<ModelPart>) {
    saveParts(parts.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function removePart(id: string, partName: string) {
    if (!window.confirm(`ลบอะไหล่ "${partName}" ออกจากรุ่นนี้ใช่หรือไม่?`)) return;
    saveParts(parts.filter((p) => p.id !== id));
  }

  function addBrand(partId: string) {
    const input = brandInputs[partId];
    const name = input?.name.trim();
    if (!name) return;
    const part = parts.find((p) => p.id === partId);
    if (!part) return;
    updatePart(partId, { brands: [...(part.brands || []), { id: newId(), name, price: input.price.trim() }] });
    setBrandInputs((prev) => ({ ...prev, [partId]: { name: '', price: '' } }));
  }

  function removeBrand(partId: string, brandId: string, brandName: string) {
    if (!window.confirm(`ลบแบรนด์ "${brandName}" ใช่หรือไม่?`)) return;
    const part = parts.find((p) => p.id === partId);
    if (!part) return;
    updatePart(partId, { brands: (part.brands || []).filter((b) => b.id !== brandId) });
  }

  const availableMaster = masterParts.rows.filter((mp) => !usedNames.has(mp.name));

  return (
    <div className="page">
      <button className="back-link" onClick={() => navigate('/models')}>
        ‹ กลับไปรุ่นรถ
      </button>

      <div className="card">
        <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>
            {model.brand} {model.name}
          </h2>
          <button className="btn secondary small" onClick={() => navigate(`/models/${currentModelId}/promotions`)}>
            โปรโมชั่น ({(model.promotions || []).length})
          </button>
        </div>
        <p className="page-sub">{parts.length} อะไหล่ในรุ่นนี้</p>
      </div>

      <div className="card">
        <h3>อะไหล่ในรุ่นนี้</h3>
        {!canManageCatalog && <p className="page-sub">ดูได้อย่างเดียว การแก้ไขอะไหล่/ราคาต้องใช้บัญชีผู้ดูแลระบบ</p>}
        {parts.length === 0 && <div className="empty-state">ยังไม่มีอะไหล่ — เพิ่มจากด้านล่าง</div>}
        {parts.map((p) => (
          <div className="model-part-block" key={p.id}>
            <div className="model-part-row">
              <span className="model-part-name">{p.partName}</span>
              {canManageCatalog ? (
                <>
                  <input
                    className="model-part-qty"
                    placeholder="จำนวน"
                    defaultValue={p.qty}
                    onBlur={(e) => updatePart(p.id, { qty: e.target.value })}
                  />
                  <select defaultValue={p.unit || 'ชิ้น'} onChange={(e) => updatePart(p.id, { unit: e.target.value })}>
                    {UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                  <button className="btn danger small" disabled={busy} onClick={() => removePart(p.id, p.partName)}>
                    ลบ
                  </button>
                </>
              ) : (
                <span className="page-sub">
                  {p.qty || '-'} {p.unit || 'ชิ้น'}
                </span>
              )}
            </div>

            <div className="model-part-brands">
              {(p.brands || []).map((b) => (
                <span className="chip active" key={b.id}>
                  {b.name} {b.price ? `฿${b.price}` : ''}
                  {canManageCatalog && (
                    <button className="chip-remove" onClick={() => removeBrand(p.id, b.id, b.name)} aria-label={`ลบ ${b.name}`}>
                      ×
                    </button>
                  )}
                </span>
              ))}
              {canManageCatalog && (
                <div className="row-flex" style={{ marginTop: 6 }}>
                  <input
                    list="brand-name-options"
                    placeholder="แบรนด์"
                    value={brandInputs[p.id]?.name || ''}
                    onChange={(e) =>
                      setBrandInputs((prev) => ({ ...prev, [p.id]: { name: e.target.value, price: prev[p.id]?.price || '' } }))
                    }
                    style={{ maxWidth: 140 }}
                  />
                  <input
                    type="number"
                    placeholder="ราคา"
                    value={brandInputs[p.id]?.price || ''}
                    onChange={(e) =>
                      setBrandInputs((prev) => ({ ...prev, [p.id]: { name: prev[p.id]?.name || '', price: e.target.value } }))
                    }
                    style={{ maxWidth: 100 }}
                  />
                  <button className="btn small" onClick={() => addBrand(p.id)} disabled={busy}>
                    + แบรนด์
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        <datalist id="brand-name-options">
          {brandNameOptions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>

      {canManageCatalog && (
        <div className="card">
          <h3>เพิ่มจากรายการอะไหล่กลาง</h3>
          <div className="complaint-chips">
            {availableMaster.map((mp) => (
              <button key={mp.id} className="chip" disabled={busy} onClick={() => addExistingPart(mp)}>
                + {mp.name}
              </button>
            ))}
            {availableMaster.length === 0 && <span className="page-sub">ไม่มีอะไหล่กลางให้เพิ่มแล้ว</span>}
          </div>
          <div className="row-flex" style={{ marginTop: 10 }}>
            <input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="อะไหล่อื่นๆ..." />
            <button className="btn" onClick={addCustomPart} disabled={busy}>
              เพิ่ม
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
