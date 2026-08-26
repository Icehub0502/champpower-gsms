import { Icon } from '../../components/ui/Icon';

// TODO: replace mock data with a real Firestore query once technicians grow a
// dedicated collection/document shape (today `config.technicians` only stores
// {id, name}, no role/specialty/status — that's what this mock adds).
interface MockTechnician {
  id: string;
  name: string;
  role: string;
  specialties: string[];
  status: 'busy' | 'free' | 'off';
  activeJobs: number;
}

const MOCK_TECHNICIANS: MockTechnician[] = [
  { id: 't1', name: 'ท็อป', role: 'หัวหน้าช่าง', specialties: ['ช่วงล่าง', 'แร็คพวงมาลัย'], status: 'busy', activeJobs: 2 },
  { id: 't2', name: 'เอิน', role: 'ช่างซ่อม', specialties: ['ช่วงล่าง', 'เพลาขับ'], status: 'busy', activeJobs: 1 },
  { id: 't3', name: 'นัท', role: 'ช่างซ่อม', specialties: ['EPS', 'แร็คไฟฟ้า'], status: 'free', activeJobs: 0 },
  { id: 't4', name: 'กอล์ฟ', role: 'ช่างซ่อม', specialties: ['ตั้งศูนย์', 'ช่วงล่าง'], status: 'off', activeJobs: 0 },
];

const STATUS_LABEL: Record<MockTechnician['status'], { text: string; cls: string }> = {
  busy: { text: 'กำลังทำงาน', cls: 'pill-danger' },
  free: { text: 'ว่าง', cls: 'pill-success' },
  off: { text: 'พักงาน', cls: 'pill-warning' },
};

export function TechniciansPage() {
  return (
    <div className="page">
      <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ marginBottom: 0 }}>ทีมช่าง</h1>
        <button type="button" className="btn">
          <Icon name="plus" size={14} /> เพิ่มช่าง
        </button>
      </div>
      <p className="page-sub">รายชื่อช่างในทีม ความเชี่ยวชาญ และงานที่กำลังรับผิดชอบ</p>

      <div className="tech-grid">
        {MOCK_TECHNICIANS.map((t) => {
          const st = STATUS_LABEL[t.status];
          return (
            <div className="tech-card" key={t.id}>
              <div className="tech-card-head">
                <div className="avatar-circle" aria-hidden="true">{t.name.charAt(0)}</div>
                <div className="tech-card-head-meta">
                  <div className="name">{t.name}</div>
                  <div className="role">{t.role}</div>
                </div>
              </div>
              <div className="tech-tags">
                {t.specialties.map((s) => (
                  <span className="chip active" key={s}>{s}</span>
                ))}
              </div>
              <span className={`pill ${st.cls}`}>
                {st.text}{t.status === 'busy' ? ` ${t.activeJobs} คัน` : ''}
              </span>
              <button type="button" className="btn secondary small" style={{ alignSelf: 'flex-start' }}>
                ดูงานที่รับผิดชอบ
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
