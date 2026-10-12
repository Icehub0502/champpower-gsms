import { useEffect, useState } from 'react';
import type {
  VehicleModel, VehicleModelAssignInput, VehicleModelAssigned, VehicleModelCreateInput, VehicleModelPage,
} from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import type { QuotationState } from './useQuotation';

interface VehicleModelPickerProps {
  busyKey: string | null;
  guard: QuotationState['guard'];
  /** The car this job is for (Quotation.vehicleId). */
  vehicleId: string;
  /** Called after the car was matched — the page reloads so prices follow the model. */
  onAssigned: () => void;
}

/**
 * "เลือกรุ่นรถ" / "เพิ่มรุ่นใหม่" for a car not yet matched to the controlled
 * model list (v3 §4.2): until it is, prices fall back to the base price and a
 * first price cannot be remembered per model. Search works like the province
 * picker — type, pick. Adding a model goes to the shop's controlled list, then
 * is assigned the same way.
 */
export function VehicleModelPicker({ vehicleId, busyKey, guard, onAssigned }: VehicleModelPickerProps) {
  const [open, setOpen] = useState<'pick' | 'add' | null>(null);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<VehicleModel[]>([]);
  const [brand, setBrand] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = busyKey !== null;

  // PUT /api/vehicles/:id/model — advisor+, audited on the server (v3 §4.2).
  async function onAssign(model: VehicleModel): Promise<boolean> {
    setError(null);
    const body: VehicleModelAssignInput = { vehicleModelId: model.id };
    const result = await guard('model-assign', () =>
      api.put<VehicleModelAssigned>(`/api/vehicles/${encodeURIComponent(vehicleId)}/model`, body));
    if (result.ok) {
      onAssigned();
      return true;
    }
    if (!result.failure.cancelled) setError(result.failure.text);
    return false;
  }

  useEffect(() => {
    if (open !== 'pick') return;
    let cancelled = false;
    const params = new URLSearchParams({ limit: '20', offset: '0', ...(q.trim() ? { q: q.trim() } : {}) });
    const t = window.setTimeout(() => {
      api.get<VehicleModelPage>(`/api/vehicle-models?${params.toString()}`)
        .then((page) => { if (!cancelled) setItems(page.items); })
        .catch((err: unknown) => { if (!cancelled && !isSessionCancelled(err)) setError('ค้นหารุ่นรถไม่สำเร็จ ลองใหม่'); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [open, q]);

  async function addModel() {
    setError(null);
    if (brand.trim() === '' || name.trim() === '') { setError('กรอกยี่ห้อและรุ่น'); return; }
    const body: VehicleModelCreateInput = { brand: brand.trim(), name: name.trim() };
    const result = await guard('model-add', () => api.post<VehicleModel>('/api/vehicle-models', body));
    if (result.ok) { if (await onAssign(result.value)) setOpen(null); return; }
    if (result.failure.cancelled) return;
    // Already in the list: use that one instead of making a near-duplicate (the R2 problem).
    const refusal = result.failure.body;
    if (refusal?.error === 'vehicle_model_exists') {
      if (await onAssign({ id: refusal.vehicleModelId, brand: brand.trim(), name: name.trim(), yearRange: null })) setOpen(null);
      return;
    }
    setError(result.failure.text);
  }

  return (
    <div className="qt-model-picker">
      <div className="row-flex">
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => setOpen('pick')}>เลือกรุ่นรถ</button>
        <button type="button" className="btn secondary small" disabled={busy} onClick={() => setOpen('add')}>เพิ่มรุ่นใหม่</button>
      </div>
      {error && <p className="ci-field-error" role="alert">{error}</p>}
      {open === 'pick' && (
        <div className="qt-model-pick">
          <input aria-label="ค้นหารุ่นรถ" placeholder="พิมพ์ยี่ห้อหรือรุ่น เช่น Vios" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="prov-list qt-model-list" role="listbox" aria-label="รุ่นรถ">
            {items.map((m) => (
              <li key={m.id} role="option" aria-selected={false}>
                <button type="button" className="prov-option" disabled={busy} onClick={() => void onAssign(m).then((ok) => { if (ok) setOpen(null); })}>
                  {m.brand} {m.name}{m.yearRange && ` (${m.yearRange})`}
                </button>
              </li>
            ))}
            {items.length === 0 && <li className="prov-empty">ไม่พบรุ่น — กด “เพิ่มรุ่นใหม่”</li>}
          </ul>
        </div>
      )}
      {open === 'add' && (
        <form className="row-flex" onSubmit={(e) => { e.preventDefault(); void addModel(); }}>
          <label className="field"><span>ยี่ห้อ</span><input value={brand} maxLength={80} onChange={(e) => setBrand(e.target.value)} /></label>
          <label className="field"><span>รุ่น</span><input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></label>
          <button type="submit" className="btn small" disabled={busy}>{busyKey === 'model-add' ? 'กำลังเพิ่ม...' : 'เพิ่มและเลือก'}</button>
        </form>
      )}
    </div>
  );
}
