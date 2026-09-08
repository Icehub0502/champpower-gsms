import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { fmtMoney, type ShopConfig, type VehicleModel } from '@champpower/domain';
import { useCollection } from '../../hooks/useCollection';
import { useDocument } from '../../hooks/useDocument';

export function BulkPrintPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const models = useCollection<VehicleModel>('/api/models');
  const config = useDocument<ShopConfig>('/api/config');
  const [index, setIndex] = useState(0);

  const selectedIds = useMemo(() => {
    const raw = searchParams.get('models');
    return raw ? raw.split(',').filter(Boolean) : [];
  }, [searchParams]);

  const selectedModels = useMemo(
    () => selectedIds.map((id) => models.rows.find((m) => m.id === id)).filter((m): m is VehicleModel => !!m),
    [selectedIds, models.rows],
  );

  const shop = config.data?.shop;

  return (
    <div className="page">
      <div className="row-flex no-print" style={{ justifyContent: 'space-between' }}>
        <button className="back-link" onClick={() => navigate('/price-book')}>
          ‹ กลับรายการ
        </button>
        <button className="btn" onClick={() => window.print()}>
          พิมพ์ / PDF
        </button>
      </div>

      <h1>พรีวิวใบราคา / Bulk Print</h1>
      <p className="page-sub">
        {selectedModels.length > 0
          ? `เลือกไว้ ${selectedModels.length} รุ่น — ระบุรุ่นผ่าน ?models=id1,id2 ใน URL`
          : 'ยังไม่ได้เลือกรุ่นรถ — เพิ่ม ?models=id1,id2 ต่อท้าย URL หรือกลับไปเลือกจากตำราคา'}
      </p>

      <div className="kpi-grid no-print">
        <div className="kpi-card kpi-blue">
          <div className="kpi-card-label">หัวเอกสาร</div>
          <div className="kpi-card-sub">{shop ? `${shop.name} — ${shop.sub}` : 'ใช้ข้อมูลร้านจากหน้าตั้งค่า'}</div>
        </div>
        <div className="kpi-card kpi-gold">
          <div className="kpi-card-label">เนื้อหา</div>
          <div className="kpi-card-sub">รายการอะไหล่, แบรนด์, ราคาต่อรุ่น</div>
        </div>
        <div className="kpi-card kpi-green">
          <div className="kpi-card-label">ชุดพิมพ์</div>
          <div className="kpi-card-sub">ขึ้นหน้าใหม่ทุกรุ่นเมื่อสั่งพิมพ์</div>
        </div>
      </div>

      {selectedModels.length > 1 && (
        <div className="row-flex no-print" style={{ marginBottom: 12 }}>
          <button className="btn secondary small" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
            ‹ รุ่นก่อนหน้า
          </button>
          <span className="page-sub" style={{ margin: 0 }}>
            {index + 1} / {selectedModels.length}
          </span>
          <button
            className="btn secondary small"
            disabled={index === selectedModels.length - 1}
            onClick={() => setIndex((i) => Math.min(selectedModels.length - 1, i + 1))}
          >
            รุ่นถัดไป ›
          </button>
        </div>
      )}

      {models.loading ? (
        <div className="page-loading">กำลังโหลด...</div>
      ) : selectedModels.length === 0 ? (
        <div className="empty-state">ไม่มีรุ่นรถที่เลือกไว้สำหรับพิมพ์</div>
      ) : (
        selectedModels.map((m, i) => (
          <div className="card bulk-print-sheet" key={m.id} style={{ display: i === index ? 'block' : 'none' }}>
            <div className="bulk-print-head">
              <div className="blank-form-brand">{shop?.name || 'POWER GROUP'}</div>
              {shop?.sub && <div className="page-sub">{shop.sub}</div>}
            </div>
            <h2>
              Preview • {m.brand} {m.name}
            </h2>
            <div className="table-wrap">
              <table className="parts-table">
                <thead>
                  <tr>
                    <th>รายการอะไหล่</th>
                    <th>หมวดหมู่</th>
                    <th>แบรนด์</th>
                    <th>ราคา</th>
                  </tr>
                </thead>
                <tbody>
                  {m.parts.length === 0 && (
                    <tr>
                      <td colSpan={4} className="center">
                        ยังไม่มีอะไหล่ในรุ่นนี้
                      </td>
                    </tr>
                  )}
                  {m.parts.map((p) =>
                    (p.brands && p.brands.length > 0 ? p.brands : [{ id: 'none', name: '-', price: undefined }]).map((b) => (
                      <tr key={`${p.id}-${b.id}`}>
                        <td>{p.partName}</td>
                        <td>{p.category || '-'}</td>
                        <td>{b.name}</td>
                        <td>{b.price ? `฿${fmtMoney(b.price)}` : '-'}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
