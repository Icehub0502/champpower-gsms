import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PART_CATEGORIES, fmtMoney, type VehicleModel } from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';

type SortKey = 'name' | 'priceMin' | 'priceMax' | 'parts';

interface PriceRow {
  model: VehicleModel;
  pricedPartCount: number;
  min: number | null;
  max: number | null;
}

function priceRowsOf(models: VehicleModel[]): PriceRow[] {
  return models.map((model) => {
    const prices: number[] = [];
    for (const part of model.parts) {
      for (const brand of part.brands || []) {
        const n = Number(brand.price);
        if (brand.price && !Number.isNaN(n)) prices.push(n);
      }
    }
    return {
      model,
      pricedPartCount: prices.length,
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
    };
  });
}

export function PriceBookPage() {
  const navigate = useNavigate();
  const models = useCollection<VehicleModel>('/api/models');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [pricedOnly, setPricedOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  function toggleSelected(id: string) {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.rows.filter((m) => {
      if (category !== 'all' && !m.parts.some((p) => p.category === category)) return false;
      if (!q) return true;
      if (`${m.brand} ${m.name}`.toLowerCase().includes(q)) return true;
      return m.parts.some((p) => p.partName.toLowerCase().includes(q));
    });
  }, [models.rows, search, category]);

  const rows = useMemo(() => {
    let list = priceRowsOf(filteredModels);
    if (pricedOnly) list = list.filter((r) => r.min !== null);
    list = list.slice().sort((a, b) => {
      if (sortKey === 'name') return `${a.model.brand} ${a.model.name}`.localeCompare(`${b.model.brand} ${b.model.name}`);
      if (sortKey === 'priceMin') return (a.min ?? Infinity) - (b.min ?? Infinity);
      if (sortKey === 'priceMax') return (b.max ?? -Infinity) - (a.max ?? -Infinity);
      return b.pricedPartCount - a.pricedPartCount;
    });
    return list;
  }, [filteredModels, sortKey, pricedOnly]);

  const activeFilterSummary = [
    search.trim() ? `ค้นหา "${search.trim()}"` : null,
    category !== 'all' ? category : null,
    pricedOnly ? 'มีราคาเท่านั้น' : null,
  ]
    .filter(Boolean)
    .join(' · ') || 'ไม่มีตัวกรอง';

  return (
    <div className="page">
      <h1>ตำราคาอะไหล่และค่าแรง</h1>
      <p className="page-sub">เปรียบเทียบช่วงราคาอะไหล่ข้ามรุ่นรถทั้งหมด ({models.rows.length} รุ่น)</p>

      <div className="row-flex" style={{ marginBottom: 12 }}>
        <input
          className="search-input"
          style={{ flex: '1 1 220px' }}
          placeholder="ค้นหารุ่นรถ / ชื่ออะไหล่..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">ทุกหมวดหมู่</option>
          {PART_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
          <option value="name">เรียงตาม: ชื่อรุ่น</option>
          <option value="priceMin">เรียงตาม: ราคาต่ำสุด</option>
          <option value="priceMax">เรียงตาม: ราคาสูงสุด</option>
          <option value="parts">เรียงตาม: จำนวนอะไหล่ที่มีราคา</option>
        </select>
        <button className={`chip ${pricedOnly ? 'active' : ''}`} onClick={() => setPricedOnly((v) => !v)}>
          เฉพาะที่มีราคา
        </button>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card kpi-blue">
          <div className="kpi-card-value" style={{ fontSize: 16 }}>
            {activeFilterSummary}
          </div>
          <div className="kpi-card-label">ตัวกรอง</div>
        </div>
        <div className="kpi-card kpi-orange">
          <div className="kpi-card-value" style={{ fontSize: 18 }}>
            เปรียบเทียบหลายรุ่น
          </div>
          <div className="kpi-card-label">โปรเปรียบเทียบ</div>
          <button
            className="btn small"
            style={{ marginTop: 8 }}
            onClick={() => navigate(selectedIds.length ? `/price-book/print?models=${selectedIds.join(',')}` : '/price-book/print')}
          >
            เปิด Bulk Price {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
          </button>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-card-value">{rows.length} รุ่น</div>
          <div className="kpi-card-label">ผลลัพธ์</div>
        </div>
      </div>

      <div className="card">
        <h3>ผลการค้นหาราคา</h3>
        {models.loading ? (
          <div className="page-loading">กำลังโหลด...</div>
        ) : rows.length === 0 ? (
          <div className="empty-state">ไม่พบรุ่นรถที่ตรงกับตัวกรอง</div>
        ) : (
          <div className="table-wrap">
            <table className="parts-table">
              <thead>
                <tr>
                  <th className="center" style={{ width: 36 }}>
                    <span className="sr-only">เลือกเพื่อพิมพ์รวม</span>
                  </th>
                  <th>รุ่นรถ</th>
                  <th className="center">จำนวนอะไหล่ที่มีราคา</th>
                  <th>ช่วงราคา</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.model.id}>
                    <td className="center">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(r.model.id)}
                        onChange={() => toggleSelected(r.model.id)}
                        aria-label={`เลือก ${r.model.brand} ${r.model.name} สำหรับพิมพ์รวม`}
                      />
                    </td>
                    <td>
                      {r.model.brand} {r.model.name}
                    </td>
                    <td className="center">{r.pricedPartCount}</td>
                    <td>{r.min !== null ? `฿${fmtMoney(r.min)} – ฿${fmtMoney(r.max!)}` : 'ยังไม่มีราคา'}</td>
                    <td>
                      <button className="btn secondary small" onClick={() => navigate(`/models/${r.model.id}`)}>
                        ดูราคา
                      </button>
                    </td>
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
