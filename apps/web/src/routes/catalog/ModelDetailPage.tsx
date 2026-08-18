import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { doc, updateDoc } from 'firebase/firestore';
import {
  UNIT_OPTIONS,
  type MasterPart,
  type ModelPart,
  type VehicleModel,
} from '@champpower/domain';
import { db } from '../../lib/firebase/client';
import { useCollection } from '../../hooks/useCollection';

interface PartBrandOption {
  id: string;
  name: string;
}

function newId() {
  return crypto.randomUUID();
}

export function ModelDetailPage() {
  const { modelId } = useParams();
  const navigate = useNavigate();
  const models = useCollection<VehicleModel>('models');
  const masterParts = useCollection<MasterPart>('masterParts');
  const brandOptions = useCollection<PartBrandOption>('partBrandOptions');
  const [customName, setCustomName] = useState('');
  const [brandInputs, setBrandInputs] = useState<Record<string, { name: string; price: string }>>({});
  const [busy, setBusy] = useState(false);

  const model = models.rows.find((m) => m.id === modelId);

  if (models.loading) return <div className="page-loading">กำลังโหลด...</div>;
  if (!model) return <div className="empty-state">ไม่พบรุ่นรถนี้</div>;

  const modelRef = doc(db, 'models', model.id);
  const parts = model.parts || [];
  const usedNames = new Set(parts.map((p) => p.partName));

  async function saveParts(next: ModelPart[]) {
    setBusy(true);
    try {
      await updateDoc(modelRef, { parts: next });
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

  function removePart(id: string) {
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

  function removeBrand(partId: string, brandId: string) {
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
        <h2>
          {model.brand} {model.name}
        </h2>
        <p className="page-sub">{parts.length} อะไหล่ในรุ่นนี้</p>
      </div>

      <div className="card">
        <h3>อะไหล่ในรุ่นนี้</h3>
        {parts.length === 0 && <div className="empty-state">ยังไม่มีอะไหล่ — เพิ่มจากด้านล่าง</div>}
        {parts.map((p) => (
          <div className="model-part-block" key={p.id}>
            <div className="model-part-row">
              <span className="model-part-name">{p.partName}</span>
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
              <button className="chip-remove-btn" disabled={busy} onClick={() => removePart(p.id)}>
                ลบ
              </button>
            </div>

            <div className="model-part-brands">
              {(p.brands || []).map((b) => (
                <span className="chip active" key={b.id}>
                  {b.name} {b.price ? `฿${b.price}` : ''}
                  <button className="chip-remove" onClick={() => removeBrand(p.id, b.id)} aria-label={`ลบ ${b.name}`}>
                    ×
                  </button>
                </span>
              ))}
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
                <button onClick={() => addBrand(p.id)} disabled={busy}>
                  + แบรนด์
                </button>
              </div>
            </div>
          </div>
        ))}
        <datalist id="brand-name-options">
          {brandOptions.rows.map((b) => (
            <option key={b.id} value={b.name} />
          ))}
        </datalist>
      </div>

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
          <button onClick={addCustomPart} disabled={busy}>
            เพิ่ม
          </button>
        </div>
      </div>
    </div>
  );
}
