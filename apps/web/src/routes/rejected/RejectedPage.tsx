// TODO: replace mock data with a real Firestore query once "customer declined
// this line item" is tracked per part (today `PartNeeded` has no reject/reason
// field — only the whole job can move to the `rejected` status).
interface MockRejectedItem {
  id: string;
  jobNumber: string;
  vehicle: string;
  item: string;
  price: number;
  reason: string;
  timestamp: string;
}

const MOCK_REJECTED: MockRejectedItem[] = [
  {
    id: 'r1',
    jobNumber: 'SV-02681',
    vehicle: 'Toyota Camry',
    item: 'แร็คพวงมาลัย',
    price: 6500,
    reason: 'ขอพิจารณาก่อน',
    timestamp: '25 ส.ค. 10:15',
  },
  {
    id: 'r2',
    jobNumber: 'SV-02658',
    vehicle: 'BMW E90',
    item: 'ปีกนกหน้า',
    price: 9800,
    reason: 'ราคาสูงกว่างบ',
    timestamp: '24 ส.ค. 16:40',
  },
  {
    id: 'r3',
    jobNumber: 'SV-02631',
    vehicle: 'Honda Accord',
    item: 'โช้คอัพหน้า',
    price: 8400,
    reason: 'ขอเลื่อนไปเดือนหน้า',
    timestamp: '23 ส.ค. 09:05',
  },
];

export function RejectedPage() {
  return (
    <div className="page">
      <h1>รายการไม่อนุมัติ</h1>
      <p className="page-sub">รายการซ่อม/อะไหล่ที่ลูกค้ายังไม่อนุมัติ — รอติดตามกลับ</p>

      <h2 className="section-title">รอติดตาม</h2>
      <div className="list-card">
        {MOCK_REJECTED.map((r) => (
          <div className="list-row" key={r.id} style={{ borderLeft: '4px solid var(--gold)', paddingLeft: 12 }}>
            <div className="list-row-main">
              <div className="list-row-title">
                {r.jobNumber} · {r.vehicle} · {r.item} — ฿{r.price.toLocaleString('th-TH')}
              </div>
              <div className="list-row-note">เหตุผล: {r.reason}</div>
              <div className="list-row-sub">{r.timestamp}</div>
            </div>
            <div className="list-row-actions">
              <button type="button" className="btn secondary small">ติดตามลูกค้า</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
