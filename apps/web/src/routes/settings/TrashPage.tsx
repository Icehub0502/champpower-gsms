// TODO: replace mock data with a real Firestore query once soft-delete (a
// `deletedAt`/`deletedBy` field, already present on Job per JobListPage.tsx's
// `deletedAt` filter) is surfaced for every deletable collection, not just jobs.
interface MockTrashItem {
  id: string;
  type: 'ใบงาน' | 'ลูกค้า' | 'สินค้า' | 'ใบเสนอราคา' | 'รถ';
  label: string;
  deletedBy: string;
  deletedAt: string;
}

const MOCK_TRASH: MockTrashItem[] = [
  { id: 'd1', type: 'ใบงาน', label: 'SV-02681 – Toyota Camry', deletedBy: 'แพท', deletedAt: '25 ส.ค. 09:12' },
  { id: 'd2', type: 'ลูกค้า', label: 'คุณวรพล แสงทอง', deletedBy: 'แอดมิน เดโม', deletedAt: '24 ส.ค. 17:40' },
  { id: 'd3', type: 'สินค้า', label: 'RK-TO-118', deletedBy: 'พี่ดา', deletedAt: '23 ส.ค. 11:02' },
  { id: 'd4', type: 'ใบเสนอราคา', label: 'QT-9412', deletedBy: 'แพท', deletedAt: '22 ส.ค. 14:55' },
  { id: 'd5', type: 'รถ', label: 'กข 4589 กรุงเทพฯ', deletedBy: 'แอดมิน เดโม', deletedAt: '20 ส.ค. 08:30' },
];

export function TrashPage() {
  return (
    <div className="page">
      <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ marginBottom: 0 }}>ประวัติการลบข้อมูล</h1>
        <div className="row-flex" style={{ gap: 8 }}>
          <span className="pill pill-gold">เก็บ 30 วัน</span>
          <button type="button" className="btn secondary small">
            ล้างถังขยะ
          </button>
        </div>
      </div>
      <p className="page-sub">รายการที่ถูกลบจะถูกเก็บไว้ 30 วันก่อนลบถาวรอัตโนมัติ</p>

      <input className="search-input" placeholder="ค้นหา เลขใบงาน / ลูกค้า / สินค้า / ผู้ใช้งาน" style={{ marginBottom: 14 }} />

      <div className="list-card">
        {MOCK_TRASH.map((item) => (
          <div className="list-row" key={item.id}>
            <span className="pill pill-muted">{item.type}</span>
            <div className="list-row-main">
              <div className="list-row-title">{item.label}</div>
              <div className="list-row-sub">ลบโดย {item.deletedBy} • {item.deletedAt}</div>
            </div>
            <div className="list-row-actions">
              <button type="button" className="btn secondary small">กู้คืน</button>
              <button type="button" className="btn danger small">ลบถาวร</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
