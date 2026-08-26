// TODO: replace mock data with a real Firestore query once warranty tracking
// aggregates across jobs — today `warrantyStatus(job)` (see domain package)
// only computes a single job's own warranty window, there's no cross-job
// "expiring soon" list yet.
interface MockWarrantyItem {
  id: string;
  jobNumber: string;
  vehicle: string;
  plate: string;
  item: string;
  daysLeft: number;
}

const MOCK_WARRANTY: MockWarrantyItem[] = [
  { id: 'w1', jobNumber: 'SV-02481', vehicle: 'BMW F30', plate: '8กข 4421', item: 'แร็คพวงมาลัย', daysLeft: 3 },
  { id: 'w2', jobNumber: 'SV-02472', vehicle: 'Toyota Camry', plate: '1กณ 6895', item: 'ปีกนกล่าง', daysLeft: 6 },
  { id: 'w3', jobNumber: 'SV-02391', vehicle: 'Honda CR-V', plate: 'กน 9211', item: 'ลูกหมากคันชัก', daysLeft: 12 },
  { id: 'w4', jobNumber: 'SV-02348', vehicle: 'Benz W205', plate: '9กพ 3210', item: 'ช่วงล่างหน้า', daysLeft: 18 },
];

function pillClass(daysLeft: number) {
  if (daysLeft < 7) return 'pill-danger';
  if (daysLeft < 30) return 'pill-warning';
  return 'pill-info';
}

export function WarrantyPage() {
  const within7 = MOCK_WARRANTY.filter((w) => w.daysLeft <= 7).length;
  const within30 = MOCK_WARRANTY.filter((w) => w.daysLeft <= 30).length;
  const within60 = MOCK_WARRANTY.length;

  return (
    <div className="page">
      <h1>ประกันใกล้หมดอายุ</h1>
      <p className="page-sub">งานที่อยู่ในช่วงประกัน ใกล้ถึงวันหมดอายุ — ใช้ติดตามลูกค้าให้กลับมาเช็ก</p>

      <div className="kpi-grid">
        <div className="kpi-card kpi-red">
          <div className="kpi-card-value">{within7} งาน</div>
          <div className="kpi-card-label">ภายใน 7 วัน</div>
        </div>
        <div className="kpi-card kpi-orange">
          <div className="kpi-card-value">{within30} งาน</div>
          <div className="kpi-card-label">ภายใน 30 วัน</div>
        </div>
        <div className="kpi-card kpi-blue">
          <div className="kpi-card-value">{within60} งาน</div>
          <div className="kpi-card-label">ภายใน 60 วัน</div>
        </div>
      </div>

      <div className="list-card">
        {MOCK_WARRANTY.map((w) => (
          <div className="list-row" key={w.id}>
            <div className="list-row-main">
              <div className="list-row-title">{w.jobNumber} · {w.vehicle}</div>
              <div className="list-row-sub">{w.plate} · {w.item}</div>
            </div>
            <span className={`pill ${pillClass(w.daysLeft)}`}>เหลือ {w.daysLeft} วัน</span>
            <div className="list-row-actions">
              <button type="button" className="btn secondary small">ติดต่อลูกค้า</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
