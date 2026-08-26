import { Icon } from '../../components/ui/Icon';

// TODO: replace mock data with a real Firestore query against `users` (already
// listed in firebase/firestore.rules) once an admin user-management UI ships.
interface MockUser {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
}

const MOCK_USERS: MockUser[] = [
  { id: 'u1', name: 'แอดมิน เดโม', email: 'admin@champpower.dev', role: 'ผู้ดูแลระบบ', active: true },
  { id: 'u2', name: 'แพท', email: 'service01@champpower.dev', role: 'รับรถ / ฝ่ายขาย', active: true },
  { id: 'u3', name: 'ท็อป', email: 'tech01@champpower.dev', role: 'ช่าง', active: true },
  { id: 'u4', name: 'เอิน', email: 'tech02@champpower.dev', role: 'ช่าง', active: true },
  { id: 'u5', name: 'พี่ดา', email: 'finance@champpower.dev', role: 'การเงิน', active: true },
  { id: 'u6', name: 'technician04', email: 'tech04@champpower.dev', role: 'ช่าง', active: false },
];

export function UsersPage() {
  const activeCount = MOCK_USERS.filter((u) => u.active).length;

  return (
    <div className="page">
      <div className="row-flex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>ผู้ใช้งาน</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            {MOCK_USERS.length} บัญชี • {activeCount} ใช้งาน • {MOCK_USERS.length - activeCount} ปิดใช้งาน
          </p>
        </div>
        <button type="button" className="btn">
          <Icon name="plus" size={14} /> เพิ่มผู้ใช้งาน
        </button>
      </div>

      <div className="list-card" style={{ marginTop: 16 }}>
        {MOCK_USERS.map((u) => (
          <div className="list-row" key={u.id}>
            <div className="avatar-circle" aria-hidden="true">{u.name.charAt(0)}</div>
            <div className="list-row-main">
              <div className="list-row-title">{u.name}</div>
              <div className="list-row-sub">{u.email}</div>
            </div>
            <span className="pill pill-info">{u.role}</span>
            <span className={`pill ${u.active ? 'pill-success' : 'pill-muted'}`}>
              {u.active ? 'ใช้งาน' : 'ปิดใช้งาน'}
            </span>
            <div className="list-row-actions">
              <button type="button" className="btn secondary small">
                แก้ไข
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
